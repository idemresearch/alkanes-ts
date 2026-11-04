/* Differential test driver for shim/printf.c (test/printf.test.mjs).
 *
 * The test links this file twice: once against wasi-libc's vsnprintf and
 * snprintf, and once with build/shim/printf.o placed first, exactly as
 * scripts/link.mjs does for contracts. */

#include <errno.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>

_Static_assert(sizeof(va_list) == sizeof(char *), "wasm32 va_list is a pointer");

static char scratch[1 << 16] __attribute__((aligned(16)));

__attribute__((export_name("scratch"))) char *scratch_base(void) { return scratch; }
__attribute__((export_name("get_errno"))) int get_errno(void) { return errno; }
__attribute__((export_name("set_errno"))) void set_errno(int value) { errno = value; }

/* vsnprintf over an argument area the test lays out the way clang passes
 * variadic arguments on wasm32: each argument at its natural alignment. */
__attribute__((export_name("format"))) int format(char *dst, size_t n, const char *fmt, char *args) {
  va_list ap;
  memcpy(&ap, &args, sizeof ap);
  return vsnprintf(dst, n, fmt, ap);
}

/* snprintf through real variadic call sites. */
__attribute__((export_name("call"))) int call(int k, char *dst, size_t n, const char *s) {
  switch (k) {
  case 0: return snprintf(dst, n, "Invalid typed array length: %.*s", 8, "1.5e+300 trailing");
  case 1:
    return snprintf(dst, n, "scriptc: RangeError: array index %s out of bounds (length %zu)\n", s,
                    (size_t)4294967295u);
  case 2: return snprintf(dst, n, "scriptc: library entry '%s' invoked from a host callback\n", s);
  case 3:
    return snprintf(dst, n, "%d %lld %s %c %x %p %hhd %jd %zd %td %lu|", -7, (long long)INT64_MIN, s, 'Z',
                    0xdeadbeefu, (void *)0x1234, 300, (intmax_t)-1, (ssize_t)-5, (ptrdiff_t)-6, 4000000000ul);
  case 4:
    return snprintf(dst, n, "%*d|%-*d|%.*d|%0*lld|%*s|", 8, 42, -8, 42, 5, -42, 20, (long long)-123456789012345,
                    -6, "ab");
  case 5: return snprintf(dst, n, "%s|%10s|%-10.3s|", (char *)0, (char *)0, (char *)0);
  case 6: return snprintf(dst, n, "no conversions, 100%% literal");
  case 7: return snprintf(dst, n, "");
  case 8: return snprintf(dst, n, "%#o %#x %#X %+d % d %'d %#.0o %#.0x", 8u, 255u, 255u, 5, 5, 1234567, 0u, 0u);
  case 9: return snprintf(dst, n, "%llu %llx %lld %jx", 18446744073709551615ull, 18446744073709551615ull,
                          (long long)INT64_MAX, (uintmax_t)1 << 63);
  case 10: return snprintf(dst, n, "%hd %hu %hhu %hx %hhx %hi", 70000, 70000, 511, -1, -1, -32769);
  case 11: return snprintf(dst, n, "%c%c%c|%-3c|%3c", 'a', 0, 0x1ff, 'b', 'c');
  case 12: return snprintf(dst, n, "%p %p %20p %-20p %.12p", (void *)0, (void *)1, (void *)0xabc, (void *)0xabc,
                           (void *)0xabc);
  case 13: return snprintf(dst, n, "%y %d", 1, 2);
  case 14: return snprintf(dst, n, "x%dy%Ldz", 1, 2);
  }
  return -2;
}
