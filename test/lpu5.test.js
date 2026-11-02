// LPU5 field devices: profiles, new devices, commands over MQTT, ADS-B and the mesh <-> TAK gateway (lib/lpu5.js, lib/meshgw.js)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const P = require('../public/eud/meshproto');
const { Lpu5, normProfile, aircraftCot } = require('../lib/lpu5');
const { MeshGateway, slimCot, MARK } = require('../lib/meshgw');

function fakeMqtt() {
  const c = new EventEmitter();
  c.published = [];
  c.subscribe = () => {};
  c.end = () => {};
  c.publish = (topic, payload, opts) => c.published.push({ topic, payload: String(payload), opts });
  return c;
}

function setup(extra = {}) {
  const data = { enabled: true, url: 'mqtt://10.55.0.1:1883', ...extra };
  const client = fakeMqtt();
  const cots = [], logs = [];
  const l = new Lpu5({ data: () => data, save: () => {}, cot: x => cots.push(x), hqLog: e => logs.push(e), connect: () => client, bodycam: n => `wss://hq.example/ws/publish?u=${n}` });
  l.apply();
  client.emit('connect');
  const msg = (topic, obj) => l.message(topic, Buffer.from(JSON.stringify(obj)));
  return { l, data, client, cots, logs, msg };
}

test('profile rules are the same as on the device', () => {
  const p = normProfile({ ble: 'radio', sdr: 'adsb', position_interval: 'x', bodycam: { url: 'http://x', framesize: 3 } });
  assert.equal(p.ble, 'mesh');
  assert.equal(p.sdr, 'adsb');
  assert.equal(p.position_interval, 0);
  assert.equal(p.bodycam.url, '');
  assert.equal(p.bodycam.framesize, 5);
});

test('a new device gets the defaults (retained profile) and appears in TAK at its GPS position', () => {
  const { l, data, client, cots, logs, msg } = setup({ defaults: { ble: 'mesh', gateway: 'rx', sdr: 'adsb' } });
  msg('lpu5/lpu5-1/status', { online: true, uplink: 'Cafe', mesh: true, gps: { lat: 48.1, lon: 11.5 }, profile: {} });
  assert.ok(data.nodes['lpu5-1'].adopted);
  const prof = client.published.find(p => p.topic === 'lpu5/lpu5-1/profile');
  assert.equal(JSON.parse(prof.payload).sdr, 'adsb');
  assert.equal(prof.opts.retain, true);
  assert.match(cots[0], /uid="LPU5-lpu5-1"/);
  assert.match(cots[0], /role="RTO"/);
  assert.match(cots[0], /lat="48.1"/);
  assert.equal(logs.length, 1);
  assert.equal(l.view().nodes[0].online, true);
});

test('without automatic approval a new device waits; the helmet camera gets its stream address', () => {
  const { l, data, client, msg } = setup({ autoAdopt: false });
  msg('lpu5/lpu5-2/status', { online: true });
  assert.equal(data.nodes['lpu5-2'].adopted, false);
  assert.equal(client.published.filter(p => p.topic.endsWith('/profile')).length, 0);
  l.setNode('lpu5-2', { adopted: true, profile: { ble: 'bodycam' } });
  const prof = JSON.parse(client.published.find(p => p.topic === 'lpu5/lpu5-2/profile').payload);
  assert.equal(prof.ble, 'bodycam');
  assert.equal(prof.bodycam.url, 'wss://hq.example/ws/publish?u=lpu5-2');
  assert.equal(data.nodes['lpu5-2'].profile.bodycam.url, ''); // the address is not stored, it is made when sending
});

test('commands and Meshtastic operations wait for the answer of the device', async () => {
  const { l, client, msg } = setup();
  const p = l.request('lpu5-1', { op: 'mesh.info' });
  const sent = client.published.find(x => x.topic === 'lpu5/lpu5-1/cmd');
  const { id, op } = JSON.parse(sent.payload);
  assert.equal(op, 'mesh.info');
  msg('lpu5/lpu5-1/cmd/result', { id, ok: true, data: { my: { id: '!1' } } });
  const r = await p;
  assert.equal(r.data.my.id, '!1');
  await assert.rejects(l.request('../x', { cmd: 'status' }));
});

test('aircraft go to TAK once per 10 s and only near the device', () => {
  const { cots, msg } = setup({ gateway: { adsbToTak: true, adsbMaxKm: 50 } });
  msg('lpu5/lpu5-1/status', { online: true, gps: { lat: 48, lon: 11 } });
  cots.length = 0;
  const a = { hex: '3c6586', flight: 'DLH4AB', lat: 48.1, lon: 11.1, alt_ft: 10000, track: 90, speed_kt: 250, category: 'A3' };
  msg('lpu5/lpu5-1/adsb', { aircraft: [a, { ...a, hex: 'aaaaaa', lat: 52 }] });
  msg('lpu5/lpu5-2/adsb', { aircraft: [a] });
  assert.equal(cots.length, 1);
  assert.match(cots[0], /uid="ICAO-3c6586"/);
  assert.match(cots[0], /type="a-n-A-C-F"/);
  assert.match(cots[0], /hae="3048"/);
  assert.match(aircraftCot({ ...a, category: 'A7' }, 'x'), /a-n-A-C-H/);
});

// ---------------- gateway ----------------

const packet = ({ from, port, payload, id = 77, channel = 0 }) => Buffer.from(new P.Writer().fixed(1, from).fixed(2, P.BROADCAST).uint(3, channel)
  .msg(4, new P.Writer().uint(1, port).bytes(2, payload)).fixed(6, id).done()).toString('base64');

function gw(opts = {}) {
  const cots = [], sent = [];
  const g = new MeshGateway({ send: (name, p) => sent.push({ name, ...p }), radios: () => ['lpu5-1', 'lpu5-2'], cot: x => cots.push(x), settings: () => ({ channel: 1, nodesToTak: !!opts.nodes }), delayMs: () => 5 });
  return { g, cots, sent };
}

test('up: a TAK position from LoRa becomes a marked contact – once, even if two devices heard it', () => {
  const { g, cots } = gw();
  const pli = P.takPli({ callsign: 'BRAVO 1', uid: 'ANDROID-1', team: 'Red', role: 'Medic', lat: 48.2, lon: 11.6 });
  const b64 = packet({ from: 0x1234, port: P.PORT.ATAK, payload: pli });
  g.rx('lpu5-1', { b64 });
  g.rx('lpu5-2', { b64 });
  assert.equal(cots.length, 1);
  assert.match(cots[0], /uid="ANDROID-1"/);
  assert.ok(cots[0].includes('<' + MARK + '/>'));
  g.stop();
});

test('up: packets from an LPU5 radio itself are not passed up again (no loop)', () => {
  const { g, cots } = gw();
  g.radio('lpu5-1', 0x5555);
  g.rx('lpu5-2', { b64: packet({ from: 0x5555, port: P.PORT.ATAK, payload: P.takPli({ callsign: 'X', uid: 'U', lat: 1, lon: 2 }) }) });
  assert.equal(cots.length, 0);
  g.stop();
});

test('up: a marker over port 257 (zlib CoT); plain nodes only when switched on', () => {
  const { g, cots } = gw({ nodes: true });
  const now = new Date().toISOString();
  const cot = `<event version="2.0" uid="m1" type="a-h-G" how="h-g-i-g-o" time="${now}" start="${now}" stale="${now}"><point lat="1" lon="2" hae="0" ce="9" le="9"/><detail><contact callsign="Enemy"/></detail></event>`;
  g.rx('lpu5-1', { b64: packet({ from: 0x99, port: P.PORT.FORWARDER, payload: zlib.deflateSync(Buffer.from(cot)), id: 5 }) });
  assert.equal(cots.length, 1);
  assert.match(cots[0], /uid="m1"/);
  g.nodes('lpu5-1', { nodes: [{ num: 0x42, long_name: 'Hans -5', lat: 47, lon: 8, last_heard: Math.floor(Date.now() / 1000) }] });
  assert.equal(cots.length, 2);
  assert.match(cots[1], /uid="MESH-!00000042"/);
  assert.match(cots[1], /name="Red"/);
  g.stop();
});

test('down: TAK position and chat go out on the TAK channel through every sending device, at most every 5 min', async () => {
  const { g, sent } = gw();
  const now = new Date();
  const stale = new Date(+now + 60000).toISOString();
  const pli = `<event version="2.0" uid="ANDROID-7" type="a-f-G-U-C" how="m-g" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale}"><point lat="48.5" lon="11.5" hae="500" ce="9" le="9"/><detail><contact callsign="ALPHA 7"/><__group name="Blue" role="Team Lead"/><track course="90" speed="2"/></detail></event>`;
  g.fromTak(pli);
  g.fromTak(pli.replace(/time="[^"]*"/, `time="${new Date(+now + 1000).toISOString()}"`));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sent.length, 2); // two devices, one packet each
  assert.deepEqual(sent.map(s => s.name), ['lpu5-1', 'lpu5-2']);
  assert.equal(sent[0].channel, 1);
  const t = P.parseTak(new Uint8Array(Buffer.from(sent[0].payload, 'base64')));
  assert.equal(t.callsign, 'ALPHA 7');
  assert.equal(t.team, 'Blue');
  assert.equal(t.role, 'Team Lead');
  // replayed content after connecting and marked content stay off LoRa
  g.fromTak(pli.replace('ANDROID-7', 'ANDROID-8'), { replay: true });
  g.fromTak(pli.replace('ANDROID-7', 'ANDROID-9').replace('</detail>', `<${MARK}/></detail>`));
  const chat = `<event version="2.0" uid="GeoChat.ANDROID-7.All Chat Rooms.abc" type="b-t-f" how="h-g-i-g-o" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale}"><point lat="0" lon="0" hae="0" ce="9" le="9"/><detail><__chat messageId="abc" senderCallsign="ALPHA 7" chatroom="All Chat Rooms" id="All Chat Rooms"/><link uid="ANDROID-7"/><remarks source="x">Hallo Feld</remarks></detail></event>`;
  g.fromTak(chat);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sent.length, 4);
  const c = P.parseTak(new Uint8Array(Buffer.from(sent[2].payload, 'base64')));
  assert.equal(c.chat.message, 'Hallo Feld');
  g.stop();
});

test('down: a large drawing goes as fountain blocks the receiver puts together again', async () => {
  const { g, sent } = gw();
  const now = new Date().toISOString();
  const pts = Array.from({ length: 40 }, (_, i) => `<link point="${(48 + i / 1000).toFixed(6)},${(11 + i / 997).toFixed(6)}"/>`).join('');
  const shape = `<event version="2.0" uid="route-1" type="u-d-f" how="h-e" time="${now}" start="${now}" stale="${now}"><point lat="48" lon="11" hae="0" ce="9" le="9"/><detail>${pts}<strokeColor value="-1"/><contact callsign="Route"/><precisionlocation altsrc="x"/></detail></event>`;
  g.fromTak(shape);
  await new Promise(r => setTimeout(r, 50));
  const blocks = sent.filter(s => s.name === 'lpu5-1');
  assert.ok(blocks.length > 1);
  // receiving side: a second gateway decodes the blocks (content is marked, so it is not passed up again)
  const rx = gw();
  const got = [];
  rx.g.rxCot = b => got.push(Buffer.from(b).toString());
  blocks.forEach((b, i) => rx.g.rx('lpu5-9', { b64: packet({ from: 0x77, port: P.PORT.FORWARDER, payload: Buffer.from(b.payload, 'base64'), id: 100 + i }) }));
  assert.equal(got.length, 1);
  assert.match(got[0], /uid="route-1"/);
  assert.doesNotMatch(got[0], /precisionlocation/); // slimmed for LoRa
  assert.ok(rx.sent.length >= 1); // ACK back over the device that heard it
  g.stop(); rx.g.stop();
});

test('slimCot keeps what TAK clients need', () => {
  const x = slimCot('<?xml version="1.0"?><event version="2.0" uid="a" type="a-h-G" access="Undefined" how="h" time="t" start="t" stale="t"><point lat="48.123456789" lon="11.1" hae="512.7" ce="9" le="9"/><detail><contact callsign="X"/><status readiness="true"/><remarks source="y">hi</remarks><archive/><archive/></detail></event>');
  assert.match(x, /lat="48.123457"/);
  assert.match(x, /hae="513"/);
  assert.doesNotMatch(x, /access=/);
  assert.doesNotMatch(x, /status/);
  assert.match(x, /<remarks>hi<\/remarks>/);
  assert.equal((x.match(/<archive/g) || []).length, 1);
});

test('the view with a gateway attached (the server wires both together)', () => {
  const data = { enabled: true, url: 'mqtt://x' };
  const client = fakeMqtt();
  let l;
  const g = new MeshGateway({ send: () => {}, radios: () => l.gatewayRadios(), cot: () => {} });
  l = new Lpu5({ data: () => data, save: () => {}, gateway: g, connect: () => client });
  l.apply();
  client.emit('connect');
  l.message('lpu5/lpu5-1/status', Buffer.from(JSON.stringify({ online: true, mesh: true, mesh_num: 1 })));
  l.message('lpu5/lpu5-2/status', Buffer.from(JSON.stringify({ online: true, mesh: false })));
  const v = l.view();
  assert.equal(v.gatewayStats.radios, 1);
  assert.deepEqual(l.gatewayRadios(), ['lpu5-1']);
  l.setNode('lpu5-1', { profile: { gateway: 'rx' } });
  assert.deepEqual(l.gatewayRadios(), []);
  g.stop(); l.stop();
});
