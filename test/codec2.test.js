// Voice messages over Meshtastic: Codec 2 as WebAssembly (public/eud/codec2.wasm, built from the official sources –
// tools/codec2-wasm/) must give exactly the bits of the native Codec 2; LoRa packets of a voice message
// (public/eud/meshproto.js) arrive complete also when packets get lost and are asked for again.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C2 = require('../public/eud/codec2');
const P = require('../public/eud/meshproto');

const WASM = fs.readFileSync(path.join(__dirname, '..', 'public', 'eud', 'codec2.wasm'));

// the same signal the reference was made from with the native c2enc (2 s, voiced speech with pauses)
function synth() {
  const n = 16000, pcm = new Int16Array(n);
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / 8000, f0 = 110 + 40 * Math.sin(t * 3);
    ph += 2 * Math.PI * f0 / 8000;
    let s = 0;
    for (let h = 1; h < 30; h++) {
      const fh = h * f0;
      const env = Math.exp(-((fh - 700) ** 2) / 2e5) + 0.6 * Math.exp(-((fh - 1200) ** 2) / 3e5) + 0.3 * Math.exp(-((fh - 2500) ** 2) / 5e5);
      s += env * Math.sin(h * ph);
    }
    const v = (Math.floor(t * 4) % 4 === 3) ? 0.15 * rnd() : s * 0.25;
    pcm[i] = Math.round(Math.max(-1, Math.min(1, v)) * 20000);
  }
  return pcm;
}

test('codec2: WebAssembly gives exactly the bits of the native Codec 2 (1300 bit/s), decodes back to 8 kHz', async () => {
  const pcm = synth();
  const bits = await C2.encode(pcm, 1300, WASM);
  const ref = fs.readFileSync(path.join(__dirname, 'fixtures', 'codec2-synth-1300.bit'));
  assert.equal(bits.length, ref.length);
  assert.deepEqual(Buffer.from(bits), ref, 'bit-identical to native c2enc');
  assert.equal(bits.length, 2 * 1300 / 8 + 25, '2 s at 1300 bit/s: 50 frames of 7 bytes');
  const back = await C2.decode(bits, 1300, WASM);
  assert.equal(back.length, 16000);
  const energy = back.reduce((a, x) => a + x * x, 0) / back.length;
  assert.ok(energy > 1e5, 'speech comes back');
});

test('voice packets: a 15 s message, packets lost on the way, asked for again, complete and identical', () => {
  const bits = Uint8Array.from({ length: 2438 }, (_, i) => (i * 37) & 255); // 15 s at 1300 bit/s
  const id = '0123456789abcdef';
  const packets = P.voicePackets({ id, from: 'EUD-A', callsign: 'ALPHA 1', to: 'EUD-B', mode: 1300, ms: 15000, bits });
  assert.equal(packets.length, 1 + Math.ceil(2438 / P.VOICE_CHUNK));
  assert.ok(packets.every(p => p.length <= 213), 'fits a LoRa packet');
  const asm = new P.VoiceAssembler();
  let done = null;
  const lost = new Set([3, 7]);
  packets.forEach((p, i) => { if (!lost.has(i)) done = asm.add(P.parseVoice(p), 0) || done; });
  assert.equal(done, null, 'incomplete');
  const [req] = asm.stale(20000, 15000);
  assert.deepEqual(req, { id, missing: [3, 7] });
  const r = P.parseVoice(P.voiceRequest(req.id, req.missing));
  assert.equal(r.kind, 1);
  assert.deepEqual([...r.data], [3, 7]);
  for (const i of r.data) done = asm.add(P.parseVoice(packets[i]), 20001) || done;
  assert.equal(done.id, id);
  assert.equal(done.from, 'EUD-A');
  assert.equal(done.callsign, 'ALPHA 1');
  assert.equal(done.to, 'EUD-B');
  assert.equal(done.ms, 15000);
  assert.deepEqual(done.bits, bits);
  assert.equal(asm.add(P.parseVoice(packets[0]), 20002), null, 'a repeated packet does not deliver it twice');
  assert.equal(P.parseVoice(Uint8Array.from([1, 2, 3])), null, 'other data on port 256 is ignored');
});
