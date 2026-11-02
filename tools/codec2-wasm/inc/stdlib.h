#pragma once
#include <stddef.h>
void *malloc(size_t n); void *calloc(size_t n, size_t s); void *realloc(void *p, size_t n); void free(void *p);
void exit(int c); void abort(void); int abs(int x); int atoi(const char *s); double atof(const char *s);
int rand(void); void srand(unsigned s);
#define RAND_MAX 2147483647
