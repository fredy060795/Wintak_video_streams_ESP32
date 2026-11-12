// Meshtastic over Bluetooth (Web Bluetooth: Android/Chrome, iPhone only in the "Bluefy" app): the EUD talks
// directly to a Meshtastic radio. Positions and chat go over LoRa as TAK packets (port 72), markers and other
// CoT over port 257 – like the Meshtastic ATAK plugin, so ATAK users with the plugin and TAKweb users see each
// other without internet.
// Sending: only while no TAK server is connected (default) or always. During a video stream the radio is
// released (camera and LoRa share the phone's Bluetooth) and reconnected when the stream ends.
'use strict';

(() => {
  const { $, store, profile, toast, setMsg, openPopup, handleCot, removeItem, distance } = window.eud;
  const P = window.meshProto;
  // BLE service of the Meshtastic firmware (src/BluetoothCommon.h)
  const SVC = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
  const TORADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
  const FROMRADIO = '2c55e69e-4993-11ed-b878-0242ac120002';
  const FROMNUM = 'ed9da18c-a800-4f66-a670-aa7547e34453';
  const MAX_TEXT = 180;           // bytes of chat text per LoRa packet (payload limit ~230 bytes)
  const NODE_MAX_AGE = 2 * 3600;  // show Meshtastic nodes heard within the last 2 h
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const cfg = Object.assign({
    enabled: false, id: '', name: '', send: 'always', interval: 60, channel: 0, nodes: true, text: true, bridge: true,
    transport: 'ble', http: '', // http: the radio over WLAN (its HTTP API) – '' = the radio that serves this page
  }, store.get('eud.mesh', {}));
  // TAKweb loaded from the radio itself (mesh-only page on its flash): talk to it over WLAN, no Bluetooth needed
  const ON_RADIO = !!window.TAKWEB_MESH;
  if (ON_RADIO) Object.assign(cfg, { enabled: true, transport: 'http', http: '', name: cfg.name || 'This radio (WLAN)' });
  // default: always also over the mesh – otherwise devices without internet miss what online users send.
  // The old default "offline" is switched over unless the user chose it himself.
  if (cfg.send !== 'always' && !cfg.sendChosen) cfg.send = 'always';
  const save = () => store.set('eud.mesh', cfg);

  let device = null, toRadio = null, fromRadio = null, fromNum = null;
  let state = 'off';   // off | tap | connecting | connected | paused | lost
  let message = '';
  let myNode = 0, nonce = 0;
  let networkRaw = null; // the radio's network settings (WLAN)
  let loraRaw = null, region = -1, preset = -1, usePreset = true; // LoRa settings of the radio; region 0 = not set (silent)
  let pausedForVideo = false, retry = 0, retryTimer = null, pollTimer = null;
  let draining = false, drainAgain = false, writeChain = Promise.resolve(), httpFails = 0;
  let lastPli = 0, pliAt = null;
  const nodes = new Map(); // num -> { user, position, lastHeard, takUid }
  let channels = [];

  const msg = (text, ok) => setMsg($('meshMsg'), text, ok);

  // ---------------- UI ----------------

  const STATE_TEXT = {
    off: 'Not connected', tap: 'Tap CONNECT to reconnect', connecting: 'Connecting …', connected: 'Connected',
    paused: 'Paused – video stream running', lost: 'Connection lost – retrying …',
  };

  function render() {
    // icon: green = connected, yellow = connecting / paused for video, red = not connected
    const kind = state === 'connected' ? 'ok' : ['connecting', 'paused'].includes(state) ? 'wait' : 'err';
    $('meshBanner').className = 'nw-banner ' + (state === 'connected' ? 'good' : state === 'off' ? 'off' : 'wait');
    $('meshState').textContent = state === 'connected'
      ? `Connected: ${cfg.name || 'Meshtastic'}${myNode ? ' (' + P.nodeId(myNode) + ')' : ''}`
      : (STATE_TEXT[state] || state) + (message ? ' – ' + message : '');
    const heard = [...nodes.values()].filter(n => n.lastHeard && Date.now() / 1000 - n.lastHeard < NODE_MAX_AGE).length;
    $('meshNodes').textContent = state === 'connected' ? String(heard) : '–';
    $('meshRegion').classList.toggle('hidden', !(state === 'connected' && region === 0));
    $('meshChan').classList.toggle('hidden', state !== 'connected');
    $('meshNet').classList.toggle('hidden', !(ON_RADIO && state === 'connected'));
    // channel, modem preset, region and key of the radio – must match the other radios of the mesh
    const prim = channels.find(c => c.role === 1);
    const regName = Object.keys(P.REGIONS).find(k => P.REGIONS[k] === region) || (region === 0 ? 'REGION NOT SET' : '');
    const keyText = prim ? { default: 'public default key', none: 'no encryption', simple: 'simple key', own: 'own key' }[prim.key] || '' : '';
    $('meshRadioInfo').textContent = state === 'connected' && loraRaw
      ? [prim ? (prim.name || (usePreset ? 'LongFast (default channel)' : 'unnamed')) : '', usePreset ? (P.PRESETS[preset] || '') : 'custom LoRa', regName, keyText].filter(Boolean).join(' · ')
      : '–';
    $('meshSending').textContent = state !== 'connected' ? '–' : shouldSend() ? 'Yes (LoRa)' : 'No – TAK server connected';
    $('meshPick').classList.toggle('hidden', ['connected', 'connecting', 'paused'].includes(state));
    $('meshWlan').classList.toggle('hidden', ON_RADIO || ['connected', 'connecting'].includes(state));
    if (!$('meshHttp').value && cfg.http) $('meshHttp').value = cfg.http;
    $('meshPick').textContent = ON_RADIO ? 'CONNECT THIS RADIO' : cfg.enabled && cfg.name ? 'RECONNECT ' + cfg.name : 'CONNECT MESHTASTIC RADIO';
    $('meshOff').classList.toggle('hidden', !cfg.enabled);
    // on the radio's page also another radio over Bluetooth (Chrome on Android)
    $('meshNew').classList.toggle('hidden', ON_RADIO ? !navigator.bluetooth || state === 'connecting' : !cfg.id || state === 'connecting');
    $('meshBt').classList.toggle('hidden', ON_RADIO || !!navigator.bluetooth);
    $('meshBluefy').classList.toggle('hidden', ON_RADIO || !!navigator.bluetooth || !isIOS);
    $('meshSend').value = cfg.send;
    $('meshInterval').value = String(cfg.interval);
    $('meshShowNodes').checked = cfg.nodes;
    $('meshText').checked = cfg.text;
    $('meshBridge').checked = cfg.bridge;
    const sel = $('meshChannel');
    const list = channels.length ? channels : [{ index: cfg.channel, name: '' }];
    sel.textContent = '';
    for (const c of list) {
      const o = document.createElement('option');
      o.value = String(c.index);
      o.textContent = `${c.index}: ${c.name || (c.index === 0 ? 'Primary' : 'Channel ' + c.index)}`;
      sel.append(o);
    }
    sel.value = String(cfg.channel);
    // indicator on the map (above the server status) and on the tile in Tools
    $('meshBtn').className = (cfg.enabled ? '' : 'hidden ') + kind;
    $('meshBtn').title = 'Meshtastic: ' + $('meshState').textContent;
    $('meshTileDot').className = 'tile-dot ' + (cfg.enabled ? kind : 'hidden');
  }

  function setState(s, m = '') {
    state = s;
    message = m;
    render();
  }

  // ---------------- Bluetooth ----------------

  // user gesture: choose a radio (the browser shows its device list)
  async function pick() {
    msg('');
    if (!navigator.bluetooth) {
      msg(isIOS ? 'On iPhone, Bluetooth only works in the "Bluefy" app.' : 'This browser has no Bluetooth (use Chrome).');
      return;
    }
    try {
      const d = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }], optionalServices: [SVC] });
      if (device && device !== d) disconnect();
      useDevice(d);
      cfg.enabled = true;
      cfg.id = d.id;
      cfg.name = d.name || 'Meshtastic';
      save();
      retry = 0;
      await open();
    } catch (e) {
      if (!(e.name === 'NotFoundError' && /cancel/i.test(e.message))) msg(e.message);
    }
  }

  function useDevice(d) {
    if (device === d) return;
    if (device) device.removeEventListener('gattserverdisconnected', onLost);
    device = d;
    device.addEventListener('gattserverdisconnected', onLost);
  }

  // ---------------- WLAN: the radio's HTTP API (Meshtastic firmware: /api/v1/toradio, /api/v1/fromradio) ----------------
  // the same protobufs as over Bluetooth; there is no notification, so the radio is asked about once a second
  const httpBase = () => String(cfg.http || '').replace(/\/+$/, '');
  function httpChars() {
    const base = httpBase();
    const tx = { writeValue: async bytes => {
      const r = await fetch(base + '/api/v1/toradio', { method: 'PUT', headers: { 'Content-Type': 'application/x-protobuf' }, body: bytes });
      if (!r.ok) throw new Error('radio answered ' + r.status);
    } };
    const rx = { readValue: async () => {
      const r = await fetch(base + '/api/v1/fromradio?all=false', { cache: 'no-store' });
      if (!r.ok) throw new Error('radio answered ' + r.status);
      return new DataView(await r.arrayBuffer());
    } };
    return { tx, rx };
  }
  async function openHttp() {
    setState('connecting');
    try {
      const { tx, rx } = httpChars();
      await rx.readValue(); // reachable?
      toRadio = tx; fromRadio = rx; fromNum = null;
      clearInterval(pollTimer);
      pollTimer = setInterval(() => { drain().catch(() => {}); }, 1000);
      myNode = 0;
      channels = [];
      nonce = 1 + Math.floor(Math.random() * 0x7ffffff0);
      await write(P.wantConfig(nonce));
      drain();
    } catch (e) {
      toRadio = fromRadio = null;
      if (cfg.enabled) { setState('lost', 'radio over WLAN not reachable'); schedule(); }
    }
  }

  // after a reload: the browser may give us the permitted radio again without a device dialog
  async function restore() {
    if (device || !cfg.enabled || !cfg.id) return !!device;
    try {
      if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return false;
      const d = (await navigator.bluetooth.getDevices()).find(x => x.id === cfg.id);
      if (d) useDevice(d);
    } catch (e) { /* not supported */ }
    return !!device;
  }

  async function open() {
    clearTimeout(retryTimer);
    if (!cfg.enabled || pausedForVideo || state === 'connecting') return;
    if (cfg.transport === 'http') return openHttp();
    if (!device && !(await restore())) return setState('tap');
    setState('connecting');
    try {
      const server = await device.gatt.connect();
      const svc = await server.getPrimaryService(SVC);
      toRadio = await svc.getCharacteristic(TORADIO);
      fromRadio = await svc.getCharacteristic(FROMRADIO);
      fromNum = await svc.getCharacteristic(FROMNUM);
      if (pausedForVideo || !cfg.enabled) return disconnect(); // a stream started or switched off meanwhile
      clearInterval(pollTimer);
      try {
        fromNum.addEventListener('characteristicvaluechanged', drain);
        await fromNum.startNotifications();
        pollTimer = setInterval(drain, 15000); // safety net
      } catch (e) {
        pollTimer = setInterval(drain, 2000); // no notifications (some browsers): poll
      }
      myNode = 0;
      channels = [];
      nonce = 1 + Math.floor(Math.random() * 0x7ffffff0);
      await write(P.wantConfig(nonce));
      drain();
    } catch (e) {
      if (!pausedForVideo && cfg.enabled) { setState('lost', e.message); schedule(); }
    }
  }

  function schedule() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, Math.min(30000, 2000 * 2 ** retry++));
  }

  function onLost() {
    clearInterval(pollTimer);
    toRadio = fromRadio = fromNum = null;
    if (pausedForVideo || !cfg.enabled) return render();
    setState('lost');
    schedule();
  }

  function disconnect() {
    clearTimeout(retryTimer);
    clearInterval(pollTimer);
    toRadio = fromRadio = fromNum = null;
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
  }

  function write(bytes) {
    const run = () => {
      if (!toRadio) throw new Error('Meshtastic radio not connected');
      return toRadio.writeValueWithResponse ? toRadio.writeValueWithResponse(bytes) : toRadio.writeValue(bytes);
    };
    writeChain = writeChain.catch(() => {}).then(run);
    return writeChain;
  }

  // read FromRadio until it is empty (the radio announces new data via FromNum)
  async function drain() {
    if (draining) { drainAgain = true; return; }
    draining = true;
    try {
      do {
        drainAgain = false;
        while (fromRadio) {
          const v = await fromRadio.readValue();
          if (!v.byteLength) break;
          handle(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        }
      } while (drainAgain && fromRadio);
      httpFails = 0;
    } catch (e) {
      // Bluetooth: onLost handles it. WLAN has no disconnect event: three failed reads in a row count as lost
      if (cfg.transport === 'http' && fromRadio && ++httpFails >= 3) { httpFails = 0; onLost(); }
    } finally {
      draining = false;
    }
  }

  // set the LoRa region (after a new install it is not set – then the radio is silent); the radio restarts
  $('meshRegionGo').addEventListener('click', async () => {
    const code = P.REGIONS[$('meshRegionSel').value];
    if (!code || state !== 'connected' || !myNode) return;
    try {
      await write(P.adminSetRegion(myNode, loraRaw || new Uint8Array(0), code));
      region = code;
      render();
      toast('Region set – the radio restarts and is on the mesh then.', 8000);
    } catch (e) { toast('Region not set: ' + e.message); }
  });

  // put a Meshtastic channel link onto the radio (channels + LoRa settings); the radio may restart
  $('meshChanGo').addEventListener('click', async () => {
    if (state !== 'connected' || !myNode) return;
    let r;
    try { r = P.applyChannelUrl(myNode, $('meshChanUrl').value, { region: region > 0 ? region : P.REGIONS.EU_868 }); } catch (e) { return toast(e.message, 6000); }
    try {
      for (const pkt of r.packets) { await write(pkt); await new Promise(res => setTimeout(res, 300)); }
      toast(`Channel ${r.names.join(', ')} set – the radio applies it (and may restart).`, 8000);
      $('meshChanUrl').value = '';
      setTimeout(() => { nonce = 1 + Math.floor(Math.random() * 0x7ffffff0); write(P.wantConfig(nonce)).then(drain).catch(() => {}); }, 4000);
    } catch (e) { toast('Channel not set: ' + e.message); }
  });

  // ---- TAKweb firmware: a WLAN with internet besides the radio's own one (only on the radio's page)
  const netSsid = () => { try { const f = P.decode(networkRaw || new Uint8Array(0)); return f.has(3) ? new TextDecoder().decode(f.get(3)[0].v) : ''; } catch (e) { return ''; } };
  async function netState() {
    const ssid = netSsid();
    let text = ssid && ssid !== 'TAKweb' ? `Internet WLAN: "${ssid}" – ` : 'No internet WLAN set – the radio only has its own WLAN.';
    if (ssid && ssid !== 'TAKweb') {
      try {
        const r = await (await fetch('/json/report', { cache: 'no-store' })).json();
        const w = (r.data || {}).wifi || {};
        text += w.ip && w.ip !== '0.0.0.0' ? `connected (address ${w.ip}${w.rssi ? ', ' + w.rssi + ' dBm' : ''}).` : 'not connected (out of reach or wrong password).';
      } catch (e) { text += 'state unknown.'; }
      $('meshNetSsid').value = $('meshNetSsid').value || ssid;
    }
    $('meshNetState').textContent = text;
  }
  $('meshNet').addEventListener('toggle', () => { if ($('meshNet').open) netState(); });
  $('meshNetScan').addEventListener('click', async () => {
    $('meshNetScan').disabled = true;
    toast('Searching WLANs …');
    try {
      const r = await (await fetch('/json/scanNetworks', { cache: 'no-store' })).json();
      const list = (r.data || []).sort((a, b) => b.rssi - a.rssi);
      const sel = $('meshNetList');
      sel.replaceChildren(new Option(list.length ? `– ${list.length} WLANs found –` : '– none found –', ''), ...list.map(n => new Option(`${n.ssid} (${n.rssi} dBm)`, n.ssid)));
      sel.classList.remove('hidden');
    } catch (e) { toast('Search failed: ' + e.message); }
    $('meshNetScan').disabled = false;
  });
  $('meshNetList').addEventListener('change', () => {
    const v = $('meshNetList').value;
    if (v) { $('meshNetSsid').value = v; $('meshNetPsk').focus(); }
  });
  async function setNet(ssid, psk, ip) {
    if (state !== 'connected' || !myNode) return;
    try {
      await write(P.adminSetWifi(myNode, networkRaw, { ssid, psk, ip }));
      await new Promise(r => setTimeout(r, 1500));
      await write(P.adminReboot(myNode, 3)).catch(() => {});
      toast(ssid ? `The radio restarts and also joins "${ssid}". Its own WLAN "TAKweb" stays – reconnect to it if the phone left it.`
        : 'The radio restarts with its own WLAN only.', 10000);
    } catch (e) { toast('Not set: ' + e.message); }
  }
  $('meshNetGo').addEventListener('click', () => {
    const ssid = $('meshNetSsid').value.trim(), psk = $('meshNetPsk').value;
    if (!ssid) return $('meshNetSsid').focus();
    if (psk && psk.length < 8) return toast('A WLAN password needs at least 8 characters.');
    setNet(ssid, psk, $('meshNetIphone').checked ? P.IPHONE_IP : '');
  });
  $('meshNetOff').addEventListener('click', () => setNet('', '', ''));

  // ---------------- Receiving ----------------

  function handle(buf) {
    let m;
    try { m = P.parseFromRadio(buf); } catch (e) { return; }
    if (m.kind === 'myInfo') myNode = m.nodeNum;
    else if (m.kind === 'config' && m.network) networkRaw = m.network;
    else if (m.kind === 'config' && m.lora) { loraRaw = m.lora; region = m.region; preset = m.preset; usePreset = m.usePreset; }
    else if (m.kind === 'channel') {
      channels = channels.filter(c => c.index !== m.channel.index);
      if (m.channel.role) channels = channels.concat(m.channel).sort((a, b) => a.index - b.index);
    } else if (m.kind === 'nodeInfo') {
      const n = node(m.node.num);
      if (m.node.user) n.user = m.node.user;
      if (m.node.position) n.position = m.node.position;
      n.lastHeard = Math.max(n.lastHeard || 0, m.node.lastHeard || 0);
      showNode(m.node.num);
    } else if (m.kind === 'configComplete' && m.id === nonce) {
      retry = 0;
      if (!channels.some(c => c.index === cfg.channel)) { cfg.channel = 0; save(); }
      setState('connected');
      toast(region === 0 ? 'Meshtastic connected – but the LoRa region is NOT set: the radio is silent. Set it under Meshtastic.' : 'Meshtastic connected: ' + (cfg.name || 'radio'), region === 0 ? 10000 : undefined);
      lastPli = 0; // send our position right away
      tick();
    } else if (m.kind === 'rebooted') {
      write(P.wantConfig(nonce)).then(drain).catch(() => {});
    } else if (m.kind === 'packet') {
      receive(m.packet);
    }
    if (popupOpen()) render();
  }

  function node(num) {
    if (!nodes.has(num)) nodes.set(num, { user: null, position: null, lastHeard: 0, takUid: '' });
    return nodes.get(num);
  }

  function receive(p) {
    if (!p.payload || p.from === myNode) return; // encrypted for someone else / own echo
    const n = node(p.from);
    n.lastHeard = Math.floor(Date.now() / 1000);
    if (p.portnum === P.PORT.ATAK) {
      let tak;
      try { tak = P.parseTak(p.payload); } catch (e) { return; }
      if (tak.compressed) return; // old firmware compressed TAK strings (unishox2) – not readable here
      if (tak.uid && !n.takUid) {
        n.takUid = tak.uid;
        removeItem('MESH-' + P.nodeId(p.from)); // now shown as a TAK contact
      }
      if (tak.pli) fromMesh(P.pliCot(tak, p.from));
      else if (tak.chat && tak.chat.to) {
        const all = tak.chat.to === P.ALL_CHAT;
        const xml = P.chatCot({
          senderUid: tak.uid || 'MESH-' + P.nodeId(p.from), senderCallsign: tak.callsign || P.nodeId(p.from),
          msgId: tak.msgId || String(p.id), text: tak.chat.message, toUid: all ? '' : tak.chat.to,
        });
        if (all || tak.chat.to === profile.uid) fromMesh(xml);
        else directUp(xml, tak.chat.to); // direct message for someone else: not shown here, only passed on to the TAK server
      }
    } else if (p.portnum === P.PORT.FORWARDER) {
      receiveForwarder(p).catch(() => {});
    } else if (p.portnum === P.PORT.PRIVATE) {
      receiveVoice(p);
    } else if (p.portnum === P.PORT.TEXT) {
      // TAK users send their chat as a TAK packet too (and the plugin ignores their text) -> skip duplicates
      if (n.takUid || (p.to !== P.BROADCAST && p.to !== myNode)) return;
      const name = P.nodeTeam((n.user && (n.user.longName || n.user.shortName)) || P.nodeId(p.from)).callsign; // without " -5" team suffix
      handleCot(P.chatCot({ senderUid: 'MESH-' + P.nodeId(p.from), senderCallsign: name, msgId: String(p.id), text: new TextDecoder().decode(p.payload) }));
    } else if (p.portnum === P.PORT.POSITION) {
      try { n.position = P.parsePositionPayload(p.payload) || n.position; } catch (e) { return; }
      if (n.position && !n.position.time) n.position.time = n.lastHeard;
      showNode(p.from);
    } else if (p.portnum === P.PORT.NODEINFO) {
      try { n.user = P.parseUserPayload(p.payload) || n.user; } catch (e) { /* ignore */ }
    }
  }

  // plain Meshtastic users (Meshtastic app, no TAK) as points on the map
  function showNode(num) {
    const n = nodes.get(num);
    if (!cfg.nodes || !n || num === myNode || n.takUid || !n.position) return;
    const heard = Math.max(n.lastHeard || 0, n.position.time || 0);
    if (!heard || Date.now() / 1000 - heard > NODE_MAX_AGE) return; // no time known: not shown as current
    const it = window.eud.items.get('MESH-' + P.nodeId(num));
    if (it && it.c.time > heard * 1000) return; // nothing newer than what the map has
    handleCot(P.nodeCot({ num, user: n.user, position: n.position, heard }));
  }

  // ---------------- Sending ----------------

  const shouldSend = () => state === 'connected' && (cfg.send === 'always' || !window.eud.serverOnline());

  function send(portnum, payload, channel = cfg.channel) {
    return write(P.toRadioPacket({ portnum, payload, channel, id: 1 + Math.floor(Math.random() * 0xfffffff0) }));
  }

  function sendPli() {
    const me = window.eud.getMe();
    if (!me) return;
    lastPli = Date.now();
    pliAt = { lat: me.lat, lon: me.lon };
    send(P.PORT.ATAK, P.takPli({
      callsign: profile.callsign || profile.uid, uid: profile.uid, team: profile.team, role: profile.role, battery: window.eud.battery(),
      lat: me.lat, lon: me.lon, alt: me.alt, speed: me.speed, course: me.course,
    })).catch(e => msg('Sending position failed: ' + e.message));
  }

  // position: at the chosen interval, earlier when moved more than 50 m (but at most every 15 s)
  function tick() {
    if (!shouldSend()) return;
    const me = window.eud.getMe();
    if (!me) return;
    const since = Date.now() - lastPli;
    const moved = pliAt ? distance(pliAt, me) : Infinity;
    if (since >= cfg.interval * 1000 || (moved > 50 && since >= 15000)) sendPli();
  }
  setInterval(tick, 5000);

  // cut text to MAX_TEXT bytes without breaking a character
  function fit(text) {
    let t = text;
    while (P.utf8.encode(t).length > MAX_TEXT) t = t.slice(0, -1);
    return t;
  }

  // TAK packets (V1) know "All Chat Rooms" and direct messages to a UID – like the ATAK plugin; no team/group rooms
  document.addEventListener('eud-chat-out', e => {
    if (!shouldSend()) return;
    const { text, xml, conv = { key: 'all' } } = e.detail;
    const direct = conv.key.startsWith('dm:');
    if (conv.key !== 'all' && !direct) { toast('Mesh: team and group chats are not sent over LoRa – use All or a direct message.', 5000); return; }
    const m = /messageId="([^"]+)"/.exec(xml || '');
    const body = fit(text);
    const to = direct ? conv.uid || conv.key.slice(3) : P.ALL_CHAT;
    send(P.PORT.ATAK, P.takChat({ callsign: profile.callsign || profile.uid, uid: profile.uid, msgId: m ? m[1] : '', message: body, to }))
      // plain text is public on the channel: only for All
      .then(() => (cfg.text && !direct ? send(P.PORT.TEXT, P.utf8.encode(fit(`${profile.callsign || profile.uid}: ${text}`))) : null))
      .then(() => { if (body !== text) toast('Mesh: message shortened to fit one LoRa packet.'); })
      .catch(err => toast('Mesh: sending failed – ' + err.message));
  });

  // ---------------- Markers, changes, deletions: CoT over port 257 like the ATAK plugin ----------------
  // zlib-compressed CoT XML: below 233 bytes as one packet, larger as fountain blocks (receivers answer with an ACK)

  const MAX_DIRECT = 232;      // the plugin sends payloads below 233 bytes directly
  const MAX_SOURCE_BLOCKS = 10; // ~2 KB compressed – larger (long routes …) waits for the TAK server
  const BLOCK_GAP = 1600;      // ms between blocks (LongFast airtime like the plugin's default)
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // over plain http (the radio's own WLAN) crypto.subtle is missing – then the small SHA-256 below
  const sha8 = async b => (window.crypto && crypto.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', b)) : P.sha256(b)).slice(0, 8);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const through = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  const zlib = bytes => (window.CompressionStream ? through(bytes, new CompressionStream('deflate')) : Promise.resolve(bytes));
  async function unzlib(bytes) {
    if (window.DecompressionStream) {
      for (const f of ['deflate', 'deflate-raw']) {
        try { return await through(bytes, new DecompressionStream(f)); } catch (e) { /* next format */ }
      }
    }
    return bytes; // plain XML
  }

  const sending = new Map();   // transferId -> { hash, done, more }
  const receiving = new Map(); // "from:transferId" -> { K, totalLength, blocks, seeds, done, t }

  document.addEventListener('eud-cot-out', e => {
    if (!shouldSend()) return;
    e.detail.mesh = true;
    sendCotMesh(e.detail.xml).catch(err => toast('Mesh: sending failed – ' + err.message));
  });

  async function sendCotMesh(xml, { quick = false } = {}) {
    const z = await zlib(P.utf8.encode(xml));
    if (z.length <= MAX_DIRECT) return send(P.PORT.FORWARDER, z);
    const data = new Uint8Array(z.length + 1); // transfer type byte (0 = CoT) + zlib data
    data[0] = P.FOUNTAIN.TYPE_COT;
    data.set(z, 1);
    const K = Math.ceil(data.length / P.FOUNTAIN.BLOCK);
    if (K > MAX_SOURCE_BLOCKS) { if (!quick) toast('Mesh: too large for LoRa – it is sent once the TAK server is back.', 5000); return; }
    const transferId = 1 + Math.floor(Math.random() * 0xfffffe);
    const st = { hash: await sha8(data), done: false, more: 0 };
    sending.set(transferId, st);
    // like the plugin: blocks + ACK wait, up to 3 rounds; a further round sends NEW blocks (new seeds)
    let next = 0, count = P.fountainBlockCount(K);
    // bridge (quick): one round and a short wait – a gateway must not block LoRa for minutes
    for (let round = 0; round < (quick ? 1 : 3) && !st.done && state === 'connected'; round++) {
      const blocks = P.fountainEncode(data, next + count, transferId).slice(next);
      next += count;
      for (const b of blocks) {
        if (st.done || state !== 'connected') break;
        await send(P.PORT.FORWARDER, b);
        await sleep(BLOCK_GAP);
      }
      const until = Date.now() + (quick ? 8000 : Math.min(300000, 10000 + count * 6400 + 12800));
      while (!st.done && !st.more && Date.now() < until && state === 'connected') await sleep(250);
      count = st.more || Math.max(5, Math.ceil(K / 5));
      st.more = 0;
    }
    sending.delete(transferId);
  }

  async function receiveForwarder(p) {
    const b = p.payload;
    const f = P.parseFountain(b);
    if (f && f.ack) {
      const st = sending.get(f.ack.transferId);
      if (!st) return;
      if (f.ack.type === P.FOUNTAIN.COMPLETE) { if (same(f.ack.hash, st.hash)) st.done = true; } else if (f.ack.type === P.FOUNTAIN.NEED_MORE) st.more = f.ack.needed;
      return;
    }
    if (f && f.block) return receiveBlock(p, f.block);
    if (b[0] === 0xc2 || (b[0] === 0x4d && b[1] === 0x46 && b[2] === 0x54)) return; // codec2 voice, file transfer receipt
    showCot(await unzlib(b));
  }

  async function receiveBlock(p, blk) {
    const key = p.from + ':' + blk.transferId;
    let st = receiving.get(key);
    if (st && (st.K !== blk.K || st.totalLength !== blk.totalLength)) st = null; // new transfer with the same id
    if (!st) { st = { K: blk.K, totalLength: blk.totalLength, blocks: [], seeds: new Set(), done: false }; receiving.set(key, st); }
    st.t = Date.now();
    if (st.done || st.seeds.has(blk.seed)) return;
    st.seeds.add(blk.seed);
    st.blocks.push(blk);
    if (st.blocks.length < st.K) return;
    const data = P.fountainDecode(st.blocks, st.K, st.totalLength, blk.transferId);
    if (!data) return;
    st.done = true;
    // ACK like the plugin (twice), so the sender stops repeating
    const ack = P.fountainAck(blk.transferId, P.FOUNTAIN.COMPLETE, st.blocks.length, 0, await sha8(data));
    send(P.PORT.FORWARDER, ack, p.channel).then(() => sleep(200)).then(() => send(P.PORT.FORWARDER, ack, p.channel)).catch(() => {});
    if (data[0] === 0x00 || data[0] === 0x30) showCot(await unzlib(data.subarray(1))); // CoT (0x30 = "0" from iOS)
  }

  function showCot(bytes) {
    const xml = new TextDecoder().decode(bytes).trim();
    if (!xml.startsWith('<')) return;
    try { fromMesh(xml); } catch (e) { /* not CoT */ }
  }

  // ---------------- Bridge: mesh <-> TAK server ----------------
  // A TAKweb device with a radio AND a TAK server is a gateway: what only came over LoRa goes to the TAK server,
  // what only came from the server goes over LoRa – everybody ends up with the same picture.
  // No duplicates, no loops, no collisions with several gateways:
  // - every gateway waits a random 2–8 s and skips what has meanwhile arrived on the other side,
  // - what a gateway passes on carries <__takwebmesh/> and never goes back,
  // - only TAK content: plain Meshtastic nodes/texts (strangers on a public channel) stay off the TAK server,
  // - only live content: what a server sends again on connecting stays off LoRa,
  // - towards LoRa: positions of a contact at most every 5 min, one packet every 3 s (airtime).
  const MARK = '__takwebmesh';
  const SEEN_MS = 10 * 60000, PLI_SAME_MS = 90000, PLI_DOWN_MS = 5 * 60000;
  const seenServer = new Map(), seenMesh = new Map(), pliDown = new Map();
  const pendingUp = new Set(), pendingDown = new Set(); // waiting right now (an update arriving meanwhile is not scheduled twice)
  // attribute of the <event> tag – WinTAK puts <?xml …?> in front, so not simply the first tag
  const attr = (xml, a) => { const i = Math.max(0, xml.indexOf('<event')); const m = new RegExp(`\\s${a}="([^"]*)"`).exec(xml.slice(i, xml.indexOf('>', i) + 1)); return m ? m[1] : ''; };
  const isPli = (type, xml) => type.startsWith('a-') && xml.includes('<__group');
  // chat: same UID on both ways (GeoChat.<sender>.<room>.<messageId>); position: only "recently" (the mesh copy has a new time);
  // everything else: UID + time (a change has a new time)
  function bridgeKey(xml) {
    const type = attr(xml, 'type'), uid = attr(xml, 'uid');
    if (!type || !uid) return null;
    if (type === 'b-t-f') return { type, uid, key: 'c|' + uid, pli: false };
    if (isPli(type, xml)) return { type, uid, key: 'p|' + uid, pli: true };
    return { type, uid, key: uid + '|' + attr(xml, 'time'), pli: false };
  }
  // only live content: a server sends its whole picture again on every (re)connection – that must not flood LoRa.
  // Recognised by the moment it arrives (first seconds after connecting, eud.js) – not by the time in the CoT, the clock of a
  // WinTAK PC may be off by minutes; only really old content (> 15 min) is left out by its time.
  const LIVE_MS = 15 * 60000;
  const live = xml => { const t = Date.parse(attr(xml, 'time')); return !t || Math.abs(Date.now() - t) < LIVE_MS; };
  const seenIn = (map, k) => { const t = map.get(k.key); return t != null && Date.now() - t < (k.pli ? PLI_SAME_MS : SEEN_MS); };
  // random wait: the server is fast (1–6 s), LoRa is slow and shared (2–12 s) – the first gateway passes it on,
  // the others hear it meanwhile and stay quiet
  const jitter = (min, max) => sleep(min + Math.random() * (max - min));
  const marked = xml => (/<detail\s*\/>/.test(xml) ? xml.replace(/<detail\s*\/>/, `<detail><${MARK}/></detail>`)
    : xml.includes('</detail>') ? xml.replace(/<\/detail>(?![\s\S]*<\/detail>)/, `<${MARK}/></detail>`) : xml.replace(/<\/event>\s*$/, `<detail><${MARK}/></detail></event>`));

  function fromMesh(xml) {
    handleCot(xml);
    const k = bridgeKey(xml);
    if (!k) return;
    seenMesh.set(k.key, Date.now());
    bridgeUp(xml, k).catch(() => {});
  }
  document.addEventListener('eud-cot-in', e => {
    const k = bridgeKey(e.detail.xml);
    if (!k) return;
    seenServer.set(k.key, Date.now());
    if (!e.detail.replay) bridgeDown(e.detail.xml, k).catch(() => {});
  });

  // a direct message over LoRa for another device (e.g. one that is only online, or whose radio is off): to the TAK
  // server, addressed to that device alone (<marti><dest>) – the recipient drops copies by the message UID
  function directUp(xml, to) {
    const k = bridgeKey(xml);
    if (!k) return;
    seenMesh.set(k.key, Date.now());
    const it = window.eud.items.get(to);
    const call = it && it.c && it.c.callsign;
    const dest = `<marti><dest ${call ? `callsign="${window.eud.esc(call)}"` : `uid="${window.eud.esc(to)}"`}/></marti>`;
    bridgeUp(xml.replace('</detail>', dest + '</detail>'), k, true).catch(() => {});
  }

  async function bridgeUp(xml, k, direct = false) {
    if (!cfg.bridge || xml.includes('<' + MARK) || !live(xml)) return; // came from the server through another gateway / old
    if (k.type === 'a-f-G-E-S' || k.uid.startsWith('MESH-')) return; // plain Meshtastic, not TAK
    if (k.type === 'b-t-f' && !direct && !xml.includes('.' + P.ALL_CHAT + '.')) return; // direct message to us: not for the server
    if (pendingUp.has(k.key)) return;
    pendingUp.add(k.key);
    await jitter(1000, 6000);
    pendingUp.delete(k.key);
    if (!window.eud.serverOnline() || seenIn(seenServer, k)) return; // the TAK server has it already
    seenServer.set(k.key, Date.now());
    window.eud.forwardCot(marked(xml));
  }

  let downChain = Promise.resolve(), downQueued = 0;
  async function bridgeDown(xml, k) {
    if (!cfg.bridge || xml.includes('<' + MARK) || !live(xml)) return; // came from the mesh through a gateway / old
    if (k.uid === profile.uid || k.uid.startsWith('GeoChat.' + profile.uid + '.')) return; // own: sent over LoRa already
    const chat = k.type === 'b-t-f';
    if (chat && !xml.includes('.' + P.ALL_CHAT + '.')) return; // team/group/direct chat: not over LoRa (like the plugin)
    if (!chat && !k.pli && !/^(a-|b-m-|u-d-|u-rb-a|t-x-d-d)/.test(k.type)) return; // pings, missions, files …
    if (k.pli) {
      if (Date.parse(attr(xml, 'stale')) < Date.now()) return;
      const last = pliDown.get(k.uid);
      if (last && Date.now() - last < PLI_DOWN_MS) return;
    }
    if (pendingDown.has(k.key)) return;
    pendingDown.add(k.key);
    await jitter(2000, 12000);
    if (state !== 'connected' || seenIn(seenMesh, k) || downQueued > 20) { pendingDown.delete(k.key); return; } // the mesh has it already / LoRa full
    if (k.pli) pliDown.set(k.uid, Date.now());
    downQueued++;
    downChain = downChain.then(() => {
      pendingDown.delete(k.key);
      if (seenIn(seenMesh, k)) return null; // another gateway was quicker while this waited in the queue
      seenMesh.set(k.key, Date.now());
      return sendDown(xml, k);
    }).catch(() => {}).then(() => { downQueued--; return sleep(3000); });
  }

  // for LoRa only what a TAK client needs to show the item: WinTAK/ATAK and the TAK server add a lot
  // (flow tags, creator copy, precision, status …) – a WinTAK marker shrinks from ~585 to ~250 bytes (zlib)
  const KEEP = new Set(['contact', 'link', 'remarks', 'color', 'usericon', '__milsym', 'archive', 'strokeColor', 'strokeWeight', 'fillColor',
    'shape', 'labels_on', 'closed', 'height', 'height_unit', 'range', 'bearing', 'inclination', 'rangeUnits', 'bearingUnits', 'northRef', '__group', 'track']);
  function slimCot(xml) {
    const doc = new DOMParser().parseFromString(xml.replace(/^<\?xml[^>]*>\s*/, ''), 'application/xml');
    const ev = doc.documentElement;
    if (!ev || ev.nodeName !== 'event') return xml;
    ev.removeAttribute('access');
    const pt = ev.querySelector(':scope > point');
    if (pt) for (const a of ['lat', 'lon']) pt.setAttribute(a, Number(pt.getAttribute(a)).toFixed(6));
    if (pt && Number(pt.getAttribute('hae')) < 9e6) pt.setAttribute('hae', String(Math.round(Number(pt.getAttribute('hae')))));
    const det = ev.querySelector(':scope > detail');
    if (det) {
      for (const c of [...det.children]) if (!KEEP.has(c.nodeName)) c.remove();
      for (const l of det.querySelectorAll(':scope > link[relation="p-p"]')) l.removeAttribute('production_time');
      const r = det.querySelector(':scope > remarks');
      if (r) { for (const a of [...r.attributes]) r.removeAttribute(a.name); if (r.textContent.length > 200) r.textContent = r.textContent.slice(0, 200); }
      const arch = det.querySelectorAll(':scope > archive');
      for (let i = 1; i < arch.length; i++) arch[i].remove();
    }
    return new XMLSerializer().serializeToString(ev);
  }

  function sendDown(xml, k) {
    if (state !== 'connected') return null;
    if (window.__meshTest) { (window.__meshTest.down = window.__meshTest.down || []).push(k.uid); (window.__meshTest.air = window.__meshTest.air || []).push(k.pli || k.type === 'b-t-f' ? xml : marked(xml)); }
    if (!k.pli && k.type !== 'b-t-f') return sendCotMesh(marked(slimCot(xml)), { quick: true }); // markers, drawings, deletions: port 257 like the plugin
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const q = sel => doc.querySelector(sel);
    const a = (sel, n) => (q(sel) ? q(sel).getAttribute(n) : null);
    if (k.type === 'b-t-f') {
      const sender = a('__chat', 'senderCallsign') || '';
      const senderUid = a('link', 'uid') || k.uid.split('.')[1] || '';
      return send(P.PORT.ATAK, P.takChat({ callsign: sender, uid: senderUid, msgId: a('__chat', 'messageId') || k.uid.split('.').pop(), message: fit(q('remarks') ? q('remarks').textContent : ''), to: P.ALL_CHAT }));
    }
    const num = n => (Number.isFinite(Number(n)) ? Number(n) : null);
    return send(P.PORT.ATAK, P.takPli({
      callsign: a('contact', 'callsign') || k.uid, uid: k.uid, team: a('__group', 'name'), role: a('__group', 'role'), battery: num(a('status', 'battery')),
      lat: num(a('point', 'lat')), lon: num(a('point', 'lon')), alt: num(a('point', 'hae')) < 9e6 ? num(a('point', 'hae')) : null,
      speed: num(a('track', 'speed')), course: num(a('track', 'course')),
    }));
  }
  setInterval(() => { const t = Date.now() - SEEN_MS; for (const m of [seenServer, seenMesh]) for (const [k, v] of m) if (v < t) m.delete(k); }, 60000);

  // ---------------- Voice messages (Codec 2) over LoRa, port 256 ----------------
  // voice.js records and encodes; here the packets go out with a pause between them (airtime), missing ones are asked
  // for again; a gateway with internet also puts the message on the TAK server (recording + chat link).
  const voiceAsm = new P.VoiceAssembler();
  const voiceOut = new Map(); // id -> { packets, at } (for requests of missing packets)
  let voiceChain = Promise.resolve();
  function sendVoicePackets(list) {
    voiceChain = voiceChain.then(async () => {
      for (const pk of list) {
        if (state !== 'connected') return;
        if (window.__meshTest) (window.__meshTest.voice = window.__meshTest.voice || []).push(pk);
        await send(P.PORT.PRIVATE, pk);
        await sleep(window.__meshTest ? 50 : BLOCK_GAP);
      }
    }).catch(e => msg('Voice message over LoRa: ' + e.message));
    return voiceChain;
  }
  window.eudMesh = {
    canSend: () => shouldSend(),
    // without the TAK server a voice message is sent by hand: the radio only has to be connected (send setting aside)
    connected: () => state === 'connected',
    state: () => state,
    // to: '' = all, otherwise the UID of the recipient; id = the GeoChat messageId (16 hex)
    sendVoice({ id, to = '', bits, ms }) {
      const packets = P.voicePackets({ id, from: profile.uid, callsign: profile.callsign || profile.uid, to, ms, bits });
      voiceOut.set(id, { packets, at: Date.now() });
      return sendVoicePackets(packets);
    },
  };
  function receiveVoice(p) {
    const v = P.parseVoice(p.payload);
    if (!v) return;
    if (v.kind === 1) { // somebody misses packets of our message
      const o = voiceOut.get(v.id);
      if (o) sendVoicePackets([...v.data].filter(i => o.packets[i]).map(i => o.packets[i]));
      return;
    }
    const m = voiceAsm.add(v);
    if (!m || m.from === profile.uid) return;
    if (!m.to || m.to === profile.uid) document.dispatchEvent(new CustomEvent('eud-voice-in', { detail: m }));
    if (m.to !== profile.uid) voiceUp(m).catch(e => msg('Voice message to the TAK server: ' + e.message));
  }
  setInterval(() => {
    if (state !== 'connected') return;
    for (const st of voiceAsm.stale()) send(P.PORT.PRIVATE, P.voiceRequest(st.id, st.missing)).catch(() => {});
    for (const [id, o] of voiceOut) if (Date.now() - o.at > 10 * 60000) voiceOut.delete(id);
  }, 5000);
  // gateway: decoded, uploaded as a recording, and the chat message with the link to the TAK server (like bridgeUp)
  async function voiceUp(m) {
    if (!cfg.bridge || !window.eud.serverOnline() || !window.Codec2 || !window.TakVoice) return;
    const uid = `GeoChat.${m.from}.${m.to || P.ALL_CHAT}.${m.id}`;
    const k = { type: 'b-t-f', uid, key: 'c|' + uid, pli: false };
    if (pendingUp.has(k.key)) return;
    pendingUp.add(k.key);
    await jitter(1000, 6000);
    pendingUp.delete(k.key);
    if (!window.eud.serverOnline() || seenIn(seenServer, k)) return; // another gateway was quicker
    seenServer.set(k.key, Date.now());
    const pcm = await window.Codec2.decode(m.bits, m.mode);
    const res = await fetch('/api/eud/voicemsg', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: window.TakVoice.wav(pcm) });
    if (!res.ok) throw new Error('upload ' + res.status);
    const { url } = await res.json();
    const secs = Math.round(m.ms / 1000);
    const xml = P.chatCot({ senderUid: m.from, senderCallsign: m.callsign, msgId: m.id, text: `🎤 Voice message ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} ${url}`, toUid: m.to });
    let out = marked(xml);
    if (m.to) {
      const it = window.eud.items.get(m.to);
      const call = it && it.c && it.c.callsign;
      out = out.replace('</detail>', `<marti><dest ${call ? `callsign="${window.eud.esc(call)}"` : `uid="${window.eud.esc(m.to)}"`}/></marti></detail>`);
    }
    window.eud.forwardCot(out);
  }

  // automated tests only (set before the page loads): a fake radio
  if (window.__meshTest) {
    window.__meshTest.api = {
      fromMesh, slimCot, handle, receiveVoice, connect(sent) { toRadio = { writeValue: async b => { sent.push(b); } }; state = 'connected'; },
    };
  }

  setInterval(() => { for (const [k, st] of receiving) if (Date.now() - st.t > 300000) receiving.delete(k); }, 60000);

  // ---------------- Video: release the radio while streaming, reconnect afterwards ----------------

  document.addEventListener('eud-video', e => {
    if (!cfg.enabled) return;
    if (e.detail.on) {
      if (pausedForVideo) return;
      pausedForVideo = true;
      disconnect();
      setState('paused');
    } else if (pausedForVideo) {
      pausedForVideo = false;
      retry = 0;
      open();
    }
  });

  // ---------------- Settings ----------------

  const popupOpen = () => !$('popup').classList.contains('hidden') && document.querySelector('.mbody section.on[data-sec="mesh"]');

  // known radio: reconnect; after a reload without permission (or a new radio): the browser's device dialog
  $('meshPick').addEventListener('click', () => {
    if (ON_RADIO) { // the radio that serves this page, over WLAN
      disconnect();
      Object.assign(cfg, { enabled: true, transport: 'http', http: '' });
      save();
      retry = 0;
      return open();
    }
    if (cfg.transport === 'http') { cfg.transport = 'ble'; save(); }
    if (!device) return pick();
    cfg.enabled = true;
    save();
    retry = 0;
    open();
  });
  $('meshNew').addEventListener('click', () => { cfg.transport = 'ble'; save(); pick(); });
  // a radio over WLAN (its own web server, e.g. on the phone's hotspot): https://<address> – the browser must have
  // accepted the radio's certificate once (open the address in a tab)
  $('meshWlanGo').addEventListener('click', () => {
    let u = $('meshHttp').value.trim();
    if (!u) return msg('Enter the address of the radio, e.g. https://192.168.43.20');
    if (!/^https?:\/\//i.test(u)) u = (location.protocol === 'https:' ? 'https://' : 'http://') + u;
    if (location.protocol === 'https:' && /^http:/i.test(u)) return msg('This page is https – the radio must be opened with https:// too.');
    disconnect();
    Object.assign(cfg, { enabled: true, transport: 'http', http: u, name: 'WLAN ' + new URL(u).host });
    save();
    retry = 0;
    open();
  });
  $('meshOff').addEventListener('click', () => {
    cfg.enabled = false;
    save();
    pausedForVideo = false;
    disconnect();
    setState('off');
    toast('Meshtastic disconnected.');
  });
  $('meshSend').addEventListener('change', () => { cfg.send = $('meshSend').value === 'always' ? 'always' : 'offline'; cfg.sendChosen = true; save(); lastPli = 0; render(); });
  $('meshInterval').addEventListener('change', () => { cfg.interval = Number($('meshInterval').value) || 60; save(); });
  $('meshChannel').addEventListener('change', () => { cfg.channel = Number($('meshChannel').value) || 0; save(); });
  $('meshShowNodes').addEventListener('change', () => {
    cfg.nodes = $('meshShowNodes').checked;
    save();
    if (cfg.nodes) for (const num of nodes.keys()) showNode(num);
    else for (const num of nodes.keys()) removeItem('MESH-' + P.nodeId(num));
  });
  $('meshText').addEventListener('change', () => { cfg.text = $('meshText').checked; save(); });
  $('meshBridge').addEventListener('change', () => { cfg.bridge = $('meshBridge').checked; save(); });
  $('meshBluefy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied – open it in Bluefy.'); } catch (e) { toast(location.href, 8000); }
  });
  $('meshBtn').addEventListener('click', () => openPopup('mesh'));
  window.eudMeshReady = true; // the page checks that this part loaded (the radio's web server can drop files)
  document.addEventListener('eud-popup', e => { if (e.detail === 'mesh') { msg(''); render(); } });

  render();
  if (cfg.enabled) open();
})();
