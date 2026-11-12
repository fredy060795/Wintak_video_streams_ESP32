// Meshtastic firmware for the admin (Mesh → "Flash Meshtastic firmware"): a library on the server with the offline
// packages of the MeshtasticDesktop flasher (ZIP per chip family: meshdesk-firmware.json, <device>.mt.json, *.bin,
// *.uf2 – also the TAKweb firmware with its own WLAN). The admin page flashes ESP32 devices from it over USB
// (Web Serial, esptool-js); every device file can also be downloaded (e.g. .uf2 for nRF52/RP2040).
const fs = require('fs');
const path = require('path');
const { unzip } = require('./tak');

const RELEASE_REPO = 'fredy060795/MeshtasticDesktop';
const safe = s => String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
const off = v => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), String(v).toLowerCase().startsWith('0x') ? 16 : 10);
  return Number.isFinite(n) ? n : null;
};
const chipOf = m => String(m.mcu || m.architecture || '').replace(/-/g, '').toLowerCase();

// which files of a device go where (like device_files() in the desktop flasher)
function deviceFiles(m, present) {
  const files = (m.files || []).map(f => f.name).filter(n => present.has(n));
  const parts = Object.fromEntries((m.part || []).map(p => [p.name, p]));
  const r = { factory: null, app: null, ota: null, littlefs: null, uf2: null };
  for (const n of files) {
    const l = n.toLowerCase();
    if (l.endsWith('.factory.bin')) r.factory = n;
    else if (l.endsWith('.uf2')) r.uf2 = n;
    else if (l.startsWith('littlefs-')) r.littlefs = n;
    else if (l.startsWith('mt-') && l.endsWith('-ota.bin')) r.ota = n;
    else if (l.endsWith('.bin') && l.startsWith('firmware-')) r.app = n;
  }
  const app0 = (m.files || []).find(f => f.part_name === 'app0' && present.has(f.name));
  if (app0) r.app = app0.name;
  if (!r.ota && present.has(`mt-${chipOf(m)}-ota.bin`)) r.ota = `mt-${chipOf(m)}-ota.bin`;
  const at = (names, fallback) => {
    for (const n of names) if (parts[n]) return off(parts[n].offset);
    return fallback;
  };
  let otaOff = at(['app1', 'flashApp'], null);
  if (otaOff == null) { const p = (m.part || []).find(x => ['ota_1', '17', 17].includes(x.subtype)); if (p) otaOff = off(p.offset); }
  return { ...r, appOff: at(['app0', 'app'], 0x10000), otaOff, fsOff: at(['spiffs', 'littlefs'], null) };
}

class FirmwareLibrary {
  constructor(dir, { log = () => {}, fetchImpl = (...a) => fetch(...a) } = {}) {
    Object.assign(this, { dir, log, fetchImpl });
  }

  // -> [{ key, version, channel, title, devices: [{ id, name, target, chip, esp, size, files, flash }] }]
  list() {
    if (!fs.existsSync(this.dir)) return [];
    const out = [];
    for (const key of fs.readdirSync(this.dir)) {
      const d = path.join(this.dir, key);
      if (!fs.statSync(d).isDirectory()) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(d, 'meshdesk-firmware.json'), 'utf8')); } catch (e) { /* none */ }
      const names = fs.readdirSync(d);
      const present = new Set(names);
      const sizes = Object.fromEntries(names.map(n => [n, fs.statSync(path.join(d, n)).size]));
      const devices = [];
      for (const n of names.filter(x => x.endsWith('.mt.json')).sort()) {
        let m;
        try { m = JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')); } catch (e) { continue; }
        const flash = deviceFiles(m, present);
        const chip = chipOf(m);
        const files = [...new Set([flash.factory, flash.app, flash.ota, flash.littlefs, flash.uf2].filter(Boolean))];
        devices.push({
          id: `${key}/${n}`, name: m.displayName || m.platformioTarget || n, target: m.platformioTarget || '', chip,
          esp: chip.startsWith('esp32') && !!(flash.factory || flash.app),
          files: files.map(f => ({ name: f, size: sizes[f] })), size: files.reduce((s, f) => s + sizes[f], 0), flash,
          support: m.supportLevel || 0,
        });
      }
      if (!devices.length) continue;
      devices.sort((a, b) => a.name.localeCompare(b.name));
      out.push({ key, version: meta.version || key, channel: meta.channel || '', title: meta.title || '', release: meta.release || null, devices });
    }
    const v = s => (String(s).match(/\d+/g) || []).slice(0, 3).map(Number);
    return out.sort((a, b) => { const x = v(a.version), y = v(b.version); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return a.key.localeCompare(b.key); });
  }

  // a package ZIP of the desktop flasher -> its version (folder); several chip ZIPs of one version merge
  importZip(buf) {
    let files;
    try { files = unzip(buf, 5000); } catch (e) { throw new Error('Not a ZIP file.'); }
    const names = Object.keys(files);
    let meta = {};
    if (files['meshdesk-firmware.json']) { try { meta = JSON.parse(files['meshdesk-firmware.json'].toString('utf8')); } catch (e) { /* ignore */ } }
    let version = meta.version;
    if (!version) {
      const mt = names.find(n => n.endsWith('.mt.json'));
      if (mt) { try { version = JSON.parse(files[mt].toString('utf8')).version; } catch (e) { /* ignore */ } }
    }
    if (!version || !names.some(n => n.endsWith('.mt.json'))) throw new Error('No Meshtastic firmware in the ZIP (no .mt.json) – use the packages of the MeshtasticDesktop flasher.');
    const key = safe(version);
    const dest = path.join(this.dir, key);
    fs.mkdirSync(dest, { recursive: true });
    let n = 0;
    for (const name of names) {
      const base = path.basename(name);
      if (!base || name.endsWith('/') || base.endsWith('.elf') || base === 'meshdesk-firmware.json' || base !== safe(base)) continue;
      fs.writeFileSync(path.join(dest, base), files[name]);
      n++;
    }
    const mp = path.join(dest, 'meshdesk-firmware.json');
    let old = {};
    try { old = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (e) { /* new */ }
    const chips = new Set([...(old.chips || []), ...(meta.chip ? [meta.chip] : [])]);
    const { chip, ...rest } = meta;
    fs.writeFileSync(mp, JSON.stringify({ ...old, ...rest, version, chips: [...chips].sort() }, null, 2));
    this.log(`Firmware imported: ${version} (${n} files)`);
    return { key, version, files: n };
  }

  remove(key) {
    const d = path.join(this.dir, safe(key));
    if (safe(key) !== key || !fs.existsSync(d)) return false;
    fs.rmSync(d, { recursive: true, force: true });
    return true;
  }

  // path of one file, only names that exist in the library
  file(key, name) {
    if (safe(key) !== key || safe(name) !== name) return null;
    const p = path.join(this.dir, key, name);
    return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
  }

  async gh(url) {
    const r = await this.fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TAKweb-firmware' } });
    if (!r.ok) throw new Error(`GitHub: ${r.status}`);
    return r;
  }

  // firmware releases of the desktop flasher's repo (TAKweb firmware and the offline packages)
  async releases(repo = RELEASE_REPO) {
    const rels = await (await this.gh(`https://api.github.com/repos/${repo}/releases?per_page=30`)).json();
    return rels.map(r => ({
      tag: r.tag_name, name: r.name || r.tag_name, takweb: /takweb/i.test(r.tag_name), published: r.published_at,
      assets: (r.assets || []).filter(a => a.name.endsWith('.zip')).map(a => ({ name: a.name, size: a.size, url: a.browser_download_url, updated: a.updated_at || '', chip: a.name.replace(/\.zip$/, '').split('-').pop() })),
    })).filter(r => r.assets.length);
  }

  // download chosen chip packages of a release into the library
  async fetchRelease(tag, chips, repo = RELEASE_REPO) {
    const rel = (await this.releases(repo)).find(r => r.tag === tag);
    if (!rel) throw new Error('Release not found: ' + tag);
    const want = rel.assets.filter(a => !chips || !chips.length || chips.includes(a.chip));
    if (!want.length) throw new Error('No package for these chips in ' + tag);
    const done = [];
    for (const a of want) {
      this.log(`Firmware download: ${a.name}`);
      const buf = Buffer.from(await (await this.gh(a.url)).arrayBuffer());
      const r = this.importZip(buf);
      // remember where it came from: a rebuilt release (same version, new files) is loaded again
      const mp = path.join(this.dir, r.key, 'meshdesk-firmware.json');
      const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
      meta.release = { tag, assets: { ...((meta.release && meta.release.tag === tag && meta.release.assets) || {}), [a.chip]: a.updated } };
      fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
      done.push(r);
    }
    return done;
  }
}

module.exports = { FirmwareLibrary, deviceFiles, RELEASE_REPO };
