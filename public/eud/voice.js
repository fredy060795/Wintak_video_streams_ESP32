// Push-to-talk voice (server: lib/voice.js). Microphone -> 8 kHz G.711 µ-law frames (60 ms) over /ws/voice while PTT is
// held; frames from others are played with a small jitter buffer. Roger beep at the end of each transmission, busy tone
// when somebody else talks. Used by the TAKweb app (panel "VoIP", below) and the HQ pages (window.TakVoice).
'use strict';

(() => {
  const RATE = 8000, FRAME = 480; // 60 ms

  // G.711 µ-law
  function mulawEncode(s) {
    const BIAS = 0x84, CLIP = 32635;
    let x = Math.max(-1, Math.min(1, s)) * 32767;
    const sign = x < 0 ? 0x80 : 0;
    if (sign) x = -x;
    if (x > CLIP) x = CLIP;
    x += BIAS;
    let exp = 7;
    for (let mask = 0x4000; (x & mask) === 0 && exp > 0; exp--, mask >>= 1) { /* find segment */ }
    const mant = (x >> (exp + 3)) & 0x0f;
    return ~(sign | (exp << 4) | mant) & 0xff;
  }
  const DECODE = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff, sign = u & 0x80, exp = (u >> 4) & 7, mant = u & 0x0f;
    const x = (((mant << 3) + 0x84) << exp) - 0x84;
    DECODE[i] = (sign ? -x : x) / 32768;
  }

  class TakVoice {
    // opts: { url, callsign, uid, onState(state), onRoster({channel, users, talker, channels}), onFloor({talker, me}), onBusy(talker), onError(msg) }
    constructor(opts = {}) {
      this.o = opts;
      this.channel = opts.channel || 'All';
      this.ws = null;
      this.ctx = null;
      this.mic = null;
      this.talking = false;
      this.want = false;     // PTT held (waiting for the floor)
      this.playAt = 0;
      this.closed = false;
      this.retry = 0;
      this.volume = 1;
    }

    url() { return this.o.url || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/voice'; }
    state(s, msg) { this.o.onState && this.o.onState(s, msg); }

    connect() {
      this.closed = false;
      if (this.ws && this.ws.readyState <= 1) return;
      this.state('connecting');
      const ws = new WebSocket(this.url());
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => { this.retry = 0; this.state('connected'); this.join(this.channel); };
      ws.onmessage = e => {
        if (typeof e.data !== 'string') return this.play(new Uint8Array(e.data));
        let m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.type === 'roster') { this.o.onRoster && this.o.onRoster(m); }
        else if (m.type === 'floor') {
          if (!m.talker && this.other) this.beep(1300, 0.08); // the other one finished
          this.other = !!m.talker && !m.me;
          this.talking = !!m.me;
          if (m.me) this.beep(1000, 0.05);
          this.o.onFloor && this.o.onFloor(m);
        } else if (m.type === 'busy') { this.want = false; this.beep(420, 0.25); this.o.onBusy && this.o.onBusy(m.talker); }
      };
      ws.onclose = e => {
        this.talking = false;
        if (this.closed) return this.state('off');
        if (e.code === 1006 && this.retry === 0) this.state('error', 'Voice needs a connection to the TAK server (or the admin login).');
        const delay = Math.min(30000, 1000 * 2 ** this.retry++);
        this.state('connecting', `reconnecting in ${Math.round(delay / 1000)} s`);
        setTimeout(() => { if (!this.closed) this.connect(); }, delay);
      };
    }

    close() { this.closed = true; this.pttUp(); if (this.ws) this.ws.close(); this.ws = null; }

    join(channel) {
      this.channel = channel || 'All';
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'join', channel: this.channel, callsign: this.o.callsign || '', uid: this.o.uid || '' }));
    }

    audioCtx() {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    // called from a tap/press (browsers allow microphone and sound only after a user action)
    async pttDown() {
      if (this.want) return;
      this.want = true;
      try { await this.startMic(); } catch (e) { this.want = false; this.o.onError && this.o.onError('Microphone not allowed – allow it in the browser/app settings.'); return; }
      if (!this.want) return;
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'ptt', on: true }));
    }

    pttUp() {
      const was = this.want || this.talking;
      this.want = false;
      if (was && this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'ptt', on: false }));
      if (this.talking) this.beep(800, 0.07); // roger
      this.talking = false;
    }

    async startMic() {
      const ctx = this.audioCtx();
      if (this.mic) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      const ratio = ctx.sampleRate / RATE;
      let pos = 0, carry = new Float32Array(0);
      const out = new Uint8Array(FRAME);
      let n = 0;
      proc.onaudioprocess = e => {
        if (!this.talking || !this.ws || this.ws.readyState !== 1) { pos = 0; n = 0; return; }
        const inp = e.inputBuffer.getChannelData(0);
        const buf = new Float32Array(carry.length + inp.length);
        buf.set(carry); buf.set(inp, carry.length);
        // average over each output sample's span (simple low pass + down-sampling)
        while (pos + ratio <= buf.length) {
          let sum = 0;
          const a = Math.floor(pos), b = Math.floor(pos + ratio);
          for (let i = a; i < b; i++) sum += buf[i];
          out[n++] = mulawEncode(sum / Math.max(1, b - a));
          pos += ratio;
          if (n === FRAME) { this.ws.send(out.slice()); n = 0; }
        }
        const keep = Math.floor(pos);
        carry = buf.slice(keep);
        pos -= keep;
      };
      src.connect(proc);
      proc.connect(ctx.destination); // needed for the processor to run (outputs silence)
      this.mic = { stream, src, proc };
    }

    play(frame) {
      const ctx = this.audioCtx();
      const k = ctx.sampleRate / RATE;
      const len = Math.floor(frame.length * k);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const x = i / k, a = Math.floor(x), f = x - a;
        const s0 = DECODE[frame[a]], s1 = DECODE[frame[Math.min(frame.length - 1, a + 1)]];
        d[i] = (s0 + (s1 - s0) * f) * this.volume;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const now = ctx.currentTime;
      if (this.playAt < now + 0.03) this.playAt = now + 0.15; // (re)start with ~150 ms buffer against jitter
      if (this.playAt > now + 1) this.playAt = now + 0.15;    // too far behind: catch up
      src.start(this.playAt);
      this.playAt += buf.duration;
      this.o.onAudio && this.o.onAudio();
    }

    beep(freq, dur) {
      try {
        const ctx = this.audioCtx();
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = freq;
        g.gain.value = 0.12;
        o.connect(g); g.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + dur);
      } catch (e) { /* no sound */ }
    }
  }
  // voice message: microphone -> 8 kHz 16-bit mono WAV (max. maxMs), for the chat
  class VoiceRecorder {
    async start(maxMs = 30000, onTick = () => {}) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const proc = this.ctx.createScriptProcessor(2048, 1, 1);
      const ratio = this.ctx.sampleRate / RATE;
      this.samples = [];
      let pos = 0, carry = new Float32Array(0);
      proc.onaudioprocess = e => {
        const inp = e.inputBuffer.getChannelData(0);
        const buf = new Float32Array(carry.length + inp.length);
        buf.set(carry); buf.set(inp, carry.length);
        while (pos + ratio <= buf.length) {
          let sum = 0;
          const a = Math.floor(pos), b = Math.floor(pos + ratio);
          for (let i = a; i < b; i++) sum += buf[i];
          this.samples.push(Math.max(-1, Math.min(1, sum / Math.max(1, b - a))));
          pos += ratio;
        }
        const keep = Math.floor(pos);
        carry = buf.slice(keep);
        pos -= keep;
      };
      src.connect(proc);
      proc.connect(this.ctx.destination);
      this.proc = proc;
      this.t0 = Date.now();
      this.tick = setInterval(() => { const ms = Date.now() - this.t0; onTick(ms); if (ms >= maxMs) this.onLimit && this.onLimit(); }, 250);
    }
    stop() {
      clearInterval(this.tick);
      if (this.proc) this.proc.disconnect();
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      if (this.ctx) this.ctx.close().catch(() => {});
      const pcm = Int16Array.from(this.samples || [], x => Math.round(x * 32767));
      this.samples = [];
      return { pcm, ms: Math.round(pcm.length / RATE * 1000) };
    }
  }
  function wav(pcm) {
    const b = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(b);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
    v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    new Int16Array(b, 44).set(pcm);
    return new Blob([b], { type: 'audio/wav' });
  }
  TakVoice.Recorder = VoiceRecorder;
  TakVoice.wav = wav;

  window.TakVoice = TakVoice;
  window.TakVoice.codec = { mulawEncode, DECODE };

  // ---------------- TAKweb app: panel "VoIP" ----------------
  const $ = id => document.getElementById(id);
  if (!$('voiceWin') || !window.eud) return;
  const E = window.eud;
  let v = null;
  const ch = () => $('vcChannel');

  function setState(s, msg) {
    $('vcState').textContent = s === 'connected' ? 'connected' : s === 'connecting' ? 'connecting …' + (msg ? ' ' + msg : '') : msg || s;
    $('vcState').className = 'vc-state ' + s;
    $('btnVoiceTile') && $('btnVoiceTile').classList.toggle('active', s === 'connected');
  }
  function roster(m) {
    const cur = ch().value;
    const list = [...new Set(['All', E.profile.team || ''].concat(m.channels || []).filter(Boolean))];
    if ([...ch().options].map(o => o.value).join() !== list.join()) {
      ch().replaceChildren(...list.map(c => { const o = document.createElement('option'); o.value = c; o.textContent = c === 'All' ? 'All' : 'Team ' + c; return o; }));
    }
    ch().value = list.includes(cur) ? cur : m.channel;
    $('vcUsers').textContent = m.users.map(u => u.callsign + (u.hq ? ' (HQ)' : '')).join(', ') || '–';
    floor({ talker: m.talker });
  }
  function floor(m) {
    const me = m.me;
    $('vcPtt').classList.toggle('tx', !!me);
    $('vcPtt').classList.toggle('rx', !!m.talker && !me);
    $('vcTalker').textContent = me ? 'You are talking …' : m.talker ? `🔊 ${m.talker}` : 'Channel free';
  }
  // on the radio net from the start (you hear the others even with the panel closed); ⏻ leaves it until switched on again
  const OFF_KEY = 'eud.voiceOff';
  const isOff = () => { try { return localStorage.getItem(OFF_KEY) === '1'; } catch (e) { return false; } };
  function ensure() {
    if (v) return v;
    v = new TakVoice({
      callsign: E.profile.callsign || E.profile.uid, uid: E.profile.uid,
      onState: setState, onRoster: roster,
      onFloor: m => { floor(m); if (m.talker && !m.me && $('voiceWin').classList.contains('hidden')) E.toast('🔊 ' + m.talker + ' (VoIP)', 3000); },
      onBusy: t => E.toast(`${t} is talking – wait until the channel is free.`),
      onError: msg => E.toast(msg, 6000),
    });
    v.connect();
    return v;
  }
  function open() {
    $('voiceWin').classList.remove('hidden');
    try { localStorage.removeItem(OFF_KEY); } catch (e) { /* private mode */ }
    ensure();
  }
  function close() { $('voiceWin').classList.add('hidden'); }
  function off() {
    if (v) v.close();
    v = null;
    try { localStorage.setItem(OFF_KEY, '1'); } catch (e) { /* private mode */ }
    setState('off', 'off');
    close();
  }
  setInterval(() => { if (!v && !isOff() && E.serverOnline()) ensure(); }, 3000);

  // ---------------- permissions at the start: microphone (bar in the header, eud.js) and sound ----------------
  // browsers play sound only after a tap: the first tap anywhere unlocks it, so incoming VoIP is heard right away
  let micState = 'unknown', micAsked = false;
  const unlock = () => { if (!isOff()) ensure().audioCtx(); };
  document.addEventListener('pointerdown', unlock, { once: true, capture: true });
  (async () => {
    try {
      const p = await navigator.permissions.query({ name: 'microphone' });
      micState = p.state;
      p.onchange = () => { micState = p.state; E.updatePermBar(); };
    } catch (e) { /* no permissions API: asked once with ALLOW */ }
    E.updatePermBar();
  })();
  // called from the ALLOW tap in the header bar (within the tap, as browsers require)
  async function allow() {
    micAsked = true;
    unlock();
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: true });
      st.getTracks().forEach(t => t.stop());
      micState = 'granted';
    } catch (e) { micState = 'denied'; }
    E.updatePermBar();
    return micState === 'granted';
  }
  window.eudVoice = {
    allow,
    // the bar asks for the microphone until it is allowed (without the permissions API: once per start)
    needMic: () => micState === 'denied' || (micState !== 'granted' && !micAsked),
    micDenied: () => micState === 'denied',
  };

  const tile = document.querySelector('.tile[data-tb="voice"]');
  if (tile) tile.addEventListener('click', () => { E.closeSheets(); if ($('voiceWin').classList.contains('hidden')) open(); else close(); });
  $('vcClose').addEventListener('click', close);
  $('vcOff').addEventListener('click', off);
  ch().addEventListener('change', () => v && v.join(ch().value));
  const btn = $('vcPtt');
  const down = e => { e.preventDefault(); btn.setPointerCapture && e.pointerId != null && btn.setPointerCapture(e.pointerId); v && v.pttDown(); };
  const up = e => { e.preventDefault(); v && v.pttUp(); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', e => e.preventDefault());
  // desktop: hold the space bar (not while typing)
  document.addEventListener('keydown', e => { if (e.code === 'Space' && v && !e.repeat && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('voiceWin').classList.contains('hidden')) { e.preventDefault(); v.pttDown(); } });
  document.addEventListener('keyup', e => { if (e.code === 'Space' && v && !$('voiceWin').classList.contains('hidden')) v.pttUp(); });
  $('vcVol').addEventListener('input', () => { if (v) v.volume = Number($('vcVol').value); });

  // ---------------- voice messages in the chat ----------------
  // with internet: the recording goes to the TAKweb server, the chat message carries the link (ATAK opens it too).
  // With Meshtastic sending: additionally as Codec 2 (1300 bit/s) over LoRa (mesh.js) – the same message id, so who gets
  // both sees it once. Without internet only over LoRa, max. 15 s (airtime).
  const MSG_MS = 30000, MESH_MS = 15000, MODE = 1300;
  const MIC_SVG = $('chatMic').innerHTML;
  const P = window.meshProto;
  let rec = null;
  const fmtMs = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  // Codec 2 bits of messages from/over the mesh, kept with the chat (3 days)
  const BITS_KEY = 'eud.voiceBits';
  const b64 = u => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
  const unb64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
  const loadBits = () => { try { return JSON.parse(localStorage.getItem(BITS_KEY) || '{}'); } catch (e) { return {}; } };
  function keepBits(uid, bits, mode, ms) {
    const all = loadBits();
    all[uid] = { b: b64(bits), mode, ms, t: Date.now() };
    for (const [k, v] of Object.entries(all)) if (Date.now() - v.t > 3 * 86400000) delete all[k];
    try { localStorage.setItem(BITS_KEY, JSON.stringify(all)); } catch (e) { /* full: the message stays without sound */ }
  }
  const meshConv = conv => conv && (conv.key === 'all' || conv.key.startsWith('dm:')); // like text: no team/group rooms over LoRa
  // online: LoRa copy only as the Meshtastic send setting says; offline: whenever a radio is connected
  const meshOn = online => !!(window.eudMesh && (online ? window.eudMesh.canSend() : window.eudMesh.connected()));
  // the radio is (re)connecting right now: wait a few seconds for it
  async function meshReady(ms = 6000) {
    for (let t = 0; t < ms; t += 500) {
      if (meshOn(false)) return true;
      if (!window.eudMesh || !/connecting|reconnect/.test(window.eudMesh.state())) return false;
      await new Promise(r => setTimeout(r, 500));
    }
    return meshOn(false);
  }

  function recUi(on) {
    $('chatMic').classList.toggle('rec', on);
    $('recBar').classList.toggle('hidden', !on);
    $('chatForm').classList.toggle('recording', on);
    $('chatMic').innerHTML = on ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M3 20l18-8L3 4v6l12 2-12 2z"/></svg>' : MIC_SVG;
    $('chatMic').title = on ? 'Send the voice message' : 'Voice message (tap to record, tap again to send)';
  }
  async function recStart() {
    const online = E.serverOnline();
    const mesh = online ? meshOn(true) : await meshReady();
    if (!online && !mesh) {
      const st = window.eudMesh ? window.eudMesh.state() : 'off';
      const why = { tap: 'tap RECONNECT in Menu → Meshtastic', lost: 'connection lost – reconnect it in Menu → Meshtastic', paused: 'paused while a video streams' }[st] || 'connect it in Menu → Meshtastic';
      return E.toast(`No connection to the TAK server, and the Meshtastic radio is not connected (${why}) – a voice message then goes over LoRa.`, 7000);
    }
    const max = online ? MSG_MS : MESH_MS;
    rec = new VoiceRecorder();
    rec.onLimit = () => recSend();
    try { await rec.start(max, ms => { $('recTime').textContent = `${fmtMs(ms)} / ${fmtMs(max)}${online ? '' : ' (mesh)'}`; }); } catch (e) { rec = null; return E.toast('Microphone not allowed – allow it in the browser/app settings.', 6000); }
    recUi(true);
  }
  async function recSend() {
    if (!rec) return;
    const r = rec; rec = null;
    recUi(false);
    const { pcm, ms } = r.stop();
    if (ms < 700) return E.toast('Too short – tap the microphone, speak, tap send.');
    const online = E.serverOnline(), mesh = meshOn(online);
    try {
      let sent = null;
      if (online) {
        const res = await fetch('/api/eud/voicemsg', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav(pcm) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'Upload failed (' + res.status + ')');
        sent = E.sendChat(`🎤 Voice message ${fmtMs(ms)} ${d.url}`, { mesh: false });
      } else {
        sent = E.sendChat(`🎤 Voice message ${fmtMs(ms)} (mesh)`, { mesh: false, server: false });
      }
      if (!sent || !mesh || !window.Codec2) return;
      if (!meshConv(sent.conv)) { if (!online) E.toast('Team and group chats do not go over LoRa – use All or a direct message.', 5000); return; }
      const part = pcm.subarray(0, Math.min(pcm.length, MESH_MS * 8)); // LoRa: at most 15 s
      const bits = await window.Codec2.encode(part, MODE);
      keepBits(sent.uid, bits, MODE, Math.min(ms, MESH_MS));
      E.toast(`Voice message over LoRa: ${Math.ceil(bits.length / P.VOICE_CHUNK) + 1} packets (~${Math.round((Math.ceil(bits.length / P.VOICE_CHUNK) + 1) * 1.6)} s)`, 4000);
      window.eudMesh.sendVoice({ id: sent.msgId, to: sent.conv.key.startsWith('dm:') ? (sent.conv.uid || sent.conv.key.slice(3)) : '', bits, ms: Math.min(ms, MESH_MS) });
    } catch (e) { E.toast('Voice message not sent: ' + e.message, 6000); }
  }
  $('chatMic').addEventListener('click', () => (rec ? recSend() : recStart()));
  $('recCancel').addEventListener('click', () => { if (rec) { rec.stop(); rec = null; } recUi(false); });

  // a voice message that came over LoRa (mesh.js): into the chat like a GeoChat, with the sound kept here
  document.addEventListener('eud-voice-in', e => {
    const m = e.detail;
    const xml = P.chatCot({ senderUid: m.from, senderCallsign: m.callsign, msgId: m.id, text: `🎤 Voice message ${fmtMs(m.ms)} (mesh)`, toUid: m.to });
    const uid = (/uid="([^"]+)"/.exec(xml) || [])[1];
    keepBits(uid, m.bits, m.mode, m.ms);
    E.handleCot(xml);
  });
  // player in the chat (eud.js renderChat): decodes on the first tap
  window.eudVoicePlayer = id => {
    const v = loadBits()[id];
    if (!v) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-play';
    btn.textContent = `▶ ${fmtMs(v.ms)}  (LoRa)`;
    btn.addEventListener('click', async () => {
      try {
        btn.disabled = true;
        const pcm = await window.Codec2.decode(unb64(v.b), v.mode);
        const a = document.createElement('audio');
        a.controls = true;
        a.className = 'cm-audio';
        a.src = URL.createObjectURL(wav(pcm));
        btn.replaceWith(a);
        a.play().catch(() => {});
      } catch (err) { btn.disabled = false; E.toast('Cannot play: ' + err.message); }
    });
    return btn;
  };
})();
