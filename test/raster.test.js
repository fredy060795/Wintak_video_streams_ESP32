// Large map images in KMZ / data packages (GroundOverlay): reduced on import to an overview plus full-resolution
// pieces (lib/raster.js) – like a printed game map of 11 000 × 8 000 px that phones cannot show.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const tak = require('../lib/tak');
const raster = require('../lib/raster');
const { zip } = require('../lib/datapackage');

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// a noisy PNG (does not compress, so it is large like a real map scan)
function png(w, h) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `nullsrc=s=${w}x${h},geq=random(1)*255:128:128`,
    '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { maxBuffer: 200 * 1024 * 1024 });
  return r.stdout;
}

test('image size from the header (PNG, JPEG)', () => {
  const p = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(p, 0);
  p.writeUInt32BE(11161, 16); p.writeUInt32BE(7980, 20); p[25] = 6;
  assert.deepEqual(raster.imageInfo(p), { w: 11161, h: 7980, alpha: true });
  const j = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 0x03]);
  assert.deepEqual(raster.imageInfo(j), { w: 4000, h: 3000, alpha: false });
});

test('large GroundOverlay image -> overview + full-resolution pieces, small images unchanged', { skip: !HAS_FFMPEG && 'no ffmpeg' }, async () => {
  const big = png(5000, 2500);
  assert.ok(big.length > 1024 * 1024, 'test image is large');
  const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Folder>
    <GroundOverlay><name>Game map</name><Icon><href>files/map.png</href></Icon>
      <LatLonBox><north>49.4</north><south>49.3</south><east>14.2</east><west>14.0</west></LatLonBox></GroundOverlay>
    <GroundOverlay><name>Small</name><Icon><href>files/small.png</href></Icon>
      <LatLonBox><north>49.5</north><south>49.45</south><east>14.1</east><west>14.0</west></LatLonBox></GroundOverlay></Folder></kml>`;
  const kmz = zip({ 'doc.kml': kml, 'files/map.png': big, 'files/small.png': png(64, 64) });
  const pkg = zip({ 'MANIFEST/manifest.xml': '<MissionPackageManifest version="2"/>', 'abc/Map.kmz': kmz });
  const out = await raster.prepare(tak.extractContent('Map.zip', pkg), { ffmpeg: 'ffmpeg' });
  const [ov] = out.overlays;
  assert.ok(ov, 'overlay found inside the data package');
  const keys = Object.keys(ov.images);
  // 5000 x 2500 -> 3 x 2 pieces of max 2048 px + overview
  assert.equal(keys.filter(k => /takweb-raster\/.*\/p\d+\.webp$/.test(k)).length, 6);
  assert.ok(keys.some(k => /\/o\.webp$/.test(k)));
  assert.ok(!keys.includes('files/map.png'), 'the original big image is not sent');
  assert.match(ov.images['files/small.png'], /^data:image\/png;base64,/, 'small image unchanged');
  for (const k of keys.filter(x => x.endsWith('.webp'))) assert.match(ov.images[k], /^data:image\/webp;base64,UklGR/, k + ' is WebP');
  // KML: overview (4096 px) + pieces with their own LatLonBox, the small overlay untouched
  const gos = ov.kml.match(/<GroundOverlay>[\s\S]*?<\/GroundOverlay>/g);
  assert.equal(gos.length, 1 + 6 + 1);
  assert.match(gos[0], /o\.webp[\s\S]*<north>49\.4<\/north>[\s\S]*takwebPx"><value>4096</);
  assert.match(ov.kml, /<href>files\/small\.png<\/href>/);
  const first = gos[1];
  assert.match(first, /p0\.webp/);
  assert.equal(Number(/<west>([^<]+)</.exec(first)[1]), 14.0);
  assert.ok(Math.abs(Number(/<east>([^<]+)</.exec(first)[1]) - (14.0 + 0.2 * 2048 / 5000)) < 1e-9, 'piece east by its pixels');
  assert.match(first, /takwebPx"><value>2048</);
  assert.ok(JSON.stringify(out).length < big.length, 'sent smaller than the original');
});
