// Tests the Meshtastic protocol of the EUD (public/eud/meshproto.js). The expected bytes were made with
// protobufjs from the official Meshtastic .proto files (github.com/meshtastic/protobufs), so the
// encoder and decoder match the firmware and the Meshtastic ATAK plugin.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/eud/meshproto');

const hex = b => Buffer.from(b).toString('hex');
const bytes = h => new Uint8Array(Buffer.from(h, 'hex'));

test('encodes TAK packets (PLI, GeoChat) like the ATAK plugin', () => {
  const pli = P.takPli({ callsign: 'ALPHA 2', uid: 'EUD-ABC', team: 'Dark Blue', role: 'Medic', battery: 77, lat: 47.9135123, lon: -7.893, alt: -12, speed: 2, course: 270 });
  assert.equal(hex(pli), '12120a07414c504841203212074555442d4142431a04080510082202084d2a1a0d93058f1c15b09f4bfb18f4ffffffffffffffff012002288e02');
  const chat = P.takChat({ callsign: 'ALPHA 2', uid: 'EUD-ABC', msgId: 'm1', message: 'Hallo äö' });
  assert.equal(hex(chat), '12150a07414c5048412032120a4555442d4142437c6d31321c0a0a48616c6c6f20c3a4c3b6120e416c6c204368617420526f6f6d73');
  // unknown team/role -> Cyan / Team Member (ATAK defaults)
  const t = P.parseTak(P.takPli({ callsign: 'X', uid: 'U', team: 'Pink', role: 'Boss', lat: 1, lon: 2 }));
  assert.equal(t.team, 'Cyan');
  assert.equal(t.role, 'Team Member');
});

test('encodes ToRadio: packet with hop limit, want_config', () => {
  const tr = P.toRadioPacket({ portnum: P.PORT.TEXT, payload: P.utf8.encode('hi'), channel: 1, id: 0xdeadbeef });
  assert.equal(hex(tr), '0a1615ffffffff1801220608011202686935efbeadde4803');
  assert.equal(hex(P.wantConfig(123456789)), '18959aef3a');
});

test('decodes FromRadio: TAK packet, text, my info, node, channel, config complete', () => {
  let m = P.parseFromRadio(bytes('12590dd4c3b2a115ffffffff22430848123f12180a07425241564f2031120d414e44524f49442d317c6162631a040802100c220208322a190d18058f1c15b09f4bfb18fbffffffffffffffff012003285a352a0000003d00f15365'));
  assert.equal(m.kind, 'packet');
  assert.equal(m.packet.from, 0xa1b2c3d4);
  assert.equal(m.packet.to, P.BROADCAST);
  assert.equal(m.packet.portnum, P.PORT.ATAK);
  const tak = P.parseTak(m.packet.payload);
  assert.deepEqual(tak, {
    compressed: false, callsign: 'BRAVO 1', uid: 'ANDROID-1', msgId: 'abc', team: 'Green', role: 'Team Lead', battery: 50,
    pli: { lat: 47.9135, lon: -7.893, alt: -5, speed: 3, course: 90 }, chat: null,
  });

  m = P.parseFromRadio(bytes('12200d4433221115ffffffff220f0801120b4772c3bcc39f20646963683507000000'));
  assert.equal(m.packet.portnum, P.PORT.TEXT);
  assert.equal(new TextDecoder().decode(m.packet.payload), 'Grüß dich');

  assert.deepEqual(P.parseFromRadio(bytes('1a060898f5f2f60f')), { kind: 'myInfo', nodeNum: 0xfedcba98 });
  assert.deepEqual(P.parseFromRadio(bytes('223808d209121a0a09213030303030346432120948616e73204d6573681a02484d1a120d00389c1c15c071b50418ac022500f153652d64f15365')), {
    kind: 'nodeInfo',
    node: { num: 1234, user: { id: '!000004d2', longName: 'Hans Mesh', shortName: 'HM' }, position: { lat: 48, lon: 7.9, alt: 300, time: 1700000000, speed: null, course: null }, lastHeard: 1700000100 },
  });
  assert.deepEqual(P.parseFromRadio(bytes('52120801120c1201011a07416972736f66741802')), { kind: 'channel', channel: { index: 1, role: 2, name: 'Airsoft', key: 'default' } });
  assert.deepEqual(P.parseFromRadio(bytes('3863')), { kind: 'configComplete', id: 99 });
  assert.deepEqual(P.parsePositionPayload(bytes('0d4045cbeb15004a1f5a78048001b401')), { lat: -33.9, lon: 151.2, alt: null, time: 0, speed: 4, course: 180 });
  assert.throws(() => P.decode(bytes('0a05ff')), /truncated/);
});

test('CoT from mesh packets: contact, chat, Meshtastic node', () => {
  const now = new Date('2026-10-25T10:00:00.000Z');
  const tak = P.parseTak(P.takPli({ callsign: 'A<1>', uid: 'ANDROID-1', team: 'Red', role: 'HQ', battery: 40, lat: 47.5, lon: 8.25, alt: 400, speed: 1, course: 45 }));
  const pli = P.pliCot(tak, 0x1234, now);
  assert.match(pli, /uid="ANDROID-1" type="a-f-G-U-C"/);
  assert.match(pli, /callsign="A&lt;1&gt;"/);
  assert.match(pli, /<__group name="Red" role="HQ"\/>/);
  assert.match(pli, /lat="47.5" lon="8.25" hae="400"/);
  assert.match(pli, /stale="2026-10-25T10:10:00.000Z"/);

  const all = P.chatCot({ senderUid: 'ANDROID-1', senderCallsign: 'BRAVO 1', msgId: 'abc', text: 'Contact & go', now });
  assert.match(all, /uid="GeoChat.ANDROID-1.All Chat Rooms.abc" type="b-t-f"/);
  assert.match(all, /chatroom="All Chat Rooms" id="All Chat Rooms" senderCallsign="BRAVO 1"/);
  assert.match(all, />Contact &amp; go<\/remarks>/);
  const direct = P.chatCot({ senderUid: 'ANDROID-1', senderCallsign: 'BRAVO 1', msgId: 'x', text: 'hi', toUid: 'EUD-ME', now });
  assert.match(direct, /chatroom="BRAVO 1" id="EUD-ME"/);

  const node = P.nodeCot({ num: 1234, user: { longName: 'Hans Mesh', shortName: 'HM' }, position: { lat: 48, lon: 7.9, alt: 300, time: 1792922400 } }, now);
  assert.match(node, /uid="MESH-!000004d2"/);
  assert.match(node, /callsign="Hans Mesh"/);
  assert.match(node, /time="2026-10-25T10:00:00.000Z"/, 'future position time is capped to now');
});

test('Meshtastic nodes as users with the team from the name (like the ATAK plugin)', () => {
  assert.deepEqual(P.nodeTeam('Hans -5'), { callsign: 'Hans', team: 'Red' });
  assert.deepEqual(P.nodeTeam('Lead -0'), { callsign: 'Lead', team: 'White' });
  assert.deepEqual(P.nodeTeam('Anna'), { callsign: 'Anna', team: 'Cyan' });
  const xml = P.nodeCot({ num: 1, user: { longName: 'Charlie -12' }, position: { lat: 48, lon: 14, time: 0 } });
  assert.match(xml, /type="a-f-G-E-S"/);
  assert.match(xml, /<contact callsign="Charlie"\/><__group name="Green" role="Team Member"\/>/);
});

// reference values from the plugin's Java code (FountainCodec/FountainPacket, java.util.Random)
test('fountain code (port 257) is bit-identical to the Meshtastic ATAK plugin', () => {
  const r = new P.JavaRandom(42);
  assert.deepEqual([r.nextInt(1), r.nextInt(214), r.nextDouble(), r.nextInt(64)], [0, 67, 0.6832234717598454, 19]);
  assert.deepEqual([r.nextInt(2), r.nextInt(214), r.nextDouble(), r.nextInt(64)], [1, 69, 0.7077105889551186, 5]);

  const data = Uint8Array.from({ length: 500 }, (_, i) => (i * 7 + 3) & 255);
  const pkts = P.fountainEncode(data, 5, 0x123456);
  assert.equal(require('crypto').createHash('sha256').update(pkts.map(hex).join('')).digest('hex'),
    '7c0b6198f4333d1845066dd38f19441a01d619d1b1918b4b8f6e19d1f50087c8');
  assert.equal(hex(pkts[0].subarray(0, 11)), '46544e12345673460301f4');
  assert.equal(P.fountainBlockCount(3), 5);

  // the blocks in any order give the data back
  const blocks = [pkts[4], pkts[2], pkts[0], pkts[3], pkts[1]].map(b => P.parseFountain(b).block);
  let out = null;
  for (let i = 1; i <= blocks.length && !out; i++) out = P.fountainDecode(blocks.slice(0, i), 3, 500, 0x123456);
  assert.deepEqual(out, data);

  const ack = P.fountainAck(0x123456, P.FOUNTAIN.COMPLETE, 4, 0, bytes('ba626314ec76f1ea'));
  assert.equal(hex(ack), '46544e1234560200040000ba626314ec76f1ea');
  assert.deepEqual(P.parseFountain(ack).ack, { transferId: 0x123456, type: 2, received: 4, needed: 0, hash: bytes('ba626314ec76f1ea') });
  assert.equal(P.parseFountain(P.utf8.encode('x\u009c...')), null, 'plain zlib CoT is no fountain packet');
});
