// TAKweb on a Meshtastic radio: a mesh-only build of the TAKweb app for the flash of an ESP32 radio. The Meshtastic
// firmware serves files from /static on its flash over WLAN (gzip: name.gz) and offers its radio over HTTP
// (/api/v1/toradio, /api/v1/fromradio) – a phone on the radio's WLAN opens https://<radio> and has TAKweb, without
// server, internet or anything loaded before. Flat file names (the firmware's upload knows no folders), no server parts
// (3D map, QR scanner, Android app), everything gzipped. Installed onto the radio with public/eud/meshinstall.js.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EUD = path.join(__dirname, '..', 'public', 'eud');
const MOD = name => path.dirname(require.resolve(name + '/package.json'));

// published name -> source file
function sources() {
  return {
    'index.html': path.join(EUD, 'index.html'),
    'eud.css': path.join(EUD, 'eud.css'),
    'eud.js': path.join(EUD, 'eud.js'),
    'video.js': path.join(EUD, 'video.js'),
    'data.js': path.join(EUD, 'data.js'),
    'meshproto.js': path.join(EUD, 'meshproto.js'),
    'codec2.js': path.join(EUD, 'codec2.js'),
    'codec2.wasm': path.join(EUD, 'codec2.wasm'),
    'mesh.js': path.join(EUD, 'mesh.js'),
    'tools.js': path.join(EUD, 'tools.js'),
    'voice.js': path.join(EUD, 'voice.js'),
    'icon-192.png': path.join(EUD, 'icon-192.png'),
    'leaflet.js': path.join(MOD('leaflet'), 'dist', 'leaflet.js'),
    'leaflet.css': path.join(MOD('leaflet'), 'dist', 'leaflet.css'),
    'layers.png': path.join(MOD('leaflet'), 'dist', 'images', 'layers.png'),
    'layers-2x.png': path.join(MOD('leaflet'), 'dist', 'images', 'layers-2x.png'),
    'leaflet-rotate.js': path.join(MOD('leaflet-rotate'), 'dist', 'leaflet-rotate.js'),
    'milsymbol.js': path.join(MOD('milsymbol'), 'dist', 'milsymbol.js'),
  };
}

// the app page for the radio: flat paths, no version suffix, without server-only scripts, mesh-only flag
function radioIndex(html, version) {
  return html
    .split('__TAKWEB_VERSION__').join(version)
    .replace(/<link rel="manifest"[^>]*>\n?/, '')
    .replace(/<link rel="icon" href="\/assets[^>]*>\n?/, '')
    .replace(/<link rel="apple-touch-icon"[^>]*>\n?/, '')
    .replace(/(src|href)="vendor\//g, '$1="')
    .replace(/(src|href)="([\w.-]+)\?v=[^"]*"/g, '$1="$2"')
    .replace(/<script src="(jsQR|view3d|blenative)\.js"><\/script>\n?/g, '')
    .replace('<head>', '<head>\n<script>window.TAKWEB_MESH = true;</script>');
}

let cache = null;
// -> { version, files: [{ name, size, gz: Buffer }], total } (gzip sizes – what lands on the flash)
function build(version = 'dev') {
  if (cache && cache.version === version) return cache;
  const files = [];
  for (const [name, src] of Object.entries(sources())) {
    let data = fs.readFileSync(src);
    if (name === 'index.html') data = Buffer.from(radioIndex(data.toString('utf8'), version));
    if (name === 'leaflet.css') data = Buffer.from(data.toString('utf8').replace(/url\(images\//g, 'url('));
    const gz = zlib.gzipSync(data, { level: 9 });
    files.push({ name, size: data.length, gz });
  }
  cache = { version, files, total: files.reduce((n, f) => n + f.gz.length, 0) };
  return cache;
}

module.exports = { build, radioIndex };
