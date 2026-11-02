#!/bin/sh
# Builds public/eud/codec2.wasm from the official Codec 2 sources (LGPL-2.1, https://github.com/drowe67/codec2).
# Needs git, cmake, a C compiler and clang with the wasm32 target (wasm-ld). Run from the TAKweb folder:
#   sh tools/codec2-wasm/build.sh
set -e
REV=${CODEC2_REV:-310777b1c6f1af0bc7c72f5b32f80f6fd9136962}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${TMPDIR:-/tmp}/codec2-wasm-build
rm -rf "$WORK" && mkdir -p "$WORK"
git clone -q https://github.com/drowe67/codec2 "$WORK/src"
git -C "$WORK/src" checkout -q "$REV"
# native build once: generates the codebook sources (codebook*.c)
mkdir -p "$WORK/build" && cd "$WORK/build"
cmake -DUNITTEST=OFF -DCMAKE_BUILD_TYPE=Release ../src >/dev/null
make -j4 codec2 >/dev/null
S="$WORK/src/src"; B="$WORK/build/src"
FILES=""
for f in codec2.c lpc.c nlp.c postfilter.c sine.c codec2_fft.c kiss_fft.c kiss_fftr.c interp.c lsp.c mbest.c newamp1.c phase.c quantise.c pack.c; do FILES="$FILES $S/$f"; done
for f in codebook.c codebookd.c codebookjmv.c codebookge.c codebooknewamp1.c codebooknewamp1_energy.c codebooknewamp2.c codebooknewamp2_energy.c; do FILES="$FILES $B/$f"; done
clang --target=wasm32 -O2 -ffreestanding -nostdlib -fno-builtin-malloc -isystem "$HERE/inc" -I"$S" -I"$B" -I"$WORK/build" -DNDEBUG -Wno-everything \
  -Wl,--no-entry -Wl,--allow-undefined -Wl,--export=__heap_base -Wl,-z,stack-size=262144 -Wl,--initial-memory=4194304 \
  -o "$HERE/../../public/eud/codec2.wasm" $FILES "$HERE/shim.c" "$HERE/api.c"
echo "public/eud/codec2.wasm built from Codec 2 $REV"
