// Admin → Meshtastic: flash Meshtastic firmware (also the TAKweb firmware) from the server's library (lib/firmware.js)
// over USB – Web Serial + esptool-js (Espressif, Apache-2.0), like flasher.meshtastic.org. ESP32 radios only;
// nRF52/RP2040 radios get their .uf2 file to download.
import { ESPLoader, Transport } from '/eud/vendor/esptool.js';

let logTo = 'fwLog'; // the log of the card in use (setup or advanced)
const log = t => { const l = $(logTo); l.classList.remove('hidden'); l.textContent += t; l.scrollTop = l.scrollHeight; };
const bar = p => { $('fwBar').classList.remove('hidden'); $('fwFill').style.width = Math.round(p) + '%'; };
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const hex = n => '0x' + n.toString(16);
let versions = [];
let busy = false;

const curVersion = () => versions.find(v => v.key === $('fwVer').value);
const curDevice = () => { const v = curVersion(); return v && v.devices.find(d => d.id === $('fwDev').value); };

function fillVersions(keep) {
  fillSetup();
  const sel = $('fwVer');
  sel.textContent = '';
  if (!versions.length) sel.append(new Option('– library empty: load firmware below –', ''));
  for (const v of versions) sel.append(new Option(`${v.version}${v.channel ? ' (' + v.channel + ')' : ''} – ${v.devices.length} devices`, v.key));
  // TAKweb firmware first
  const tw = versions.find(v => /takweb/i.test(v.key));
  sel.value = keep && versions.some(v => v.key === keep) ? keep : (tw ? tw.key : (versions[0] || {}).key || '');
  fillDevices();
}
function fillDevices() {
  const v = curVersion(), sel = $('fwDev'), q = $('fwFind').value.trim().toLowerCase(), keep = sel.value;
  sel.textContent = '';
  for (const d of (v ? v.devices : []).filter(d => !q || (d.name + ' ' + d.target + ' ' + d.chip).toLowerCase().includes(q))) {
    sel.append(new Option(`${d.name} – ${d.chip}${d.esp ? '' : ' (download only)'}`, d.id));
  }
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  showDevice();
}
function showDevice() {
  const v = curVersion(), d = curDevice(), info = $('fwInfo');
  info.textContent = '';
  if (!d) return;
  info.append(`${d.target} · ${d.chip} · ${mb(d.size)} · files: `);
  d.files.forEach((f, i) => {
    const a = document.createElement('a');
    a.href = `/api/admin/firmware/file/${encodeURIComponent(v.key)}/${encodeURIComponent(f.name)}`;
    a.textContent = f.name;
    a.download = f.name;
    info.append(i ? ', ' : '', a);
  });
  $('fwGo').disabled = !d.esp;
  if (!d.esp) info.append(' – not an ESP32: download the .uf2 and copy it onto the radio (double-tap reset → USB drive).');
}
let loading = null;
async function load(keep) {
  loading = (async () => {
    try { versions = (await api('firmware')).versions; } catch (e) { versions = []; setMsg($('fwMsg'), e.message); }
    fillVersions(keep);
  })();
  return loading;
}
const afterLoad = fn => setTimeout(() => Promise.resolve(loading).then(fn), 0);
document.addEventListener('admin-view', e => { if (e.detail === 'mesh') load($('fwVer').value); });
$('fwVer').addEventListener('change', fillDevices);
$('fwDev').addEventListener('change', showDevice);
$('fwFind').addEventListener('input', fillDevices);

// write files onto an ESP32 over USB (esptool-js); -> chip name. progress(0..100)
async function espFlash({ port, files, eraseAll, baud, chip, progress = () => {}, say = () => {} }) {
  const transport = new Transport(port, false);
  try {
    const terminal = { clean() {}, writeLine: t => log(t + '\n'), write: t => log(t) };
    const loader = new ESPLoader({ transport, baudrate: baud, terminal, debugLogging: false });
    say('Connecting to the radio … (if nothing happens: hold BOOT, tap RESET, release BOOT)');
    const chipText = await loader.main();
    const found = String(loader.chip.CHIP_NAME || '').replace(/-/g, '').toLowerCase();
    log(`\nChip: ${chipText}\n`);
    if (found && chip && found !== chip) throw new Error(`This radio has an ${loader.chip.CHIP_NAME} chip – choose the matching radio (this firmware is for ${chip}).`);
    const total = files.reduce((n, x) => n + x.data.length, 0);
    const before = files.map((x, i) => files.slice(0, i).reduce((n, y) => n + y.data.length, 0));
    for (const x of files) log(`${hex(x.address)}: ${x.data.length} bytes\n`);
    say(eraseAll ? 'Erasing and writing …' : 'Writing …');
    await loader.writeFlash({
      fileArray: files, flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep', eraseAll, compress: true,
      reportProgress: (i, written, size) => progress(100 * (before[i] + written * files[i].data.length / size) / total),
    });
    await loader.after('hard_reset');
    return found;
  } finally {
    try { await transport.disconnect(); } catch (e) { /* gone */ }
  }
}

// 1200 bps reset (like the Meshtastic web flasher): open at 1200 baud and drop DTR – many radios go into boot mode
async function touch1200(port) {
  try {
    await port.open({ baudRate: 1200 });
    await port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  } finally {
    try { await port.close(); } catch (e) { /* gone */ }
  }
}
async function bootMode(say) {
  if (!('serial' in navigator)) return say('This browser cannot reach USB radios – use Chrome or Edge on a PC.', false);
  let port;
  try { port = await navigator.serial.requestPort(); } catch (e) { return; }
  try {
    await touch1200(port);
    say('1200 bps reset sent – the radio should be in boot mode now. Press the flash button again (choose the port again if it changed).', true);
  } catch (e) { say('1200 bps reset not possible: ' + (e.message || e) + '. Hold BOOT / USR while plugging in the USB cable instead.', false); }
}
$('fwBoot').addEventListener('click', () => bootMode((t, ok) => setMsg($('fwMsg'), t, ok)));

async function fileOf(key, name) {
  const r = await fetch(`/api/admin/firmware/file/${encodeURIComponent(key)}/${encodeURIComponent(name)}`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(name + ': ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

$('fwGo').addEventListener('click', async () => {
  const v = curVersion(), d = curDevice();
  if (busy || !d || !d.esp) return;
  if (!('serial' in navigator)) return setMsg($('fwMsg'), 'This browser cannot reach USB devices – use Chrome or Edge on a PC.');
  const full = document.querySelector('input[name="fwMode"]:checked').value === 'full';
  if (full && !d.flash.factory) return setMsg($('fwMsg'), 'This device has no factory image for a full install – use Update.');
  if (!confirm(`${d.name}\nFirmware ${v.version}\n\n${full ? 'FULL INSTALL – the flash is erased (settings, nodes and keys are lost).' : 'Update – settings stay.'}\n\nFlash now?`)) return;
  let port;
  try { port = await navigator.serial.requestPort(); } catch (e) { return; } // dialog closed
  busy = true;
  logTo = 'fwLog';
  $('fwGo').disabled = true;
  $('fwLog').textContent = '';
  bar(0);
  try {
    setMsg($('fwMsg'), 'Loading the firmware …', true);
    const f = d.flash, files = [];
    if (full) {
      files.push({ address: 0, data: await fileOf(v.key, f.factory) });
      if (f.ota && f.otaOff != null) files.push({ address: f.otaOff, data: await fileOf(v.key, f.ota) });
      if (f.littlefs && f.fsOff != null) files.push({ address: f.fsOff, data: await fileOf(v.key, f.littlefs) });
    } else if (f.app) {
      files.push({ address: f.appOff, data: await fileOf(v.key, f.app) });
    } else { // only the factory image: its app part
      files.push({ address: f.appOff, data: (await fileOf(v.key, f.factory)).slice(f.appOff) });
    }
    await espFlash({ port, files, eraseAll: full, baud: Number($('fwBaud').value), chip: d.chip, progress: bar, say: t => setMsg($('fwMsg'), t, true) });
    bar(100);
    setMsg($('fwMsg'), /takweb/i.test(v.key)
      ? 'Done. The radio restarts and opens the WLAN "TAKweb" (password 12345678): connect the phone and open https://takweb.local (or https://192.168.4.1), accept the certificate once.'
      : `Done – ${d.name} runs Meshtastic ${v.version}.${full ? ' After a full install set the LoRa region (TAKweb: Meshtastic panel → SET REGION).' : ''}`, true);
  } catch (e) {
    setMsg($('fwMsg'), 'Not flashed: ' + (e.message || e));
    log('\nError: ' + (e.message || e) + '\n');
  } finally {
    busy = false;
    $('fwGo').disabled = false;
  }
});

// ---- library
$('fwRelList').addEventListener('click', async () => {
  setMsg($('fwLibMsg'), 'Asking GitHub …', true);
  try {
    const { releases } = await api('firmware/releases');
    const sel = $('fwRel');
    sel.textContent = '';
    releases.sort((a, b) => (b.takweb - a.takweb) || String(b.published).localeCompare(String(a.published)));
    for (const r of releases) sel.append(new Option(`${r.name} – ${r.assets.map(a => a.chip).join(', ')}`, r.tag));
    setMsg($('fwLibMsg'), releases.length + ' releases.', true);
  } catch (e) { setMsg($('fwLibMsg'), e.message); }
});
$('fwRelGet').addEventListener('click', async () => {
  const tag = $('fwRel').value;
  if (!tag) return setMsg($('fwLibMsg'), 'Load the list and choose a release first.');
  setMsg($('fwLibMsg'), 'Downloading into the library … (can take a minute)', true);
  try {
    const r = await api('firmware/fetch', { method: 'POST', body: { tag, chips: $('fwChips').value ? $('fwChips').value.split(',') : [] } });
    versions = r.versions;
    fillVersions(r.imported[0] && r.imported[0].key);
    setMsg($('fwLibMsg'), 'In the library: ' + r.imported.map(x => x.version).join(', '), true);
  } catch (e) { setMsg($('fwLibMsg'), e.message); }
});
$('fwZipBtn').addEventListener('click', () => $('fwZip').click());
$('fwZip').addEventListener('change', async () => {
  const file = $('fwZip').files[0];
  $('fwZip').value = '';
  if (!file) return;
  setMsg($('fwLibMsg'), `Uploading ${file.name} (${mb(file.size)}) …`, true);
  try {
    const res = await fetch('/api/admin/firmware', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'helm', 'Content-Type': 'application/zip' }, body: file });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || 'Error ' + res.status);
    versions = r.versions;
    fillVersions(r.imported[0].key);
    setMsg($('fwLibMsg'), `Imported: ${r.imported[0].version} (${r.imported[0].files} files)`, true);
  } catch (e) { setMsg($('fwLibMsg'), e.message); }
});
$('fwDel').addEventListener('click', async () => {
  const v = curVersion();
  if (!v || !confirm(`Delete firmware ${v.version} from the library?`)) return;
  try { versions = (await api('firmware/' + encodeURIComponent(v.key), { method: 'DELETE' })).versions; fillVersions(); setMsg($('fwLibMsg'), 'Deleted.', true); } catch (e) { setMsg($('fwLibMsg'), e.message); }
});

// ---------------- Set up a radio with TAKweb – one step ----------------
// TAKweb firmware (factory image + file system with TAKweb) over USB, then the mesh channel of the OTS over the
// radio's serial API – everything a new radio needs. Afterwards: phone → WLAN "TAKweb" → https://takweb.local
const P = window.meshProto, MI = window.MeshInstall;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const suBar = p => { $('suBar').classList.remove('hidden'); $('suFill').style.width = Math.round(p) + '%'; };
const suSay = (t, ok = true) => setMsg($('suMsg'), t, ok);
const takwebVersion = () => versions.find(v => /takweb/i.test(v.key) && v.devices.some(d => d.esp && d.flash.factory));
const radioName = d => d.name.replace(/\s*[–-]\s*TAKweb-WLAN$/i, '');

function fillSetup() {
  const v = takwebVersion(), sel = $('suDev');
  let keep = sel.value;
  try { keep = keep || localStorage.getItem('takweb.suDev') || ''; } catch (e) { /* none */ }
  sel.textContent = '';
  $('suLoad').classList.toggle('hidden', !!v);
  $('suGo').disabled = !v;
  if (!v) {
    sel.append(new Option('– load the TAKweb firmware first (below) –', ''));
    $('suNote').textContent = 'This server has no TAKweb firmware yet: load it once from GitHub (the server needs internet for that) or import the firmware file.';
    return;
  }
  const devs = v.devices.filter(d => d.esp && d.flash.factory).sort((a, b) => radioName(a).localeCompare(radioName(b)));
  for (const d of devs) sel.append(new Option(radioName(d), d.target));
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  $('suNote').textContent = `TAKweb firmware ${v.version} · Seeed XIAO ESP32-S3, Heltec, T-Beam, LilyGo …`;
}
$('suDev').addEventListener('change', () => { try { localStorage.setItem('takweb.suDev', $('suDev').value); } catch (e) { /* none */ } });

async function loadSetupChannels() {
  const sel = $('suChan'), keep = sel.value;
  let chans = [];
  try { chans = ((await api('ots/mesh')).channels || []).filter(c => c.url); } catch (e) { /* no OTS */ }
  sel.replaceChildren(...chans.map(c => new Option(`${c.name || '(no name)'}${c.modem_preset ? ' · ' + c.modem_preset : ''}`, c.url)),
    new Option('public default channel (LongFast)', ''));
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
}
// the TAK user that goes onto the radio: its user then only types a name – login and certificate come by themselves
async function loadSetupUsers() {
  const sel = $('suUser'), keep = sel.value;
  let r = { ots: false, users: [] };
  try { r = await api('mesh-users'); } catch (e) { /* none */ }
  sel.replaceChildren(...(r.ots ? [new Option('new user for this radio (automatic)', 'new')] : []),
    ...r.users.map(u => new Option(`${u.callsign} (${u.username})`, u.id)), new Option('none – the user logs in himself', ''));
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
}
// MQTT of the OTS for the radios (address editable; the login is a TAKweb-made OTS user, not the admin's)
let mqttInfo = { address: '' };
async function loadSetupMqtt() {
  try { mqttInfo = await api('mesh-mqtt'); } catch (e) { mqttInfo = { ots: false, error: e.message }; }
  $('suMqtt').disabled = !mqttInfo.ots;
  if (!mqttInfo.ots) $('suMqtt').checked = false;
  if (mqttInfo.address && !$('suMqttAddr').value) $('suMqttAddr').value = mqttInfo.address;
  $('suMqttAddr').classList.toggle('hidden', !$('suMqtt').checked);
}
$('suMqtt').addEventListener('change', () => $('suMqttAddr').classList.toggle('hidden', !$('suMqtt').checked));
$('suRole').addEventListener('change', () => $('suGwRow').classList.toggle('hidden', $('suRole').value !== 'gateway'));
document.addEventListener('admin-view', e => { if (e.detail === 'mesh') { loadSetupChannels(); loadSetupUsers(); loadSetupMqtt(); afterLoad(autoFirmware); } });

// the newest TAKweb firmware from GitHub into the library – by itself when the library has none or an older build
const CHIPS = ['esp32s3', 'esp32'];
let autoTried = false;
async function fetchTakweb(auto) {
  const { releases } = await api('firmware/releases');
  const rel = releases.filter(r => r.takweb).sort((a, b) => String(b.published).localeCompare(String(a.published)))[0];
  if (!rel) throw new Error('No TAKweb firmware on GitHub yet – import the firmware file instead.');
  const have = takwebVersion();
  const fresh = have && have.release && have.release.tag === rel.tag &&
    rel.assets.filter(a => CHIPS.includes(a.chip)).every(a => have.release.assets && have.release.assets[a.chip] === a.updated);
  if (auto && fresh) return false;
  suSay(have ? 'Loading the newer TAKweb firmware … (about a minute)' : 'Loading the TAKweb firmware once … (about a minute)');
  $('suGo').disabled = true;
  const r = await api('firmware/fetch', { method: 'POST', body: { tag: rel.tag, chips: CHIPS } });
  versions = r.versions;
  fillVersions();
  suSay('TAKweb firmware ready. Choose the radio and press the button.');
  return true;
}
async function autoFirmware() {
  if (autoTried || busy) return;
  autoTried = true;
  try { await fetchTakweb(true); } catch (e) { if (!takwebVersion()) suSay(e.message + ' – or import the firmware file.', false); }
  fillSetup();
}
$('suFetch').addEventListener('click', async () => {
  $('suFetch').disabled = true;
  try { await fetchTakweb(false); } catch (e) { suSay(e.message, false); }
  $('suFetch').disabled = false;
});
$('suImport').addEventListener('click', () => $('fwZip').click());
$('suBoot').addEventListener('click', () => bootMode(suSay));

// the same radio again after its restart (USB radios with their own USB, e.g. XIAO ESP32-S3, reconnect as a new port)
async function radioPortAgain(old, info, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ports = [old, ...(await navigator.serial.getPorts()).filter(p => p !== old)];
    for (const p of ports) {
      const i = p.getInfo();
      if (p !== old && (i.usbVendorId !== info.usbVendorId || i.usbProductId !== info.usbProductId)) continue;
      try { await p.open({ baudRate: 115200 }); await p.close(); return p; } catch (e) { /* not there yet */ }
    }
    await sleep(1500);
  }
  throw new Error('The radio did not come back on USB.');
}

// after the flash, over the radio's serial API (Meshtastic runs now; waits for its first start): the address of this
// TAKweb server (the radio page offers "TAKweb online" with it) and the mesh channel
async function finishRadio(port, url, server, invite, ap, net = {}) {
  let inst = null;
  const link = new MI.SerialLink(port, frame => { try { inst.feed(P.parseFromRadio(frame)); } catch (e) { /* not for us */ } });
  inst = new MI.RadioInstaller({ P, send: b => link.send(b), log: t => log(t + '\n') });
  await link.open();
  try {
    let st = null;
    for (let t = 0; t < 4 && !st; t++) { try { st = await inst.readState(); } catch (e) { log('Radio still starting …\n'); await sleep(3000); } }
    if (!st) throw new Error('The radio does not answer – it may still be starting. The firmware is on it; set the channel later in TAKweb (Meshtastic → Channel from a link).');
    if (!st.files.some(f => /static\/index\.html\.gz$/.test(f.name))) log('Warning: TAKweb pages not found on the radio.\n');
    if (server) {
      await inst.put('/static/takweb-server.json', new TextEncoder().encode(JSON.stringify(invite ? { server, invite } : { server })));
      log(`TAKweb server on the radio: ${server}${invite ? ' (with the TAK user)' : ''}\n`);
    }
    // the radio's own WLAN: the name the admin chose, otherwise TAKweb-<last 4 of the MAC> (= of the node number)
    const ssid = ap.ssid || 'TAKweb-' + (st.node & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    await inst.put('/prefs/takweb-ap.txt', new TextEncoder().encode(`${ssid}\n${ap.psk}\n`));
    log(`WLAN of the radio: ${ssid}${ap.psk ? '' : ' (open)'}\n`);
    let names = [];
    if (!url && inst.lora) { // crisis radios always send (a channel link sets it with its LoRa settings)
      await link.send(P.adminSetLora(st.node, inst.lora, inst.region));
      log('Duty-cycle override on (the radio always sends)\n');
      await sleep(300);
    }
    if (url) {
      const r = P.applyChannelUrl(st.node, url, { region: inst.region > 0 ? inst.region : P.REGIONS.EU_868 });
      for (const pkt of r.packets) { await link.send(pkt); await sleep(300); }
      log(`Channel set: ${r.names.join(', ')}\n`);
      names = r.names;
    }
    // GPS on, position every 2 min (moving: sooner) – the radio reports itself, also without a phone
    await link.send(P.adminSetPosition(st.node, inst.position, { secs: net.gateway ? 900 : 120 }));
    log('GPS on, position every ' + (net.gateway ? '15 min' : '2 min') + ' (board pins)\n');
    await sleep(300);
    if (net.mqtt) { // the mesh to the server: every radio that has internet passes positions and messages on
      await link.send(P.adminSetMqtt(st.node, net.mqtt));
      log(`MQTT to the server: ${net.mqtt.address} (${net.mqtt.username})\n`);
      await sleep(300);
    }
    if (net.gateway) { // HQ gateway: internet over the HQ WLAN (its own WLAN stays)
      await link.send(P.adminSetWifi(st.node, inst.network, { ssid: net.gateway.ssid, psk: net.gateway.psk }));
      log(`Internet WLAN of the gateway: ${net.gateway.ssid}\n`);
      await sleep(300);
    }
    await sleep(800);
    await link.send(P.adminReboot(st.node, 2)); // the new WLAN name/password take effect after the restart
    return { names, ssid, node: st.node };
  } finally { await link.close(); }
}

$('suGo').addEventListener('click', async () => {
  const v = takwebVersion();
  const d = v && v.devices.find(x => x.target === $('suDev').value);
  if (busy || !d) return;
  if (!('serial' in navigator)) return suSay('This browser cannot reach USB radios – use Chrome or Edge on a PC.', false);
  if ($('suRole').value === 'gateway' && !$('suGwSsid').value.trim()) return suSay('The HQ gateway needs the HQ WLAN (internet) name.', false);
  if ($('suMqtt').checked && !$('suMqtt').disabled && !$('suChan').value) return suSay('For MQTT choose the mesh channel of the OTS (its link has the uplink to the server).', false);
  if ($('suPsk').value && $('suPsk').value.length < 8) return suSay('The WLAN password needs at least 8 characters (or leave it empty for an open WLAN).', false);
  if (new TextEncoder().encode($('suSsid').value.trim()).length > 32) return suSay('The WLAN name may have at most 32 characters.', false);
  if (!confirm(`${radioName(d)} is set up new: Meshtastic, TAKweb and the mesh channel. Its old settings and nodes are replaced.\n\nConnect the radio with a USB data cable, then press OK and choose it in the list.`)) return;
  let port;
  try { port = await navigator.serial.requestPort(); } catch (e) { return; } // list closed
  const info = port.getInfo(), chan = $('suChan').value;
  const ap = { ssid: $('suSsid').value.trim(), psk: $('suPsk').value };
  const gateway = $('suRole').value === 'gateway' ? { ssid: $('suGwSsid').value.trim(), psk: $('suGwPsk').value } : null;
  const wantMqtt = $('suMqtt').checked && !$('suMqtt').disabled;
  busy = true;
  logTo = 'suLog';
  $('suGo').disabled = true;
  $('suLog').textContent = '';
  suBar(0);
  try {
    suSay('Loading the firmware …');
    const f = d.flash, files = [{ address: 0, data: await fileOf(v.key, f.factory) }];
    if (f.ota && f.otaOff != null) files.push({ address: f.otaOff, data: await fileOf(v.key, f.ota) });
    if (f.littlefs && f.fsOff != null) files.push({ address: f.fsOff, data: await fileOf(v.key, f.littlefs) });
    suBar(3);
    // the file system image holds TAKweb – it also replaces the old settings (no slow full erase needed)
    let tries = 0;
    for (;;) {
      try {
        await espFlash({ port, files, eraseAll: false, baud: tries ? 115200 : 460800, chip: d.chip, progress: p => suBar(3 + p * 0.8), say: t => suSay(t) });
        break;
      } catch (e) {
        if (tries++ || /chip/.test(e.message)) {
          throw new Error((e.message || e) + ' – hold BOOT / USR while plugging in the USB cable (ESP32-S3), then press 2 again.');
        }
        log('\nNo answer – 1200 bps reset (boot mode), then once more, slower …\n');
        suSay('The radio did not answer – trying boot mode (1200 bps reset) …');
        try { await touch1200(port); } catch (x) { /* the port may already be gone */ }
        await sleep(2500);
        port = await radioPortAgain(port, info, 20000).catch(() => port);
      }
    }
    suBar(85);
    let names = [], ssid = '', server = '', invite = '', who = null;
    try { server = (await (await fetch('/api/eud/meshsite')).json()).server || ''; } catch (e) { /* without */ }
    if ($('suUser').value) { // the radio's own TAK user (new or chosen)
      const r = await api('mesh-invite', { method: 'POST', body: $('suUser').value === 'new' ? {} : { id: $('suUser').value } });
      invite = r.invite;
      who = r.user;
      log(`TAK user for the radio: ${who.callsign} (${who.username})\n`);
    }
    suSay('The radio starts … then it gets its WLAN name, the server address' + (chan ? ' and the mesh channel' : '') + ' (up to a minute).');
    await sleep(6000);
    const p2 = await radioPortAgain(port, info);
    suBar(90);
    let mqtt = null;
    if (wantMqtt) {
      if ($('suMqttAddr').value.trim() !== mqttInfo.address) await api('mesh-mqtt', { method: 'POST', body: { address: $('suMqttAddr').value.trim(), tls: true } });
      const m = await api('mesh-mqtt/login', { method: 'POST', body: {} });
      mqtt = { address: m.address, username: m.username, password: m.password, root: m.root, tls: m.tls };
    }
    let node;
    ({ names, ssid, node } = await finishRadio(p2, chan, server, invite, ap, { mqtt, gateway }));
    // known in admin → Network (role, WLAN name) by its node id
    api('mesh-radios', { method: 'POST', body: { node: P.nodeId(node), name: radioName(d), ssid, role: gateway ? 'gateway' : 'field', mqtt: !!mqtt } }).catch(() => {});
    if (who) loadSetupUsers();
    suBar(100);
    suSay(`Done! ${radioName(d)} has TAKweb${names.length ? ', the mesh channel ' + names.join(', ') : ''}${who ? ' and the TAK user ' + who.callsign : ''}. On the phone: WLAN "${ssid}"${ap.psk ? ` (password ${ap.psk})` : ' (open)'} → https://takweb.local – accept the certificate once${who ? '; with internet "TAKWEB ONLINE" logs in by itself' : ''}.`);
  } catch (e) {
    suSay('Not finished: ' + (e.message || e), false);
    log('\nError: ' + (e.message || e) + '\n');
  } finally {
    busy = false;
    $('suGo').disabled = !takwebVersion();
  }
});

// page opened right on the Meshtastic view (the view event came before this module)
if (document.querySelector('[data-nav="mesh"].on')) { load(); loadSetupChannels(); loadSetupUsers(); loadSetupMqtt(); afterLoad(autoFirmware); }
