// Network picture (lib/netmap.js): own internet / phone gateway over LoRa / MQTT gateway radio, coverage cells, lost connections.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Hq } = require('../lib/hq');
const { Netmap, route, hexId, cellKey } = require('../lib/netmap');

const iso = t => new Date(t).toISOString();
const pli = (uid, lat, lon, detail = '', stale = 120000) => {
  const t = Date.now();
  return `<event version="2.0" uid="${uid}" type="a-f-G-U-C" how="m-g" time="${iso(t)}" start="${iso(t)}" stale="${iso(t + stale)}">`
    + `<point lat="${lat}" lon="${lon}" hae="200" ce="9" le="9"/><detail><contact callsign="${uid}" endpoint="*:-1:stcp"/>`
    + `<__group name="Cyan" role="Team Member"/>${detail}</detail></event>`;
};
const ots = (uid, lat, lon, meshId) => `<event version="2.0" uid="${uid}" type="a-f-G-U-C" how="m-g" time="${iso(Date.now())}" start="${iso(Date.now())}" stale="${iso(Date.now() + 600000)}">`
  + `<point lat="${lat}" lon="${lon}" hae="0" ce="9" le="9"/><detail><takv device="HELTEC_V3" platform="Meshtastic" os="Meshtastic" meshtastic_id="${meshId}"/>`
  + `<contact callsign="${uid}" endpoint="MQTT"/><__group name="Cyan" role="Team Member"/></detail></event>`;

function make(radios = {}) {
  const store = {};
  const hq = new Hq({ data: () => store, save: () => {} });
  const net = new Netmap({ data: () => (store.net = store.net || {}), save: () => {}, hq, radios: () => radios });
  const feed = xml => { hq.cot(xml); net.cot(xml); };
  return { hq, net, feed, store };
}

test('netmap: route of a CoT – own internet, phone gateway (LoRa), MQTT', () => {
  assert.equal(route(pli('A', 1, 1)).link, 'internet');
  const r = route(pli('B', 1, 1, '<__meshtastic/><__takwebmesh gw="PHONE-1"/>'));
  assert.deepEqual([r.link, r.via], ['lora', 'PHONE-1']);
  assert.equal(route(pli('C', 1, 1, '<__takwebmesh/>')).via, '', 'old TAKweb without the gateway id');
  const m = route(ots('a1b2c3d4', 1, 1, 'a1b2c3d4'));
  assert.deepEqual([m.link, m.meshId], ['mqtt', 'a1b2c3d4']);
  const n = route(pli('D', 1, 1, '<__takwebnet radio="ble" bridge="1" node="!00c0ffee"/>'));
  assert.deepEqual(n.net, { radio: 'ble', bridge: true, node: '00c0ffee' });
  assert.equal(hexId('!C0FFEE'), '00c0ffee');
  assert.equal(hexId('PHONE'), '');
});

test('netmap: gateways, mesh-only devices and their lines', () => {
  const { net, feed } = make({ '0000beef': { role: 'gateway', name: 'Heltec V3', ssid: 'TAKweb-HQ' } });
  feed(pli('PHONE-1', 47.0, 11.0, '<__takwebnet radio="ble" bridge="1" node="!12345678"/>'));
  feed(pli('ONLINE-1', 47.1, 11.1));
  feed(pli('FIELD-1', 47.05, 11.05, '<__meshtastic/><__takwebmesh gw="PHONE-1"/>'));
  feed(ots('beef', 47.2, 11.2, 'beef'));           // the HQ gateway radio itself (OTS writes the id without zeros)
  feed(ots('aaaa0001', 47.3, 11.3, 'aaaa0001'));   // a radio heard over MQTT
  const p = net.picture();
  const k = Object.fromEntries(p.nodes.map(n => [n.uid, n]));
  assert.equal(k['PHONE-1'].kind, 'gateway');
  assert.equal(k['PHONE-1'].gatewayType, 'phone');
  assert.equal(k['PHONE-1'].traffic, 1, 'passed FIELD-1 on');
  assert.equal(k['ONLINE-1'].kind, 'internet');
  assert.equal(k['FIELD-1'].kind, 'mesh');
  assert.equal(k.beef.kind, 'gateway');
  assert.equal(k.beef.gatewayType, 'radio');
  assert.equal(k.beef.registered.ssid, 'TAKweb-HQ');
  assert.equal(k.aaaa0001.kind, 'mesh');
  assert.deepEqual(p.edges.map(e => [e.from, e.to, e.kind]).sort(), [['FIELD-1', 'PHONE-1', 'lora'], ['aaaa0001', 'beef', 'mqtt']]);
  assert.equal(p.mqtt, 2);
  const reg = p.radios.find(r => r.node === '0000beef');
  assert.ok(reg.online);
  assert.equal(reg.uid, 'beef');
});

test('netmap: coverage cells – internet, mesh only, broken off; once a minute per cell; clear', () => {
  const { net, feed, hq } = make();
  feed(pli('A', 47.0001, 11.0001));
  feed(pli('A', 47.0002, 11.0002));                 // same cell within a minute: not counted again
  feed(pli('B', 47.0003, 11.0003, '<__takwebmesh gw="A"/>'));
  feed(pli('C', 48.0, 12.0, '', -1000));            // already stale
  const cell = net.data().cells[cellKey(47.0001, 11.0001)];
  assert.deepEqual(cell.slice(0, 3), [1, 1, 0]);
  net.sweep();                                       // C was never online: no "broke off"
  assert.equal(net.data().cells[cellKey(48, 12)][2], 0);
  // A goes offline -> broke off at its last position
  hq.live.get('A').stale = Date.now() - 1; hq.live.get('A').time = Date.now() - 200000;
  net.sweep();
  assert.equal(net.data().cells[cellKey(47.0001, 11.0001)][2], 1);
  net.sweep();
  assert.equal(net.data().cells[cellKey(47.0001, 11.0001)][2], 1, 'counted once per loss');
  assert.equal(net.picture().cells.length, 2);
  net.clear();
  assert.equal(net.picture().cells.length, 0);
});
