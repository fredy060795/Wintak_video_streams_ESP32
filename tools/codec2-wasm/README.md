# Codec 2 for TAKweb (voice messages over Meshtastic)

`public/eud/codec2.wasm` is **Codec 2** by David Rowe and contributors, compiled to WebAssembly – unchanged
sources from https://github.com/drowe67/codec2 at revision `310777b1c6f1af0bc7c72f5b32f80f6fd9136962`, only the speech codec (no modems).

Codec 2 is licensed under the **GNU Lesser General Public License 2.1** (`COPYING.LGPL-2.1` in this folder).
You may rebuild and replace `codec2.wasm` with your own build of Codec 2 (modified or not): `sh tools/codec2-wasm/build.sh`
(`CODEC2_REV=<commit>` for another revision). The interface is `api.c` (c2_create, c2_encode, c2_decode …), used by
`public/eud/codec2.js`.

Files here (TAKweb, not part of Codec 2):
- `shim.c`, `inc/` – a minimal C runtime for the browser (memory, strings, no files); the maths functions
  (sin, cos, exp, log, pow …) are imported from JavaScript.
- `api.c` – the exported functions.
- `build.sh` – the build.
