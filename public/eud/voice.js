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
  function open() {
    $('voiceWin').classList.remove('hidden');
    if (!v) {
      v = new TakVoice({
        callsign: E.profile.callsign || E.profile.uid, uid: E.profile.uid,
        onState: setState, onRoster: roster, onFloor: floor,
        onBusy: t => E.toast(`${t} is talking – wait until the channel is free.`),
        onError: msg => E.toast(msg, 6000),
      });
      v.connect();
    }
  }
  function close() { $('voiceWin').classList.add('hidden'); }
  function off() { if (v) v.close(); v = null; setState('off', 'off'); close(); }

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
})();
