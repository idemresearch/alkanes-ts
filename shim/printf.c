/* Minimal vsnprintf/snprintf for contract modules.
 *
 * The scriptc library runtime formats a few trap and RangeError messages with
 * vsnprintf/snprintf. wasi-libc's implementation is musl's general printf
 * engine: printf_core, FILE buffering, wide-character output and the 128-bit
 * long double soft-float behind %e/%f/%g/%a, about 15 KB of code that every
 * invocation compiles. This file compiles to under 3 KB. scripts/link.mjs
 * links it ahead of libc, so libc's vsnprintf.o and snprintf.o are never
 * extracted and that engine is dropped.
 *
 * The code below is musl's printf_core (src/stdio/vfprintf.c and
 * src/stdio/vsnprintf.c, MIT license, Copyright © 2005-2020 Rich Felker et
 * al.; the full notice is in NOTICE) restricted to the conversions d i o u x X c s p and %%, with every
 * flag, field width, precision (including .*) and the length modifiers hh h l
 * ll z j t. For those formats the output bytes, the return value, errno and
 * the bytes written to the destination are musl's: test/printf.test.mjs
 * compares the two differentially in Wasm.
 *
 * Anything else that musl accepts traps instead of printing something
 * different: floating point (e f g a E F G A, with or without l/L), %n, %m,
 * wide characters (%C %S %lc %ls) and positional arguments (%1$d, *1$,
 * .*1$). Formats musl rejects with EINVAL are rejected the same way.
 * scripts/printf-formats.mjs proves at build time that every format string
 * reaching these functions in a linked contract is a constant that uses only
 * the supported subset, so the traps are unreachable.
 */

#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* Argument fetching below relies on the wasm32 data model: long, size_t,
 * ptrdiff_t and pointers occupy one 4-byte va_list slot, long long and
 * intmax_t one 8-byte slot. */
_Static_assert(sizeof(int) == 4 && sizeof(long) == 4 && sizeof(size_t) == 4 &&
                   sizeof(ptrdiff_t) == 4 && sizeof(void *) == 4,
               "wasm32 data model");
_Static_assert(sizeof(long long) == 8 && sizeof(intmax_t) == 8, "wasm32 data model");

#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define isdigit(c) ((unsigned)(c) - '0' < 10)

#define ALT_FORM (1U << ('#' - ' '))
#define ZERO_PAD (1U << ('0' - ' '))
#define LEFT_ADJ (1U << ('-' - ' '))
#define PAD_POS (1U << (' ' - ' '))
#define MARK_POS (1U << ('+' - ' '))
#define GROUPED (1U << ('\'' - ' '))
#define FLAGMASK (ALT_FORM | ZERO_PAD | LEFT_ADJ | PAD_POS | MARK_POS | GROUPED)

/* Length modifier preceding the conversion. */
enum { BARE, HPRE, HHPRE, LPRE, LLPRE, ZTPRE, JPRE, BIGLPRE };

/* Destination of the formatting pass: the next byte and the room left before
 * the terminating NUL. Output beyond the room is counted but discarded. musl
 * writes through a FILE buffer instead; the bytes that reach the destination
 * are the same. */
struct sink {
  char *s;
  size_t n;
};

/* A conversion musl supports but this file does not. */
#define unsupported() __builtin_trap()

static void out(struct sink *f, const char *s, size_t l) {
  size_t k = MIN(f->n, l);
  memcpy(f->s, s, k);
  f->s += k;
  f->n -= k;
}

static void pad(struct sink *f, char c, int w, int l, int fl) {
  if (fl & (LEFT_ADJ | ZERO_PAD) || l >= w) return;
  size_t k = MIN(f->n, (size_t)(w - l));
  memset(f->s, c, k);
  f->s += k;
  f->n -= k;
}

static const char xdigits[] = "0123456789ABCDEF";

static char *fmt_x(uintmax_t x, char *s, int lower) {
  for (; x; x >>= 4) *--s = xdigits[(x & 15)] | lower;
  return s;
}

static char *fmt_o(uintmax_t x, char *s) {
  for (; x; x >>= 3) *--s = '0' + (x & 7);
  return s;
}

static char *fmt_u(uintmax_t x, char *s) {
  unsigned long y;
  for (; x > ULONG_MAX; x /= 10) *--s = '0' + x % 10;
  for (y = x; y; y /= 10) *--s = '0' + y % 10;
  return s;
}

static int getint(char **s) {
  int i;
  for (i = 0; isdigit(**s); (*s)++) {
    if (i > INT_MAX / 10U || **s - '0' > INT_MAX - 10 * i) i = -1;
    else i = 10 * i + (**s - '0');
  }
  return i;
}

/* With f == 0 this is musl's validation pass: it parses the format up to the
 * first conversion, which must be valid, without consuming arguments. */
static int printf_subset(struct sink *f, const char *fmt, va_list *ap) {
  char *a, *z, *s = (char *)fmt;
  unsigned fl, ps;
  int w, p, xp;
  uintmax_t arg;
  int cnt = 0, l = 0;
  char buf[sizeof(uintmax_t) * 3];
  const char *prefix;
  int t, pl, sgn;

  for (;;) {
    /* Stop immediately on overflow, as musl does. */
    if (l > INT_MAX - cnt) goto overflow;

    /* Update output count, end loop when fmt is exhausted */
    cnt += l;
    if (!*s) break;

    /* Handle literal text and %% format specifiers */
    for (a = s; *s && *s != '%'; s++);
    for (z = s; s[0] == '%' && s[1] == '%'; z++, s += 2);
    if (z - a > INT_MAX - cnt) goto overflow;
    l = z - a;
    if (f) out(f, a, l);
    if (l) continue;

    if (isdigit(s[1]) && s[2] == '$') unsupported();
    s++;

    /* Read modifier flags */
    for (fl = 0; (unsigned)*s - ' ' < 32 && (FLAGMASK & (1U << (*s - ' '))); s++)
      fl |= 1U << (*s - ' ');

    /* Read field width */
    if (*s == '*') {
      if (isdigit(s[1]) && s[2] == '$') unsupported();
      w = f ? va_arg(*ap, int) : 0;
      s++;
      /* musl negates in int; INT_MIN stays INT_MIN either way. */
      if (w < 0) fl |= LEFT_ADJ, w = (int)(0U - (unsigned)w);
    } else if ((w = getint(&s)) < 0) goto overflow;

    /* Read precision */
    if (*s == '.' && s[1] == '*') {
      if (isdigit(s[2]) && s[3] == '$') unsupported();
      p = f ? va_arg(*ap, int) : 0;
      s += 2;
      xp = (p >= 0);
    } else if (*s == '.') {
      s++;
      p = getint(&s);
      xp = 1;
    } else {
      p = -1;
      xp = 0;
    }

    /* Length modifier and conversion, accepting exactly what musl's state
     * table accepts. */
    ps = BARE;
    switch (*s) {
    case 'h':
      ps = HPRE;
      if (*++s == 'h') ps = HHPRE, s++;
      break;
    case 'l':
      ps = LPRE;
      if (*++s == 'l') ps = LLPRE, s++;
      break;
    case 'z':
    case 't':
      ps = ZTPRE, s++;
      break;
    case 'j':
      ps = JPRE, s++;
      break;
    case 'L':
      ps = BIGLPRE, s++;
      break;
    }
    t = *s;
    sgn = 0;
    switch (t) {
    case 'd':
    case 'i':
      sgn = 1;
      /* fallthrough */
    case 'o':
    case 'u':
    case 'x':
    case 'X':
      if (ps == BIGLPRE) goto inval;
      break;
    case 'c':
      sgn = 1;
      /* fallthrough */
    case 's':
      if (ps == LPRE) unsupported(); /* %lc, %ls */
      /* fallthrough */
    case 'p':
      if (ps != BARE) goto inval;
      break;
    case 'n':
      unsupported();
    case 'm':
    case 'C':
    case 'S':
      if (ps != BARE) goto inval;
      unsupported();
    case 'e':
    case 'f':
    case 'g':
    case 'a':
    case 'E':
    case 'F':
    case 'G':
    case 'A':
      if (ps == BARE || ps == LPRE || ps == BIGLPRE) unsupported();
      goto inval;
    default:
      goto inval;
    }
    s++;

    if (!f) return 0;

    /* musl's pop_arg for the accepted argument types */
    if (t == 's' || t == 'p') arg = (uintptr_t)va_arg(*ap, void *);
    else if (ps == LLPRE || ps == JPRE) arg = va_arg(*ap, uintmax_t);
    else if (sgn) {
      int v = va_arg(*ap, int);
      arg = (intmax_t)(ps == HPRE ? (short)v : ps == HHPRE ? (signed char)v : v);
    } else {
      unsigned v = va_arg(*ap, unsigned);
      arg = ps == HPRE ? (unsigned short)v : ps == HHPRE ? (unsigned char)v : v;
    }

    z = buf + sizeof(buf);
    prefix = "-+   0X0x";
    pl = 0;

    /* - and 0 flags are mutually exclusive */
    if (fl & LEFT_ADJ) fl &= ~ZERO_PAD;

    switch (t) {
    case 'p':
      /* As in musl, this compares as unsigned: without a precision (p < 0)
       * a null pointer prints "0" and others print their digits. */
      p = MAX(p, 2 * sizeof(void *));
      t = 'x';
      fl |= ALT_FORM;
      /* fallthrough */
    case 'x':
    case 'X':
      a = fmt_x(arg, z, t & 32);
      if (arg && (fl & ALT_FORM)) prefix += (t >> 4), pl = 2;
      if (0) {
      case 'o':
        a = fmt_o(arg, z);
        if ((fl & ALT_FORM) && p < z - a + 1) p = z - a + 1;
      }
      if (0) {
      case 'd':
      case 'i':
        pl = 1;
        if (arg > INTMAX_MAX) {
          arg = -arg;
        } else if (fl & MARK_POS) {
          prefix++;
        } else if (fl & PAD_POS) {
          prefix += 2;
        } else pl = 0;
        /* fallthrough */
      case 'u':
        a = fmt_u(arg, z);
      }
      if (xp && p < 0) goto overflow;
      if (xp) fl &= ~ZERO_PAD;
      if (!arg && !p) {
        a = z;
        break;
      }
      p = MAX(p, z - a + !arg);
      break;
    case 'c':
      *(a = z - (p = 1)) = arg;
      fl &= ~ZERO_PAD;
      break;
    case 's':
      a = arg ? (char *)(uintptr_t)arg : "(null)";
      z = a + strnlen(a, p < 0 ? INT_MAX : p);
      if (p < 0 && *z) goto overflow;
      p = z - a;
      fl &= ~ZERO_PAD;
      break;
    }

    if (p < z - a) p = z - a;
    if (p > INT_MAX - pl) goto overflow;
    if (w < pl + p) w = pl + p;
    if (w > INT_MAX - cnt) goto overflow;

    pad(f, ' ', w, pl + p, fl);
    out(f, prefix, pl);
    pad(f, '0', w, pl + p, fl ^ ZERO_PAD);
    pad(f, '0', p, z - a, 0);
    out(f, a, z - a);
    pad(f, ' ', w, pl + p, fl ^ LEFT_ADJ);

    l = w;
  }
  return cnt;

inval:
  errno = EINVAL;
  return -1;
overflow:
  errno = EOVERFLOW;
  return -1;
}

int vsnprintf(char *restrict s, size_t n, const char *restrict fmt, va_list ap) {
  char dummy[1];
  struct sink c = {n ? s : dummy, n ? n - 1 : 0};
  va_list ap2;
  int ret;

  *c.s = 0;
  /* the copy allows passing va_list* even if va_list is an array */
  va_copy(ap2, ap);
  ret = printf_subset(0, fmt, &ap2);
  if (ret >= 0) ret = printf_subset(&c, fmt, &ap2);
  va_end(ap2);
  *c.s = 0;
  return ret;
}

int snprintf(char *restrict s, size_t n, const char *restrict fmt, ...) {
  int ret;
  va_list ap;
  va_start(ap, fmt);
  ret = vsnprintf(s, n, fmt, ap);
  va_end(ap);
  return ret;
}
