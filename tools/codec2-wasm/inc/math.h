#pragma once
#define M_PI 3.14159265358979323846
#define HUGE_VAL __builtin_huge_val()
#define INFINITY __builtin_inff()
#define NAN __builtin_nanf("")
#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define isfinite(x) __builtin_isfinite(x)
float sinf(float); float cosf(float); float tanf(float); float atanf(float); float atan2f(float, float); float asinf(float); float acosf(float);
float expf(float); float logf(float); float log10f(float); float log2f(float); float powf(float, float); float exp2f(float); float tanhf(float);
double sin(double); double cos(double); double tan(double); double atan(double); double atan2(double, double); double asin(double); double acos(double);
double exp(double); double log(double); double log10(double); double log2(double); double pow(double, double); double tanh(double);
static inline float sqrtf(float x) { return __builtin_sqrtf(x); } static inline double sqrt(double x) { return __builtin_sqrt(x); }
static inline float fabsf(float x) { return __builtin_fabsf(x); } static inline double fabs(double x) { return __builtin_fabs(x); }
static inline float floorf(float x) { return __builtin_floorf(x); } static inline double floor(double x) { return __builtin_floor(x); }
static inline float ceilf(float x) { return __builtin_ceilf(x); } static inline double ceil(double x) { return __builtin_ceil(x); }
static inline float truncf(float x) { return __builtin_truncf(x); } static inline double trunc(double x) { return __builtin_trunc(x); }
static inline float roundf(float x) { return __builtin_roundf(x); } static inline double round(double x) { return __builtin_round(x); }
static inline long lroundf(float x) { return (long)__builtin_roundf(x); }
static inline float fmaxf(float a, float b) { return a > b ? a : b; } static inline float fminf(float a, float b) { return a < b ? a : b; }
static inline double fmax(double a, double b) { return a > b ? a : b; } static inline double fmin(double a, double b) { return a < b ? a : b; }
static inline float fmodf(float a, float b) { return a - b * __builtin_truncf(a / b); } static inline double fmod(double a, double b) { return a - b * __builtin_trunc(a / b); }
static inline float copysignf(float a, float b) { return __builtin_copysignf(a, b); }
