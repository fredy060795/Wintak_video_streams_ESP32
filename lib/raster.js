// Large map images in KML/KMZ (GroundOverlay, e.g. a scanned or printed game map of 10 000 × 8 000 px) are too big
// for phones: decoded they need hundreds of MB, iPhones do not show them at all. On import they become an overview
// (max 4096 px) plus detail pieces in full resolution (2048 px) – the app shows the overview when zoomed out and only
// the visible pieces when zoomed in (data.js, "takwebPx"). One ffmpeg run, the image is decoded once.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const OVERVIEW = 4096;
const PIECE = 2048;
const SMALL = 4 * 1024 * 1024;      // smaller files stay as they are (unless more than 4096 px)
const MAX_RAW = 60 * 1024 * 1024;   // without ffmpeg: up to this size passed on unchanged
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// width/height (and alpha) from the file header, without decoding
function imageInfo(buf) {
  if (buf.length > 26 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), alpha: [4, 6].includes(buf[25]) || buf.includes(Buffer.from('tRNS')) };
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), alpha: true };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), alpha: false };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

const dataUrl = (buf, type) => `data:${type};base64,${buf.toString('base64')}`;

// overview + pieces with ffmpeg -> { overview: Buffer, pieces: [{ x, y, w, h, buf }] }
async function cut(ffmpeg, buf, info) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takweb-raster-'));
  try {
    const input = path.join(dir, 'in');
    fs.writeFileSync(input, buf);
    const cols = Math.ceil(info.w / PIECE), rows = Math.ceil(info.h / PIECE);
    const pieces = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * PIECE, y = r * PIECE;
      pieces.push({ x, y, w: Math.min(PIECE, info.w - x), h: Math.min(PIECE, info.h - y) });
    }
    const fmt = info.alpha ? ',format=yuva420p' : '';
    const n = pieces.length + 1;
    let graph = `[0:v]split=${n}${Array.from({ length: n }, (_, i) => `[s${i}]`).join('')};`
      + `[s0]scale=w='min(${OVERVIEW},iw)':h='min(${OVERVIEW},ih)':force_original_aspect_ratio=decrease${fmt}[o]`;
    pieces.forEach((p, i) => { graph += `;[s${i + 1}]crop=${p.w}:${p.h}:${p.x}:${p.y}${fmt}[p${i}]`; });
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-filter_complex', graph];
    const out = (label, file) => args.push('-map', `[${label}]`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', '-f', 'image2pipe', path.join(dir, file));
    out('o', 'o.webp');
    pieces.forEach((p, i) => out(`p${i}`, `p${i}.webp`));
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      proc.stderr.on('data', d => { err += d; });
      proc.on('error', reject);
      proc.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || 'ffmpeg failed'))));
    });
    return { overview: fs.readFileSync(path.join(dir, 'o.webp')), pieces: pieces.map((p, i) => ({ ...p, buf: fs.readFileSync(path.join(dir, `p${i}.webp`)) })) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const num = (block, tag) => { const m = new RegExp(`<(?:\\w+:)?${tag}>\\s*([-\\d.eE+]+)\\s*<`).exec(block); return m ? Number(m[1]) : NaN; };
const box = (n, s, e, w) => `<LatLonBox><north>${n}</north><south>${s}</south><east>${e}</east><west>${w}</west></LatLonBox>`;
const px = v => `<ExtendedData><Data name="takwebPx"><value>${v}</value></Data></ExtendedData>`;

// result of extractContent: images marked { raw } -> data URLs; big GroundOverlays -> overview + pieces
async function prepare(result, { ffmpeg = 'ffmpeg', log = () => {} } = {}) {
  for (const ov of (result && result.overlays) || []) {
    const images = ov.images || {};
    for (const [name, v] of Object.entries(images)) {
      if (!v || typeof v === 'string' || !v.raw) continue;
      const buf = v.raw;
      const type = TYPES[name.split('.').pop().toLowerCase()] || 'image/png';
      const info = imageInfo(buf);
      delete images[name];
      if (!info || (buf.length <= SMALL && info.w <= OVERVIEW && info.h <= OVERVIEW)) {
        if (buf.length <= MAX_RAW) images[name] = dataUrl(buf, type);
        continue;
      }
      // the GroundOverlay(s) that show this image, in the main KML or another KML of the KMZ
      const base = name.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`<(\\w+:)?GroundOverlay\\b[\\s\\S]*?<\\/(\\w+:)?GroundOverlay>`, 'g');
      const docs = [['kml', ov.kml], ...Object.entries(ov.extra || {})];
      let pieces = null;
      try {
        const started = Date.now();
        pieces = await cut(ffmpeg, buf, info);
        log(`Map image ${name.split('/').pop()} (${info.w}×${info.h}) -> overview + ${pieces.pieces.length} pieces in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      } catch (e) {
        log(`Map image ${name}: cannot be reduced (${e.message})`);
        if (buf.length <= MAX_RAW) images[name] = dataUrl(buf, type);
        else (result.errors = result.errors || []).push(`${name.split('/').pop()}: map image too large (${Math.round(buf.length / 1048576)} MB) and ffmpeg missing`);
        continue;
      }
      const dir = `takweb-raster/${base.replace(/\W/g, '_')}`;
      const files = { 'o.webp': dataUrl(pieces.overview, 'image/webp') };
      pieces.pieces.forEach((p, i) => { files[`p${i}.webp`] = dataUrl(p.buf, 'image/webp'); });
      const overviewW = info.w >= info.h ? Math.min(OVERVIEW, info.w) : Math.round(info.w * Math.min(OVERVIEW, info.h) / info.h);
      for (const [key, text] of docs) {
        if (!text) continue;
        // hrefs are relative to the KML: the images under the KML's folder
        const folder = (key === 'kml' ? ov.path || '' : key).split('/').slice(0, -1).join('/');
        for (const [f, url] of Object.entries(files)) images[(folder ? folder + '/' : '') + `${dir}/${f}`] = url;
        const next = text.replace(re, block => {
          if (!new RegExp(`<(\\w+:)?href>\\s*[^<]*${base}\\s*<`).test(block)) return block;
          const n = num(block, 'north'), s = num(block, 'south'), e = num(block, 'east'), w = num(block, 'west');
          const rot = num(block, 'rotation') || 0;
          const nameTag = (/<(?:\w+:)?name>[^<]*<\/(?:\w+:)?name>/.exec(block) || [''])[0];
          const ref = f => `<Icon><href>${f}</href></Icon>`;
          if (![n, s, e, w].every(Number.isFinite) || rot) return block.replace(/(<(?:\w+:)?href>)[^<]*(<)/, `$1${dir}/o.webp$2`); // rotated / quad: overview only
          let out = `<GroundOverlay>${nameTag}${ref(`${dir}/o.webp`)}${box(n, s, e, w)}${px(overviewW)}</GroundOverlay>`;
          pieces.pieces.forEach((p, i) => {
            const pw = w + (e - w) * p.x / info.w, pe = w + (e - w) * (p.x + p.w) / info.w;
            const pn = n - (n - s) * p.y / info.h, ps = n - (n - s) * (p.y + p.h) / info.h;
            out += `<GroundOverlay>${ref(`${dir}/p${i}.webp`)}${box(pn, ps, pe, pw)}${px(p.w)}</GroundOverlay>`;
          });
          return out;
        });
        if (key === 'kml') ov.kml = next; else ov.extra[key] = next;
      }
    }
  }
  return result;
}

module.exports = { prepare, imageInfo };
