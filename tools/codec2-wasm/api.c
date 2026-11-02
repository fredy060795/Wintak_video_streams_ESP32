// exported API for JavaScript (public/eud/codec2.js)
#include "codec2.h"
#include <stdlib.h>
__attribute__((export_name("c2_create"))) struct CODEC2 *c2_create(int mode) { return codec2_create(mode); }
__attribute__((export_name("c2_samples"))) int c2_samples(struct CODEC2 *c) { return codec2_samples_per_frame(c); }
__attribute__((export_name("c2_bytes"))) int c2_bytes(struct CODEC2 *c) { return codec2_bytes_per_frame(c); }
__attribute__((export_name("c2_encode"))) void c2_encode(struct CODEC2 *c, unsigned char *bits, short *speech) { codec2_encode(c, bits, speech); }
__attribute__((export_name("c2_decode"))) void c2_decode(struct CODEC2 *c, short *speech, const unsigned char *bits) { codec2_decode(c, speech, bits); }
__attribute__((export_name("c2_malloc"))) void *c2_malloc(int n) { return malloc(n); }
__attribute__((export_name("c2_free"))) void c2_free(void *p) { free(p); }
