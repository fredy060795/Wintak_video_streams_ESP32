// Admin → Meshtastic: flash Meshtastic firmware (also the TAKweb firmware) from the server's library (lib/firmware.js)
// over USB – Web Serial + esptool-js (Espressif, Apache-2.0), like flasher.meshtastic.org. ESP32 radios only;
// nRF52/RP2040 radios get their .uf2 file to download.
import { ESPLoader, Transport } from '/eud/vendor/esptool.js';

const log = t => { const l = $('fwLog'); l.classList.remove('hidden'); l.textContent += t; l.scrollTop = l.scrollHeight; };
const bar = p => { $('fwBar').classList.remove('hidden'); $('fwFill').style.width = Math.round(p) + '%'; };
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const hex = n => '0x' + n.toString(16);
let versions = [];
let busy = false;

const curVersion = () => versions.find(v => v.key === $('fwVer').value);
const curDevice = () => { const v = curVersion(); return v && v.devices.find(d => d.id === $('fwDev').value); };

function fillVersions(keep) {
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
  $('fwGo').disabled = true;
  $('fwLog').textContent = '';
  bar(0);
  let transport = null;
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
    setMsg($('fwMsg'), 'Connecting to the radio … (if nothing happens: hold BOOT, tap RESET, release BOOT)', true);
    transport = new Transport(port, false);
    const terminal = { clean() {}, writeLine: t => log(t + '\n'), write: t => log(t) };
    const loader = new ESPLoader({ transport, baudrate: Number($('fwBaud').value), terminal, debugLogging: false });
    const chipText = await loader.main();
    const chip = String(loader.chip.CHIP_NAME || '').replace(/-/g, '').toLowerCase();
    log(`\nChip: ${chipText}\n`);
    if (chip && d.chip && chip !== d.chip) throw new Error(`The radio is an ${loader.chip.CHIP_NAME}, this firmware is for ${d.chip} – choose the right device.`);
    const total = files.reduce((n, x) => n + x.data.length, 0);
    const before = files.map((x, i) => files.slice(0, i).reduce((n, y) => n + y.data.length, 0));
    setMsg($('fwMsg'), full ? 'Erasing the flash and writing …' : 'Writing …', true);
    for (const x of files) log(`${hex(x.address)}: ${x.data.length} bytes\n`);
    await loader.writeFlash({
      fileArray: files, flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep', eraseAll: full, compress: true,
      reportProgress: (i, written, size) => { bar(100 * (before[i] + written * files[i].data.length / size) / total); },
    });
    await loader.after('hard_reset');
    bar(100);
    setMsg($('fwMsg'), /takweb/i.test(v.key)
      ? 'Done. The radio restarts and opens the WLAN "TAKweb" (password 12345678): connect the phone and open https://takweb.local (or https://192.168.4.1), accept the certificate once.'
      : `Done – ${d.name} runs Meshtastic ${v.version}.${full ? ' After a full install set the LoRa region (TAKweb: Meshtastic panel → SET REGION).' : ''}`, true);
  } catch (e) {
    setMsg($('fwMsg'), 'Not flashed: ' + (e.message || e));
    log('\nError: ' + (e.message || e) + '\n');
  } finally {
    try { if (transport) await transport.disconnect(); } catch (e) { /* gone */ }
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
