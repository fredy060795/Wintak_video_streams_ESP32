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
async function load(keep) {
  try { versions = (await api('firmware')).versions; } catch (e) { versions = []; setMsg($('fwMsg'), e.message); }
  fillVersions(keep);
}
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
document.addEventListener('admin-view', e => { if (e.detail === 'mesh') loadSetupChannels(); });

$('suFetch').addEventListener('click', async () => {
  suSay('Loading the TAKweb firmware from GitHub … (about a minute)');
  $('suFetch').disabled = true;
  try {
    const { releases } = await api('firmware/releases');
    const rel = releases.filter(r => r.takweb).sort((a, b) => String(b.published).localeCompare(String(a.published)))[0];
    if (!rel) throw new Error('No TAKweb firmware release on GitHub yet – import the file instead.');
    const r = await api('firmware/fetch', { method: 'POST', body: { tag: rel.tag, chips: ['esp32s3', 'esp32'] } });
    versions = r.versions;
    fillVersions();
    suSay('TAKweb firmware loaded. Choose the radio and press 2.');
  } catch (e) { suSay(e.message, false); }
  $('suFetch').disabled = false;
});
$('suImport').addEventListener('click', () => $('fwZip').click());

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

// mesh channel over the radio's serial API (Meshtastic runs now); waits for the first start (certificate etc.)
async function setChannel(port, url) {
  let inst = null;
  const link = new MI.SerialLink(port, frame => { try { inst.feed(P.parseFromRadio(frame)); } catch (e) { /* not for us */ } });
  inst = new MI.RadioInstaller({ P, send: b => link.send(b), log: t => log(t + '\n') });
  await link.open();
  try {
    let st = null;
    for (let t = 0; t < 4 && !st; t++) { try { st = await inst.readState(); } catch (e) { log('Radio still starting …\n'); await sleep(3000); } }
    if (!st) throw new Error('The radio does not answer – it may still be starting. The firmware is on it; set the channel later in TAKweb (Meshtastic → Channel from a link).');
    if (!st.files.some(f => /static\/index\.html\.gz$/.test(f.name))) log('Warning: TAKweb pages not found on the radio.\n');
    const r = P.applyChannelUrl(st.node, url, { region: inst.region > 0 ? inst.region : P.REGIONS.EU_868 });
    for (const pkt of r.packets) { await link.send(pkt); await sleep(300); }
    log(`Channel set: ${r.names.join(', ')}\n`);
    return r.names;
  } finally { await link.close(); }
}

$('suGo').addEventListener('click', async () => {
  const v = takwebVersion();
  const d = v && v.devices.find(x => x.target === $('suDev').value);
  if (busy || !d) return;
  if (!('serial' in navigator)) return suSay('This browser cannot reach USB radios – use Chrome or Edge on a PC.', false);
  if (!confirm(`${radioName(d)} is set up new: Meshtastic, TAKweb and the mesh channel. Its old settings and nodes are replaced.\n\nConnect the radio with a USB data cable, then press OK and choose it in the list.`)) return;
  let port;
  try { port = await navigator.serial.requestPort(); } catch (e) { return; } // list closed
  const info = port.getInfo(), chan = $('suChan').value;
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
        if (tries++ || /chip/.test(e.message)) throw e;
        log('\nOnce more, slower …\n');
        await sleep(1500);
      }
    }
    suBar(85);
    let names = [];
    if (chan) {
      suSay('The radio starts … then the mesh channel is set (up to a minute).');
      await sleep(6000);
      const p2 = await radioPortAgain(port, info);
      suBar(90);
      names = await setChannel(p2, chan);
    }
    suBar(100);
    suSay(`Done! ${radioName(d)} has TAKweb${names.length ? ' and the mesh channel ' + names.join(', ') : ''}. On the phone: WLAN "TAKweb" (password 12345678) → https://takweb.local – accept the certificate once.`);
  } catch (e) {
    suSay('Not finished: ' + (e.message || e), false);
    log('\nError: ' + (e.message || e) + '\n');
  } finally {
    busy = false;
    $('suGo').disabled = !takwebVersion();
  }
});

// page opened right on the Meshtastic view (the view event came before this module)
if (document.querySelector('[data-nav="mesh"].on')) { load(); loadSetupChannels(); }
