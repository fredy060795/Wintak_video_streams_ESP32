// Push-to-talk voice (lib/voice.js, public/eud/voice.js): one speaker per channel, audio only from the one who holds
// the floor, busy for the others, released on button up / disconnect; µ-law codec.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Voice } = require('../lib/voice');

function fakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1; ws.bufferedAmount = 0; ws.json = []; ws.bin = [];
  ws.send = (d, o) => { if (o && o.binary) ws.bin.push(d); else ws.json.push(JSON.parse(d)); };
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  return ws;
}
const msg = (ws, m) => ws.emit('message', Buffer.from(JSON.stringify(m)), false);
const last = (ws, type) => ws.json.filter(m => m.type === type).pop();

test('voice: floor control, relay only from the speaker, busy, release on disconnect, channels', () => {
  const v = new Voice();
  const a = fakeWs(), b = fakeWs(), c = fakeWs(), d = fakeWs();
  v.attach(a, { callsign: 'ALPHA 1' }); v.attach(b, { callsign: 'BRAVO 1' }); v.attach(c, { hq: true }); v.attach(d, { callsign: 'CHARLIE' });
  msg(a, { type: 'join', channel: 'All' }); msg(b, { type: 'join', channel: 'All' }); msg(c, { type: 'join', channel: 'All', callsign: 'HQ' });
  msg(d, { type: 'join', channel: 'Red' });
  assert.deepEqual(last(c, 'roster').users.map(u => u.callsign), ['ALPHA 1', 'BRAVO 1', 'HQ']);
  assert.deepEqual(last(c, 'roster').channels, ['All', 'Red']);
  msg(a, { type: 'ptt', on: true });
  assert.equal(last(b, 'floor').talker, 'ALPHA 1');
  assert.equal(last(a, 'floor').me, true);
  msg(b, { type: 'ptt', on: true });
  assert.equal(last(b, 'busy').talker, 'ALPHA 1');
  const frame = Buffer.alloc(480, 0x7f);
  a.emit('message', frame, true);
  b.emit('message', frame, true); // not the speaker: dropped
  assert.equal(b.bin.length, 1); assert.equal(c.bin.length, 1); assert.equal(a.bin.length, 0, 'not back to the speaker');
  assert.equal(d.bin.length, 0, 'other channel hears nothing');
  a.close(); // released on disconnect
  assert.equal(last(b, 'floor').talker, null);
  msg(b, { type: 'ptt', on: true });
  assert.equal(last(c, 'floor').talker, 'BRAVO 1');
  msg(b, { type: 'ptt', on: false });
  assert.equal(last(c, 'floor').talker, null);
});

test('voice: µ-law codec of the app keeps speech within a few percent', () => {
  const sandbox = { window: {}, document: { getElementById: () => null }, location: { protocol: 'https:', host: 'x' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'eud', 'voice.js'), 'utf8'), sandbox);
  const { mulawEncode, DECODE } = sandbox.window.TakVoice.codec;
  for (const s of [0, 0.01, -0.01, 0.2, -0.5, 0.9, -0.99]) {
    const back = DECODE[mulawEncode(s)];
    assert.ok(Math.abs(back - s) <= Math.max(0.002, Math.abs(s) * 0.07), `${s} -> ${back}`);
  }
});
