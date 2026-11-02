// Mission tracks (lib/tracks.js): positions of every user from the TAK server are recorded while a mission runs,
// thinned out (not every second), kept across a restart and exported as GPX/KML.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tracks, parsePli } = require('../lib/tracks');

const iso = t => new Date(t).toISOString();
const pli = (uid, lat, lon, { t = Date.now(), cs = uid, team = 'Cyan', extra = '' } = {}) =>
  `<event version="2.0" uid="${uid}" type="a-f-G-U-C" how="m-g" time="${iso(t)}" start="${iso(t)}" stale="${iso(t + 60000)}">`
  + `<point lat="${lat}" lon="${lon}" hae="250" ce="9" le="9"/><detail><contact callsign="${cs}" endpoint="*:-1:stcp"/>`
  + `<__group name="${team}" role="Team Member"/><track speed="1.5" course="90"/>${extra}</detail></event>`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takweb-tracks-'));
  const store = { tracks: {} };
  let saves = 0;
  const make = () => new Tracks({ dir, data: () => store.tracks, save: () => { saves++; } });
  return { dir, store, make, saves: () => saves };
}

// Date.now() under control: the recorder thins out by arrival time
function clock(start) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  return { add: ms => { now += ms; }, get: () => now, restore: () => { Date.now = real; } };
}

test('tracks: only positions of users, not markers or drawings', () => {
  const p = parsePli(pli('ANDROID-1', 47.1, 11.2, { cs: 'Alpha &amp; 1' }));
  assert.equal(p.uid, 'ANDROID-1');
  assert.equal(p.callsign, 'Alpha & 1');
  assert.equal(p.team, 'Cyan');
  assert.equal(p.hae, 250);
  assert.equal(p.speed, 1.5);
  const t = new Date().toISOString();
  assert.equal(parsePli(`<event uid="m1" type="a-h-G" time="${t}"><point lat="47" lon="11" hae="0"/><detail><contact callsign="Enemy"/></detail></event>`), null, 'marker');
  assert.equal(parsePli(`<event uid="d1" type="u-d-f" time="${t}"><point lat="47" lon="11" hae="0"/><detail/></event>`), null, 'drawing');
  assert.equal(parsePli(pli('TAKWEB-REC-ab', 47, 11)), null, 'own connection');
  assert.equal(parsePli(pli('X', 0, 0)), null, 'no position');
  // TAKweb in the browser (takv, no endpoint) and Meshtastic users (group only) count
  assert.ok(parsePli(`<event uid="EUD-1" type="a-f-G-U-C" time="${t}"><point lat="47" lon="11" hae="9999999"/><detail><takv platform="TAKweb"/><contact callsign="B"/></detail></event>`));
});

test('tracks: recording, thinning out, stop, GPX/KML, delete', () => {
  const s = setup();
  const c = clock(Date.UTC(2026, 10, 2, 8, 0, 0));
  try {
    const tr = s.make();
    tr.cot(pli('A', 47, 11)); // nothing recorded without a mission
    const m = tr.start('Exercise North');
    assert.throws(() => tr.start('second'), /already/);
    // stored picture from before the mission (sent by the server on connect) is left out
    tr.cot(pli('OLD', 47, 11, { t: c.get() - 3600000 }));
    for (let i = 0; i < 10; i++) { tr.cot(pli('A', 47 + i * 0.001, 11, { t: c.get() })); c.add(1000); } // 1 per second, moving
    for (let i = 0; i < 10; i++) { tr.cot(pli('B', 48, 12, { t: c.get(), team: 'Red' })); c.add(10000); } // standing still
    tr.cot(pli('B', 48.01, 12, { t: c.get(), team: 'Red' }));
    assert.deepEqual(Object.keys(m.users).sort(), ['A', 'B']);
    assert.equal(m.users.A.points, 2, 'one point per 5 s');
    assert.equal(m.users.B.points, 3, 'standing still: one a minute, then the move');
    assert.ok(m.users.B.meters > 1000 && m.users.B.meters < 1200, 'distance ' + m.users.B.meters);
    tr.stop();
    assert.ok(m.end);
    tr.cot(pli('A', 47.5, 11)); // after the end
    const pts = tr.points(m.id);
    assert.equal(pts.length, 5);
    assert.deepEqual(pts[0].slice(1, 4), ['A', 47, 11]);
    const gpx = tr.gpx(m.id);
    assert.match(gpx, /<name>Exercise North<\/name>/);
    assert.equal((gpx.match(/<trk>/g) || []).length, 2);
    assert.match(gpx, /<trkpt lat="48.01" lon="12"><ele>250<\/ele><time>/);
    const kml = tr.kml(m.id);
    assert.match(kml, /<gx:Track>/);
    assert.match(kml, /<gx:coord>12 48.01 250<\/gx:coord>/);
    assert.match(kml, /<color>ff0000ff<\/color>/, 'team Red');
    assert.ok(tr.remove(m.id));
    assert.equal(tr.missions().length, 0);
    assert.equal(fs.existsSync(tr.file(m.id)), false);
  } finally {
    c.restore();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('tracks: a recording goes on after a server restart', async () => {
  const s = setup();
  try {
    const a = s.make();
    const m = a.start('Night');
    a.cot(pli('A', 47, 11));
    a.close(); // the server stops
    const b = s.make();
    assert.equal(b.active().id, m.id);
    b.cot(pli('C', 46, 10));
    b.stop();
    assert.deepEqual(b.points(m.id).map(p => p[1]), ['A', 'C']);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});
