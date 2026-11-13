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

test('netmap: WebTAK Server names the MQTT gateway – exact line with hops, the radio counts as gateway', () => {
  const { net, feed } = make();
  const mq = (uid, lat, lon, id, gw, hops) => ots(uid, lat, lon, id).replace('</detail>', `<__mqtt gateway="!${gw}" channel="TAK" hops="${hops}" snr="5.0" rssi="-90"/></detail>`);
  feed(mq('0000c0de', 47.2, 11.2, '0000c0de', '0000c0de', 0)); // the gateway radio itself
  feed(mq('ANDROID-9', 47.3, 11.3, '00000009', '0000c0de', 2));
  feed(ots('0000f00d', 47.0, 11.0, '0000f00d'));                // another radio, not uplinking (OTS-style, no gateway named)
  const p = net.picture();
  const k = Object.fromEntries(p.nodes.map(n => [n.uid, n]));
  assert.equal(k['0000c0de'].kind, 'gateway');
  assert.equal(k['0000c0de'].gatewayType, 'radio');
  assert.equal(k['0000c0de'].traffic, 2);
  assert.equal(k['ANDROID-9'].gateway, '0000c0de');
  const e = p.edges.find(x => x.from === 'ANDROID-9');
  assert.deepEqual([e.to, e.kind, e.assumed, e.hops], ['0000c0de', 'mqtt', undefined, 2]);
  assert.equal(p.edges.find(x => x.from === '0000f00d').assumed, true, 'without a named gateway: nearest, assumed');
});

test('netmap: radio quality per cell, radios from WebTAK Server without GPS, alarms once while they last', () => {
  const radios = { '0000c0de': { role: 'gateway', name: 'Roof' }, '0000aaaa': { role: 'field', name: 'Tracker' } };
  const { net, feed } = make(radios);
  const mq = (uid, lat, lon, id, gw, hops, snr) => ots(uid, lat, lon, id).replace('</detail>', `<__mqtt gateway="!${gw}" channel="TAK" hops="${hops}" snr="${snr}" rssi="-90"/></detail>`);
  feed(mq('ANDROID-1', 47.2001, 11.2001, '00000001', '0000c0de', 0, 7.5));
  feed(mq('ANDROID-2', 47.3001, 11.3001, '00000002', '0000c0de', 2, 1));
  let p = net.picture();
  const q = Object.fromEntries(p.quality.map(c => [cellKey(c[0] + 1e-6, c[1] + 1e-6), c]));
  assert.deepEqual(q[cellKey(47.2001, 11.2001)].slice(2, 5), [0, 7.5, 1]);
  assert.deepEqual(q[cellKey(47.3001, 11.3001)].slice(2, 4), [2, null], 'relayed: no SNR');
  // WebTAK Server: the roof gateway has no GPS, the tracker was heard 40 min ago with 10 % battery
  const t0 = Date.now();
  net.status = {
    gateways: [{ gateway: '!0000c0de', channel: 'TAK', packets: 50, last: new Date(t0).toISOString() }],
    nodes: [{ id: '!0000c0de', longName: 'Roof', heard: new Date(t0).toISOString(), gateway: '!0000c0de', hops: 0 },
      { id: '!0000aaaa', longName: 'Tracker', heard: new Date(t0 - 40 * 60000).toISOString(), gateway: '!0000c0de', hops: 1, battery: 10 }],
  };
  p = net.picture(t0);
  assert.equal(p.mesh.gateways[0].located, false, 'no position');
  assert.equal(p.mesh.gateways[0].name, 'Roof');
  assert.equal(p.radios.find(r => r.node === '0000aaaa').seen, t0 - 40 * 60000);
  let alarms = net.check(t0).map(a => a.text);
  assert.ok(alarms.some(a => /Radio Tracker not heard for 40 min/.test(a)), alarms.join(' | '));
  assert.ok(alarms.some(a => /Battery low: Tracker 10 %/.test(a)));
  assert.ok(!alarms.some(a => /Gateway Roof/.test(a)), 'gateway fine');
  assert.deepEqual(net.check(t0 + 60000).filter(a => a.alert), [], 'reported once');
  // 20 min later nothing more from the gateway -> alarm; then it is back
  alarms = net.check(t0 + 20 * 60000).map(a => a.text);
  assert.ok(alarms.some(a => /Gateway Roof silent for 20 min/.test(a)), alarms.join(' | '));
  net.status.gateways[0].last = new Date(t0 + 21 * 60000).toISOString();
  alarms = net.check(t0 + 21 * 60000);
  assert.ok(alarms.some(a => !a.alert && /Gateway Roof is back/.test(a.text)));
  assert.ok(net.picture().alarms.length >= 4);
});

test('netmap: a phone gateway that goes offline raises an alarm', () => {
  const { net, feed, hq } = make();
  feed(pli('PHONE-GW', 47.0, 11.0, '<__takwebnet radio="ble" bridge="1" node="!12345678"/>'));
  const t0 = Date.now();
  assert.deepEqual(net.check(t0), []);
  hq.live.get('PHONE-GW').stale = t0 - 1; hq.live.get('PHONE-GW').time = t0 - 200000;
  const a = net.check(t0 + 16 * 60000);
  assert.ok(a.some(x => x.alert && /PHONE-GW \(phone gateway\) silent/.test(x.text)), JSON.stringify(a));
});
