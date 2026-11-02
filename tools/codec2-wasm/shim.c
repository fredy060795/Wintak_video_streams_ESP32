// minimal C runtime for codec2 in WebAssembly (TAKweb): memory, strings; math comes from JavaScript (imports)
#include <stddef.h>
#include <stdarg.h>
#include <stdint.h>
extern unsigned char __heap_base;
static uintptr_t brk_ = 0;
typedef struct blk { size_t size; struct blk *next; } blk;
static blk *freelist = 0;
static void *sbrk_(size_t n) {
  if (!brk_) brk_ = ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15;
  uintptr_t old = brk_, nw = (old + n + 15) & ~(uintptr_t)15;
  size_t have = __builtin_wasm_memory_size(0) * 65536;
  if (nw > have) { if (__builtin_wasm_memory_grow(0, (nw - have + 65535) / 65536) == (size_t)-1) return 0; }
  brk_ = nw; return (void *)old;
}
void *malloc(size_t n) {
  n = (n + 15) & ~(size_t)15;
  blk **pp = &freelist;
  for (blk *b = freelist; b; pp = &b->next, b = b->next) if (b->size >= n) { *pp = b->next; return (char *)b + 16; }
  blk *b = sbrk_(n + 16); if (!b) return 0; b->size = n; return (char *)b + 16;
}
void free(void *p) { if (!p) return; blk *b = (blk *)((char *)p - 16); b->next = freelist; freelist = b; }
void *memset(void *d, int c, size_t n) { unsigned char *p = d; while (n--) *p++ = (unsigned char)c; return d; }
void *memcpy(void *d, const void *s, size_t n) { unsigned char *a = d; const unsigned char *b = s; while (n--) *a++ = *b++; return d; }
void *memmove(void *d, const void *s, size_t n) { unsigned char *a = d; const unsigned char *b = s; if (a < b) while (n--) *a++ = *b++; else { a += n; b += n; while (n--) *--a = *--b; } return d; }
int memcmp(const void *x, const void *y, size_t n) { const unsigned char *a = x, *b = y; for (; n--; a++, b++) if (*a != *b) return *a - *b; return 0; }
void *calloc(size_t n, size_t s) { void *p = malloc(n * s); if (p) memset(p, 0, n * s); return p; }
void *realloc(void *p, size_t n) { if (!p) return malloc(n); blk *b = (blk *)((char *)p - 16); if (b->size >= n) return p; void *q = malloc(n); if (q) { memcpy(q, p, b->size); free(p); } return q; }
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) a++, b++; return (unsigned char)*a - (unsigned char)*b; }
int strncmp(const char *a, const char *b, size_t n) { for (; n && *a && *a == *b; n--) a++, b++; return n ? (unsigned char)*a - (unsigned char)*b : 0; }
char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)); return r; }
char *strncpy(char *d, const char *s, size_t n) { size_t i = 0; for (; i < n && s[i]; i++) d[i] = s[i]; for (; i < n; i++) d[i] = 0; return d; }
int abs(int x) { return x < 0 ? -x : x; }
int isdigit(int c) { return c >= '0' && c <= '9'; } int isspace(int c) { return c == ' ' || (c >= 9 && c <= 13); }
int isalpha(int c) { return (c | 32) >= 'a' && (c | 32) <= 'z'; } int toupper(int c) { return c >= 'a' && c <= 'z' ? c - 32 : c; } int tolower(int c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }
static unsigned long rs = 1; int rand(void) { rs = rs * 1103515245 + 12345; return (int)((rs >> 1) & 0x7fffffff); } void srand(unsigned s) { rs = s; }
int atoi(const char *s) { int n = 0, g = 1; if (*s == '-') g = -1, s++; while (isdigit(*s)) n = n * 10 + *s++ - '0'; return n * g; }
double atof(const char *s) { return atoi(s); }
void abort(void) { __builtin_trap(); } void exit(int c) { (void)c; __builtin_trap(); }
// no files or console in the browser module: output functions do nothing
typedef struct FILE FILE; FILE *stderr = 0, *stdout = 0, *stdin = 0;
int printf(const char *f, ...) { (void)f; return 0; } int fprintf(FILE *s, const char *f, ...) { (void)s; (void)f; return 0; }
int vfprintf(FILE *s, const char *f, va_list ap) { (void)s; (void)f; (void)ap; return 0; }
int sprintf(char *b, const char *f, ...) { (void)f; if (b) *b = 0; return 0; } int snprintf(char *b, size_t n, const char *f, ...) { (void)f; if (b && n) *b = 0; return 0; }
int fputs(const char *s, FILE *f) { (void)s; (void)f; return 0; } int puts(const char *s) { (void)s; return 0; } int fflush(FILE *f) { (void)f; return 0; }
FILE *fopen(const char *p, const char *m) { (void)p; (void)m; return 0; } int fclose(FILE *f) { (void)f; return 0; }
size_t fread(void *p, size_t s, size_t n, FILE *f) { (void)p; (void)s; (void)n; (void)f; return 0; }
size_t fwrite(const void *p, size_t s, size_t n, FILE *f) { (void)p; (void)s; (void)f; return n; }
int fscanf(FILE *f, const char *fmt, ...) { (void)f; (void)fmt; return -1; } int sscanf(const char *s, const char *fmt, ...) { (void)s; (void)fmt; return -1; }
char *fgets(char *s, int n, FILE *f) { (void)s; (void)n; (void)f; return 0; } int feof(FILE *f) { (void)f; return 1; } int fgetc(FILE *f) { (void)f; return -1; }
