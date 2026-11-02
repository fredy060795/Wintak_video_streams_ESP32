// Codec 2 (David Rowe, LGPL-2.1, github.com/drowe67/codec2) as WebAssembly for voice messages over Meshtastic:
// 8 kHz speech in 1300 bit/s – 10 s are ~1.6 KB, a few LoRa packets. codec2.wasm is built from the official sources
// (tools/codec2-wasm/: build script, minimal C runtime, licence); the maths comes from JavaScript.
// Works in the browser (window.Codec2) and in Node (tests).
'use strict';

(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.Codec2 = m;
}(typeof self !== 'undefined' ? self : this, () => {
  const MODES = { 3200: 0, 2400: 1, 1600: 2, 1400: 3, 1300: 4, 1200: 5, '700C': 8 };
  const roundf = x => (x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5));
  const env = {
    expf: Math.exp, cosf: Math.cos, sinf: Math.sin, powf: Math.pow, pow: Math.pow, log10f: Math.log10, logf: Math.log,
    atan2f: Math.atan2, acosf: Math.acos, roundf,
  };

  let ready = null;
  // bytes: the wasm file (ArrayBuffer / Buffer) – in the browser it is fetched from url
  function load(bytes, url = 'codec2.wasm') {
    if (ready) return ready;
    const src = bytes ? Promise.resolve(bytes) : fetch(url).then(r => { if (!r.ok) throw new Error('codec2.wasm not found'); return r.arrayBuffer(); });
    ready = src.then(b => WebAssembly.instantiate(b, { env })).then(r => r.instance.exports).catch(e => { ready = null; throw e; });
    return ready;
  }

  // encode Int16 PCM (8 kHz mono) -> Uint8Array of codec 2 frames
  async function encode(pcm, mode = 1300, wasm) {
    const x = await load(wasm);
    const c = x.c2_create(MODES[mode]);
    const n = x.c2_samples(c), nb = x.c2_bytes(c);
    const frames = Math.ceil(pcm.length / n);
    const sp = x.c2_malloc(n * 2), bp = x.c2_malloc(nb);
    const out = new Uint8Array(frames * nb);
    for (let f = 0; f < frames; f++) {
      const chunk = new Int16Array(n);
      chunk.set(pcm.subarray(f * n, Math.min(pcm.length, (f + 1) * n)));
      new Int16Array(x.memory.buffer, sp, n).set(chunk);
      x.c2_encode(c, bp, sp);
      out.set(new Uint8Array(x.memory.buffer, bp, nb), f * nb);
    }
    x.c2_free(sp); x.c2_free(bp);
    return out;
  }

  // decode codec 2 frames -> Int16 PCM (8 kHz mono)
  async function decode(bits, mode = 1300, wasm) {
    const x = await load(wasm);
    const c = x.c2_create(MODES[mode]);
    const n = x.c2_samples(c), nb = x.c2_bytes(c);
    const frames = Math.floor(bits.length / nb);
    const sp = x.c2_malloc(n * 2), bp = x.c2_malloc(nb);
    const out = new Int16Array(frames * n);
    for (let f = 0; f < frames; f++) {
      new Uint8Array(x.memory.buffer, bp, nb).set(bits.subarray(f * nb, (f + 1) * nb));
      x.c2_decode(c, sp, bp);
      out.set(new Int16Array(x.memory.buffer, sp, n), f * n);
    }
    x.c2_free(sp); x.c2_free(bp);
    return out;
  }

  // bytes per second of a mode (for the length limit)
  const rate = mode => Number(String(mode).replace(/\D/g, '')) / 8;

  return { load, encode, decode, rate, MODES };
}));
