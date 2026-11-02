// Video stream from the EUD: tap phone camera or helmet camera (Bluetooth) -> the stream runs right away.
// Uses the same relay as /app/ (registration /api/app/register, images via /ws/publish).
'use strict';

(() => {
  const { $, store, profile, toast, setMsg, openPopup } = window.eud;
  // the camera's Bluetooth protocol: PROTOCOL.md in the ESP32-Flash repository
  const SVC = '7b3c0001-6b1a-4d6e-9c55-3a2f1e0c8a01';
  const COMMAND = '7b3c0003-6b1a-4d6e-9c55-3a2f1e0c8a01';
  const IMAGE = '7b3c0004-6b1a-4d6e-9c55-3a2f1e0c8a01';
  const RES_PX = { 1: 160, 5: 320, 8: 640, 11: 1280 };
  const RES_NAME = { 1: '160x120', 5: '320x240', 8: '640x480', 11: '1280x720' };
  const PHONE_FPS = 5;
  const enc = new TextEncoder();
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  let link = store.get('eud.video', null); // { u, s, k } from the server
  let ws = null, wsTimer = null, wsRetry = 0;
  let running = false;     // user wants to send
  let onAir = false;       // server lets images through
  let source = null;       // 'phone' | 'ble'
  let mediaStream = null, captureTimer = null, capturing = false;
  let device = null, cmdChr = null, frame = null, writeChain = Promise.resolve();
  let framesize = 1, rotate = 0, mirror = false, fit = 'fill';
  let sent = [], busy = false, lastPreview = 0, wakeLock = null;
  let streamUrl = '';
  let previewHidden = false;

  const msg = (text, ok) => setMsg($('vidMsg'), text, ok);

  function render() {
    const active = running && !!source;
    $('vidStart').classList.toggle('hidden', active);
    $('vidRun').classList.toggle('hidden', !active);
    $('livePreview').classList.toggle('hidden', !active);
    $('livePreview').classList.toggle('gone', active && previewHidden);
    $('lpShow').classList.toggle('hidden', !previewHidden);
    const live = active && onAir && ws && ws.readyState === 1;
    $('livePreview').classList.toggle('ready', active && !live);
    $('liveTag').textContent = live ? '● LIVE' : 'CONNECTING';
    $('vidBanner').className = 'nw-banner ' + (live ? 'ok' : 'wait');
    $('vidState').textContent = live ? 'LIVE – streaming' : (ws && ws.readyState === 1 ? 'Waiting for release …' : 'Connecting to server …');
    $('btnVideo').classList.toggle('live', live);
    $('bleBtn').disabled = !navigator.bluetooth;
    $('camPickRow').classList.toggle('hidden', source !== 'phone' || $('camSelect').options.length < 2);
    // own SA carries the video link while sending (ATAK shows it on the contact)
    const url = live && streamUrl ? streamUrl + '/stream.ts' : null;
    window.eudVideoSource = live ? source : null; // phone | ble | screen – for the field of view (eud.js)
    if (url !== window.eudVideoUrl) {
      window.eudVideoUrl = url;
      if (window.eudSendSelf) window.eudSendSelf();
    }
  }

  // ---------------- Registration + server ----------------

  async function ensureLink() {
    if (link) return link;
    let res;
    try {
      res = await fetch('/api/app/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: profile.callsign || 'EUD', unit: profile.team, source: 'eud' }),
      });
    } catch (e) {
      throw new Error(`TAKweb server not reachable for the video sign-up (${e.message}) – check the internet connection and try again.`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Sign-up at the server failed.');
    link = { u: data.u, s: data.s, k: data.k };
    store.set('eud.video', link);
    return link;
  }

  function connectServer() {
    clearTimeout(wsTimer);
    if (!running || !link) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws/publish?u=${encodeURIComponent(link.u)}&s=${encodeURIComponent(link.s)}&k=${encodeURIComponent(link.k)}`);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => { wsRetry = 0; };
    sock.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'welcome') {
        streamUrl = m.stream || '';
        sock.send(JSON.stringify({ type: 'hello', camera: $('vidCam').textContent, phone: navigator.userAgent, resolution: RES_NAME[framesize] }));
        sock.send(JSON.stringify({ type: 'state', ready: true }));
        sock.send(JSON.stringify({ type: 'golive', on: true })); // send right away
      } else if (m.type === 'live') {
        const was = onAir;
        onAir = m.mode === 'user' || !!m.on;
        if (was && !onAir && m.mode !== 'user') { msg('The admin ended the stream.'); toast('Video stream ended by admin.'); stop(); return; }
      } else if (m.type === 'config') {
        rotate = m.rotate || 0;
        mirror = !!m.mirror;
        fit = m.fit === 'fit' ? 'fit' : 'fill';
        const fs = RES_PX[m.framesize] ? m.framesize : 1;
        if (fs !== framesize) {
          framesize = fs;
          if (source === 'ble') camSend({ cmd: 'cam', framesize });
        }
      } else if (m.type === 'stats') {
        $('vidViewers').textContent = m.viewers;
      } else if (m.type === 'stopped') {
        msg('The admin stopped the stream.');
        toast('Video stream stopped by admin.');
        stop();
        return;
      } else if (m.type === 'removed' || m.type === 'invalid' || m.type === 'revoked') {
        // access no longer exists: register again on the next start
        link = null;
        store.del('eud.video');
        if (m.type === 'revoked') { msg('Access was revoked by the admin.'); stop(); return; }
        if (running) ensureLink().then(connectServer).catch(e => { msg(e.message); stop(); });
        return;
      } else if (m.type === 'replaced') {
        msg('Another device is now streaming on this stream.');
        stop();
        return;
      }
      render();
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      onAir = false;
      render();
      if (running) wsTimer = setTimeout(connectServer, Math.min(15000, 1000 * 2 ** wsRetry++));
    };
  }

  // ---------------- Images ----------------

  async function rotateJpeg(jpeg, deg, flip) {
    const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    const w = bmp.width, h = bmp.height;
    const quarter = Math.round(deg / 90) % 4;
    const W = quarter % 2 ? h : w, H = quarter % 2 ? w : h;
    const rad = deg * Math.PI / 180;
    const c = Math.abs(Math.cos(rad)), si = Math.abs(Math.sin(rad));
    const scale = fit === 'fit' ? Math.min(W / (w * c + h * si), H / (w * si + h * c)) : Math.max((W * c + H * si) / w, (W * si + H * c) / h);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.rotate(rad);
    ctx.scale(flip ? -scale : scale, scale);
    ctx.drawImage(bmp, -w / 2, -h / 2);
    bmp.close();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function onJpeg(raw) {
    let jpeg = raw;
    if (rotate || mirror) {
      if (busy) return;
      busy = true;
      try { jpeg = await rotateJpeg(raw, rotate, mirror); } catch (e) { return; } finally { busy = false; }
    }
    const now = performance.now();
    if (ws && ws.readyState === 1 && onAir && ws.bufferedAmount < 512 * 1024) {
      ws.send(jpeg);
      sent.push(now);
    }
    sent = sent.filter(t => now - t < 5000);
    $('vidFps').textContent = (sent.length / 5).toFixed(1);
    if (source === 'ble' && now - lastPreview > 200) {
      lastPreview = now;
      const img = $('camImg');
      const old = img.src;
      img.src = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
      if (old) URL.revokeObjectURL(old);
    }
  }

  // phone camera: grab the image from the video (the preview is the video itself – iPhone needs it visible)
  async function captureFrame() {
    const v = $('camVideo');
    if (capturing || !v.videoWidth) return;
    capturing = true;
    try {
      const scale = Math.min(1, (RES_PX[framesize] || 160) / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.75));
      if (blob) await onJpeg(new Uint8Array(await blob.arrayBuffer()));
    } finally {
      capturing = false;
    }
  }

  async function openPhoneCamera(deviceId) {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('The camera only works over HTTPS.');
    }
    const attempts = deviceId
      ? [{ video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }]
      : [
        { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: { facingMode: 'environment' }, audio: false },
        { video: true, audio: false },
      ];
    let last = null;
    for (const c of attempts) {
      try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) {
        last = e;
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break;
      }
    }
    if (last && (last.name === 'NotAllowedError' || last.name === 'SecurityError')) {
      throw new Error(isIOS ? 'Camera not allowed: Settings → Safari → Camera → Allow.' : 'Camera access denied – allow it in the site settings.');
    }
    if (last && last.name === 'NotReadableError') throw new Error('The camera is in use by another app.');
    throw new Error('Camera could not be started' + (last ? ` (${last.name})` : '') + '.');
  }

  async function attach(stream) {
    if (mediaStream && mediaStream !== stream) mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = stream;
    const v = $('camVideo');
    v.classList.remove('hidden');
    $('camImg').classList.add('hidden');
    v.srcObject = stream;
    await v.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    $('vidCam').textContent = (track && track.label) || 'Phone camera';
    await listCameras();
  }

  async function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const track = mediaStream && mediaStream.getVideoTracks()[0];
    const current = track ? track.getSettings().deviceId : '';
    const sel = $('camSelect');
    sel.replaceChildren(...cams.map((c, i) => new Option(c.label || 'Camera ' + (i + 1), c.deviceId)));
    if (current) sel.value = current;
    render();
  }

  $('camSelect').addEventListener('change', async () => {
    try {
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); // many phones allow only one camera
      await attach(await openPhoneCamera($('camSelect').value));
      try { localStorage.setItem('eud.camera', $('camSelect').value); } catch (e) { /* private mode */ }
    } catch (e) { msg(e.message); }
  });

  // helmet camera via Bluetooth
  function camSend(obj) {
    writeChain = writeChain.then(() => cmdChr && cmdChr.writeValueWithResponse(enc.encode(JSON.stringify(obj)))).catch(() => {});
    return writeChain;
  }

  function onImagePacket(ev) {
    const dv = ev.target.value;
    const type = dv.getUint8(0);
    if (type === 1) {
      frame = { buf: new Uint8Array(dv.getUint32(1, true)), got: 0 };
    } else if (type === 2 && frame) {
      const part = new Uint8Array(dv.buffer, dv.byteOffset + 5, dv.byteLength - 5);
      frame.buf.set(part, dv.getUint32(1, true));
      frame.got += part.length;
    } else if (type === 3 && frame) {
      if (frame.got === frame.buf.length) onJpeg(frame.buf);
      frame = null;
    }
  }

  // Android often drops a fresh BLE connection to the ESP32 right after gatt.connect() ("GATT Server is
  // disconnected. Cannot retrieve services") – connect again a few times, with a short pause before the
  // service discovery, until the service is there.
  async function gattService(dev, svcUuid, tries = 5) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const server = dev.gatt.connected ? dev.gatt : await dev.gatt.connect();
        await new Promise(r => setTimeout(r, 300 + i * 300));
        if (!dev.gatt.connected) throw new Error('GATT Server is disconnected.');
        return await server.getPrimaryService(svcUuid);
      } catch (e) {
        last = e;
        if (e.name === 'NotFoundError' && !/disconnected/i.test(e.message)) throw e; // service really missing
        try { if (dev.gatt.connected) dev.gatt.disconnect(); } catch (x) { /* ignore */ }
        await new Promise(r => setTimeout(r, 700 + i * 500));
      }
    }
    throw last;
  }

  let gattBusy = false; // a connect is running: the disconnect handler does not start a second one
  async function setupGatt() {
    gattBusy = true;
    let svc;
    try { svc = await gattService(device, SVC); } finally { gattBusy = false; }
    cmdChr = await svc.getCharacteristic(COMMAND);
    const img = await svc.getCharacteristic(IMAGE);
    img.addEventListener('characteristicvaluechanged', onImagePacket);
    await img.startNotifications();
    await camSend({ cmd: 'cam', framesize });
    await camSend({ cmd: 'stream', on: true, interval: 0 });
  }

  async function onBleLost() {
    if (!device || source !== 'ble' || gattBusy) return;
    toast('Helmet camera lost – reconnecting …');
    for (let i = 0; i < 30 && device && running; i++) {
      try { await setupGatt(); toast('Helmet camera reconnected.'); return; } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
    if (running) { msg('Helmet camera not reachable.'); stop(); }
  }

  // ---------------- Start / stop ----------------

  async function start(kind) {
    if (!profile.callsign) { openPopup('me'); toast('Please enter a callsign first.'); return; }
    // Meshtastic (mesh.js) releases the Bluetooth radio while a stream runs – before the device dialog
    document.dispatchEvent(new CustomEvent('eud-video', { detail: { on: true } }));
    msg('');
    previewHidden = false;
    $('phoneBtn').disabled = $('bleBtn').disabled = $('screenBtn').disabled = true;
    try {
      if (kind === 'screen') {
        // share the screen (desktop browsers only; phone browsers do not allow it)
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
        source = 'screen';
        await attach(stream);
        $('vidCam').textContent = 'Screen';
        const track = stream.getVideoTracks()[0];
        if (track) track.addEventListener('ended', () => { if (running) stop(); }); // "stop sharing" in the browser
        clearInterval(captureTimer);
        captureTimer = setInterval(captureFrame, 1000 / PHONE_FPS);
      } else if (kind === 'phone') {
        let saved = '';
        try { saved = localStorage.getItem('eud.camera') || ''; } catch (e) { /* private mode */ }
        let stream;
        try { stream = await openPhoneCamera(saved || undefined); } catch (e) { if (!saved) throw e; stream = await openPhoneCamera(); }
        source = 'phone';
        await attach(stream);
        clearInterval(captureTimer);
        captureTimer = setInterval(captureFrame, 1000 / PHONE_FPS);
      } else {
        if (!navigator.bluetooth) throw new Error(isIOS ? 'On iPhone, Bluetooth only works in the "Bluefy" app – use the phone camera.' : 'This browser has no Bluetooth (use Chrome).');
        device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }, { namePrefix: 'Helm' }], optionalServices: [SVC] });
        device.addEventListener('gattserverdisconnected', onBleLost);
        msg('Connecting to ' + (device.name || 'helmet camera') + ' …', true);
        source = 'ble';
        await setupGatt();
        $('vidCam').textContent = (device.name || 'Helmet camera') + ' (Bluetooth)';
        $('camVideo').classList.add('hidden');
        $('camImg').classList.remove('hidden');
      }
      running = true;
      await ensureLink();
      connectServer();
      try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed */ }
      msg('');
      render();
    } catch (e) {
      if (!(e.name === 'NotFoundError' && /cancel/i.test(e.message))) msg(e.message);
      stop(true);
    } finally {
      $('phoneBtn').disabled = $('screenBtn').disabled = false;
      render();
    }
  }

  function stop(quiet) {
    running = false;
    onAir = false;
    clearInterval(captureTimer);
    clearTimeout(wsTimer);
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
    $('camVideo').srcObject = null;
    if (source === 'ble' && cmdChr) camSend({ cmd: 'stream', on: false });
    const d = device;
    device = null;
    cmdChr = null;
    if (d && d.gatt.connected) d.gatt.disconnect();
    source = null;
    if (ws) {
      const s = ws;
      ws = null;
      try { if (s.readyState === 1) s.send(JSON.stringify({ type: 'golive', on: false })); } catch (e) { /* ignore */ }
      s.close();
    }
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    if (!quiet) toast('Video stream stopped.');
    render();
    document.dispatchEvent(new CustomEvent('eud-video', { detail: { on: false } })); // Meshtastic reconnects
  }

  // ---------------- Watching streams (own and others') ----------------

  // What the browser can play: MJPEG (our streams, as an image), HLS (.m3u8), MP4/WebM.
  // RTSP/RTMP/SRT/UDP do not work in a browser -> copy the address (e.g. for VLC).
  // Playback in the browser: own streams as MJPEG, HLS (also RTSP feeds from MediaMTX/OTS through their
  // HLS output) with hls.js through our own server, MP4/WebM directly. Otherwise a clear message + way out.
  let hls = null;
  let hlsLib = null;
  const mediaProxy = u => '/api/eud/media?u=' + encodeURIComponent(u);
  function loadHlsLib() {
    if (hlsLib) return hlsLib;
    hlsLib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/hls.min.js';
      s.onload = () => resolve(window.Hls);
      s.onerror = () => { hlsLib = null; reject(new Error('hls.js not available')); };
      document.head.append(s);
    });
    return hlsLib;
  }
  // HLS address for a feed: .m3u8 directly; MediaMTX (OTS): rtsp://host:8554/path -> http://host:8888/path/index.m3u8,
  // likewise the player pages http://host:8888/path or :8889/path (WebRTC)
  function hlsUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return ''; }
    const path = u.pathname.replace(/\/+$/, '');
    if (/\.m3u8$/i.test(path)) return u.href;
    if (!path || path === '/' || /\.[a-z0-9]{2,4}$/i.test(path)) return '';
    if (/^rtsps?:$/.test(u.protocol)) return `http://${u.hostname}:8888${path}/index.m3u8`;
    if (/^https?:$/.test(u.protocol) && (u.port === '8888' || u.port === '8889')) return `${u.protocol}//${u.hostname}:8888${path}/index.m3u8`;
    return '';
  }
  function play(name, url) {
    const img = $('vwImg'), vid = $('vwVideo');
    const say = t => { $('vwMsg').textContent = t || ''; };
    stopViewer();
    $('viewer').classList.remove('min');
    $('vwTitle').textContent = name || 'Stream';
    $('viewer').classList.remove('hidden');
    say('Loading …');
    const isHttp = /^https?:\/\//i.test(url);
    // last resort: open in a new tab (http) or copy the address for VLC (rtsp …)
    const giveUp = text => {
      img.classList.add('hidden');
      vid.classList.add('hidden');
      say(text);
      const alt = $('vwAlt');
      const tab = isHttp && !/\.m3u8(\?|$)/i.test(url); // a browser usually does not play a .m3u8 in a tab
      alt.textContent = tab ? 'Open in new tab' : 'Copy address (VLC)';
      alt.onclick = () => {
        if (tab) window.open(url, '_blank', 'noopener');
        else if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => { alt.textContent = 'Copied'; }, () => prompt('Stream address:', url));
        else prompt('Stream address:', url);
      };
      alt.classList.remove('hidden');
    };
    const asVideo = src => {
      img.classList.add('hidden');
      vid.classList.remove('hidden');
      vid.onloadeddata = () => say('');
      vid.onerror = () => giveUp('Stream cannot be played in the browser (format or not reachable).');
      vid.src = src;
      vid.play().catch(() => {});
    };
    const asHls = async src => {
      img.classList.add('hidden');
      vid.classList.remove('hidden');
      const via = mediaProxy(src); // same origin: no mixed content, no CORS
      // what the problem is (answer of the video server through the relay) – instead of just "not reachable"
      const why = async fallback => {
        const r = await fetch(via, { cache: 'no-store' }).catch(() => null);
        const t = r && !r.ok ? (await r.text().catch(() => '')).slice(0, 160) : '';
        giveUp(t ? `${fallback} (${t})` : fallback);
      };
      let Hls = null;
      try { Hls = await loadHlsLib(); } catch (e) { /* then built-in */ }
      // prefer hls.js; the built-in player (Safari/iPhone, newer Chrome/Edge) only when hls.js does not work –
      // the built-in one in Chrome/Edge often fails on the TAK server's MediaMTX streams
      if (!Hls || !Hls.isSupported()) {
        if (!vid.canPlayType('application/vnd.apple.mpegurl')) return giveUp('This browser cannot play HLS video.');
        vid.onloadeddata = () => say('');
        vid.onerror = () => why('Stream not reachable (HLS). ATAK/iTAK may still play it via RTSP.');
        vid.src = via;
        vid.play().catch(() => {});
        return;
      }
      const h = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, manifestLoadingMaxRetry: 2 });
      hls = h;
      h.on(Hls.Events.MANIFEST_PARSED, () => { say(''); vid.play().catch(() => {}); });
      h.on(Hls.Events.ERROR, (ev, data) => {
        if (!data.fatal || hls !== h) return;
        h.destroy();
        hls = null;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) why('Stream not reachable via HLS (is the camera live?). ATAK/iTAK may still play it via RTSP.');
        else giveUp('Stream format cannot be played in the browser.');
      });
      h.loadSource(via);
      h.attachMedia(vid);
    };
    startTele(name, url);
    const h = hlsUrl(url);
    if (!isHttp && !h) {
      giveUp('The browser cannot play ' + url.split(':')[0].toUpperCase() + ' directly.');
      return;
    }
    const u = isHttp ? window.eud.browserVideoUrl(url) : url;
    // our streams (…/user/id/stream.ts etc.): as an MJPEG image, low latency
    const mjpeg = !isHttp ? '' : /\/[a-z0-9][a-z0-9_-]*\/[a-z0-9]{4,32}\/?$/i.test(new URL(u).pathname) ? u.replace(/\/$/, '')
      : /\/(stream\.ts|snapshot\.jpg)$/i.test(url) ? url.replace(/\/(stream\.ts|snapshot\.jpg)$/i, '') : '';
    if (mjpeg && !/\.m3u8|\.mp4|\.webm/i.test(u)) {
      img.classList.remove('hidden');
      img.onload = () => say('');
      img.onerror = () => (h ? asHls(h) : asVideo(url)); // not MJPEG: try as video
      img.src = mjpeg + (mjpeg.includes('?') ? '&' : '?') + 't=' + Date.now();
    } else if (h) {
      asHls(h);
    } else if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) {
      asVideo(url);
    } else {
      // unknown http address (e.g. a player page): briefly try as video, otherwise open in a tab
      asVideo(url);
    }
  }
  // drone telemetry (KLV) of a feed: the server reads it while the feed is watched -> drone with field of view,
  // image area and image centre on the map; also to the TAK server (every 3 s) so ATAK sees the drone
  let tele = null, teleFwd = 0;
  function startTele(name, url) {
    stopTele();
    if (!window.EventSource || !/^(rtsps?|srt|https?):\/\//i.test(url)) return;
    try { if (new URL(url).host === location.host) return; } catch (e) { return; } // own streams carry no KLV
    const es = new EventSource('/api/eud/klv?u=' + encodeURIComponent(url) + '&n=' + encodeURIComponent(name || ''));
    tele = es;
    const chip = $('vwTele');
    es.addEventListener('cot', ev => {
      if (tele !== es) return;
      const d = JSON.parse(ev.data), i = d.info;
      for (const x of d.xml) window.eud.handleCot(x);
      if (Date.now() - teleFwd > 3000) { teleFwd = Date.now(); for (const x of d.xml) window.eud.forwardCot(x); }
      chip.textContent = `UAS${i.alt != null ? ' ' + Math.round(i.alt) + ' m' : ''} · ${String(Math.round(i.az) % 360).padStart(3, '0')}°`
        + (i.hfov ? ` · FOV ${Math.round(i.hfov)}°` : '') + ' ⌖';
      chip.onclick = () => window.eud.map.setView([i.lat, i.lon], Math.max(window.eud.map.getZoom(), 15));
      chip.classList.remove('hidden');
    });
    es.addEventListener('status', ev => {
      if (tele !== es) return;
      const st = JSON.parse(ev.data);
      if (['no-klv', 'unsupported', 'busy'].includes(st.state)) { es.close(); tele = null; chip.classList.add('hidden'); } // no telemetry: just video
      else if (st.state === 'connecting' && !chip.classList.contains('hidden')) chip.textContent = 'UAS: ' + st.message;
    });
  }
  function stopTele() {
    if (tele) { tele.close(); tele = null; }
    $('vwTele').classList.add('hidden');
  }

  function stopViewer() {
    stopTele();
    const img = $('vwImg'), vid = $('vwVideo');
    if (hls) { hls.destroy(); hls = null; }
    $('vwAlt').classList.add('hidden');
    img.onerror = img.onload = null;
    img.removeAttribute('src'); // end the MJPEG connection
    img.classList.add('hidden');
    vid.onerror = vid.onloadeddata = null;
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    vid.classList.add('hidden');
  }
  window.eudPlay = play;
  $('vwClose').addEventListener('click', () => { stopViewer(); $('viewer').classList.add('hidden'); $('viewer').classList.remove('full', 'min'); });
  $('vwMin').addEventListener('click', () => { $('viewer').classList.remove('full'); $('viewer').classList.toggle('min'); });
  document.querySelector('.vw-head').addEventListener('click', e => { if (!e.target.closest('button')) $('viewer').classList.remove('min'); });
  $('vwFull').addEventListener('click', () => { $('viewer').classList.remove('min'); $('viewer').classList.toggle('full'); });

  function renderStreams() {
    const box = $('streamList');
    box.textContent = '';
    const list = window.eud.videoItems();
    if (streamUrl && running) list.unshift({ name: 'My stream', url: streamUrl, own: true });
    if (!list.length) box.innerHTML = '<div class="empty">Nobody on the map is streaming video right now.</div>';
    for (const v of list) {
      const row = document.createElement('div');
      row.className = 'item';
      const t = document.createElement('span');
      t.textContent = v.name;
      const s = document.createElement('small');
      s.textContent = v.url;
      t.append(s);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '▶';
      b.onclick = () => { window.eud.closePopup(); play(v.name, v.url); };
      row.append(t, b);
      box.append(row);
    }
  }
  document.addEventListener('eud-popup', e => { if (e.detail === 'video') renderStreams(); });

  // the compass for the view direction (cone on the map) must be allowed within this tap (iPhone)
  $('phoneBtn').addEventListener('click', () => { window.eud.askCompass(); start('phone'); });
  $('bleBtn').addEventListener('click', () => { window.eud.askCompass(); start('ble'); });
  $('screenBtn').addEventListener('click', () => start('screen'));
  // screen sharing only where the browser supports it (PC); no button on phones
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && window.isSecureContext && !/Android|iPhone|iPad/i.test(navigator.userAgent);
  $('screenBtn').classList.toggle('hidden', !canShare);

  // drone / external camera: RTMP address with the TAK login (MediaMTX in the TAK server creates the feed itself)
  function fillDroneServers() {
    const list = window.eud.getServers().filter(x => x.host);
    $('droneSrv').replaceChildren(...list.map(x => new Option(x.name || x.host, x.id)));
    $('droneSrvRow').classList.toggle('hidden', list.length < 2);
    $('droneBox').classList.toggle('hidden', !list.length);
  }
  const droneUrl = (host, user, pw) => {
    const slug = String(profile.callsign || user).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cam';
    const path = 'drone-' + slug;
    $('droneUrl').value = `rtmp://${host}:1935/${path}?user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pw)}`;
    $('dronePath').textContent = path;
    $('droneOut').classList.remove('hidden');
  };
  // signed up via the access page: this server already knows the login – no password to type
  async function droneFromAccess() {
    let token = '';
    try { token = localStorage.getItem('tak.access') || ''; } catch (e) { /* private mode */ }
    if (!token) return false;
    const me = await fetch('/api/access/me', { headers: { 'X-Access-Token': token } }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!me || me.status !== 'active' || !me.password || !me.host) return false;
    droneUrl(me.host, me.username, me.password);
    $('droneAsk').classList.add('hidden');
    $('droneBox').classList.remove('hidden');
    return true;
  }
  // logged in on this device (certificate requested with user + password): the address without typing,
  // unique per user (drone-<callsign>) – MediaMTX in the TAK server checks exactly this login
  function droneFromLogin() {
    const list = window.eud.getServers().filter(x => x.host && x.username && x.password);
    const srv = list.find(x => x.id === $('droneSrv').value) || list.find(x => x.auto) || list[0];
    if (!srv) return false;
    droneUrl(srv.host, srv.username, srv.password);
    $('droneAsk').classList.add('hidden');
    return true;
  }
  async function droneReady() {
    fillDroneServers();
    if (await droneFromAccess()) return;
    if (droneFromLogin()) return;
    // registered user, connected with the certificate: TAKweb hands over the login – nothing to type
    if (await window.eud.askDrone()) droneFromLogin();
  }
  $('droneBox').addEventListener('toggle', () => { if ($('droneBox').open) droneReady(); });
  $('droneSrv').addEventListener('change', droneFromLogin);
  document.addEventListener('eud-popup', e => { if (e.detail === 'video') droneReady(); });
  // TAK user of a server: from the login, otherwise from the certificate (CN – e.g. login via data package / .p12)
  const takUser = srv => srv.username || ((/(?:^|,\s*)CN=([^,]+)/.exec((srv.certInfo && srv.certInfo.subject) || '') || [])[1] || '').trim();
  $('droneMake').addEventListener('click', async () => {
    const srv = window.eud.getServers().find(x => x.id === $('droneSrv').value) || window.eud.getServers().find(x => x.host);
    if (!srv) return toast('Add a TAK server first.');
    const user = takUser(srv);
    const pw = $('dronePw').value;
    if (!user) return toast('No TAK user known – log in to the server with user and password first.');
    if (!pw) { $('dronePw').focus(); return toast('Enter your TAK password once – it is kept on this device (like ATAK).'); }
    $('droneMake').disabled = true;
    try {
      // checked by the TAK server first, then kept: next time the address appears by itself
      const req = { host: srv.host, port: srv.enrollPort, username: user, password: pw, caPems: srv.caPems, fingerprint: srv.fingerprint };
      try { await window.eud.postJson('/api/eud/check-login', req); } catch (e) {
        // unknown certificate on the enrollment port: ask once like at the login
        if (e.code !== 'UNTRUSTED' || !(await window.eud.askTrust(`${srv.host}:${srv.enrollPort || 8446}`, e.fingerprint, e.subject))) throw e;
        await window.eud.postJson('/api/eud/check-login', { ...req, fingerprint: e.fingerprint });
      }
      srv.username = srv.username || user;
      srv.password = pw;
      window.eud.saveServers();
      toast('Password confirmed – kept on this device.');
    } catch (e) {
      if (/rejected/i.test(e.message)) { $('droneMake').disabled = false; return toast('Wrong TAK password.'); }
      toast('Could not check the password (' + e.message + ') – address shown anyway.', 6000);
    }
    $('droneMake').disabled = false;
    droneUrl(srv.host, user, pw);
    $('droneAsk').classList.add('hidden');
    $('dronePw').value = '';
  });
  $('droneCopy').addEventListener('click', () => {
    const v = $('droneUrl').value;
    if (navigator.clipboard) navigator.clipboard.writeText(v).then(() => toast('Address copied.'), () => $('droneUrl').select());
    else $('droneUrl').select();
  });
  $('vidStop').addEventListener('click', () => stop());
  $('btnVideo').addEventListener('click', () => openPopup('video'));
  $('livePreview').addEventListener('click', e => { if (!e.target.closest('button')) openPopup('video'); });
  $('lpMin').addEventListener('click', () => $('livePreview').classList.toggle('min'));
  $('lpClose').addEventListener('click', () => { previewHidden = true; toast('Preview hidden – the stream keeps running.'); render(); });
  $('lpShow').addEventListener('click', () => { previewHidden = false; $('livePreview').classList.remove('min'); render(); });
  if (!navigator.bluetooth) $('bleBtn').title = isIOS ? 'On iPhone only with the "Bluefy" app' : 'Browser without Bluetooth';
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running && 'wakeLock' in navigator) navigator.wakeLock.request('screen').then(w => { wakeLock = w; }).catch(() => {});
  });
  render();
})();
