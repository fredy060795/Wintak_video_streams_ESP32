#pragma once
#include <stddef.h>
#include <stdarg.h>
typedef struct FILE FILE;
extern FILE *stderr, *stdout, *stdin;
int printf(const char *f, ...); int fprintf(FILE *s, const char *f, ...); int sprintf(char *b, const char *f, ...);
int snprintf(char *b, size_t n, const char *f, ...); int fputs(const char *s, FILE *f); int puts(const char *s);
int fflush(FILE *f); FILE *fopen(const char *p, const char *m); int fclose(FILE *f);
size_t fread(void *p, size_t s, size_t n, FILE *f); size_t fwrite(const void *p, size_t s, size_t n, FILE *f);
int fscanf(FILE *f, const char *fmt, ...); int sscanf(const char *s, const char *fmt, ...); char *fgets(char *s, int n, FILE *f);
int feof(FILE *f); int fgetc(FILE *f); int vfprintf(FILE *s, const char *f, va_list ap);
#define EOF (-1)
