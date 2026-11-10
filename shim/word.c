// Fixed-width SDK leaves for the compiler's statically checked word subset.
// No contract selectors, state keys, cap rules or author methods live here.
// All memory belongs to the invocation's adapter arena. No libc/JS allocation.
typedef unsigned int N;
typedef unsigned long long L;
typedef unsigned __int128 U;
#define EXPORT(name) __attribute__((export_name(name)))
#define HOST(name) __attribute__((import_module("env"), import_name(name)))
__attribute__((import_module("scriptc"), import_name("__adapter_reserve"))) N reserve(N);
HOST("__request_storage") int request(N);
HOST("__load_storage") int load(N, N);
HOST("__fuel") void fuel(N);
HOST("__call") int call(N, N, N, L);
HOST("__returndatacopy") void returndata(N);
HOST("abort") void abort_call(N, N, N, N);
HOST("__balance") void host_balance(N, N, N);
HOST("__height") void host_height(N);

void *memcpy(void *to, const void *from, N n) {
  unsigned char *d = to;
  const unsigned char *s = from;
  for (N i = 0; i < n; i++)
    d[i] = s[i];
  return to;
}
void *memset(void *to, int c, N n) {
  unsigned char *d = to;
  for (N i = 0; i < n; i++)
    d[i] = (unsigned char)c;
  return to;
}
static U get(N p) {
  U v;
  __builtin_memcpy(&v, (void *)p, 16);
  return v;
}
static void put(N p, U v) { __builtin_memcpy((void *)p, &v, 16); }
static N get32(N p) {
  N v;
  __builtin_memcpy(&v, (void *)p, 4);
  return v;
}
static void put32(N p, N v) { __builtin_memcpy((void *)p, &v, 4); }
static N word(U v) {
  N p = reserve(16);
  put(p, v);
  return p;
}
static int equal(N a, N b, N n) {
  for (N i = 0; i < n; i++)
    if (((unsigned char *)a)[i] != ((unsigned char *)b)[i])
      return 0;
  return 1;
}
static N copy(N p, N n) {
  N out = reserve(n);
  memcpy((void *)out, (void *)p, n);
  return out;
}
typedef struct __attribute__((packed)) Asset {
  struct Asset *next;
  U block, tx, value;
} Asset;
typedef struct __attribute__((packed)) Entry {
  struct Entry *next;
  N key, klen, value, len, dirty;
} Entry;
typedef struct __attribute__((packed)) Context {
  N code, read_only, inputs, count, myself, incoming, incount, message, mlen, tail, tlen, tracked,
      forward;
  Asset *assets;
  Entry *storage;
} Context;
static void error(Context *c, N code) {
  if (!c->code)
    c->code = code;
}
static int writable(Context *c) {
  if (c->read_only)
    error(c, 6);
  return !c->code;
}
static U add(Context *c, U a, U b) {
  U v = a + b;
  if (v < a)
    error(c, 2);
  return v;
}
static Asset *asset(Context *c, U b, U t) {
  Asset **p = &c->assets;
  while (*p) {
    if ((*p)->block == b && (*p)->tx == t)
      return *p;
    p = &(*p)->next;
  }
  Asset *a = (Asset *)reserve(sizeof(Asset));
  memset(a, 0, sizeof(*a));
  a->block = b;
  a->tx = t;
  *p = a;
  return a;
}
static void credit(Context *c, N parcel, N count) {
  for (N i = 0; i < count; i++) {
    N p = parcel + i * 48;
    Asset *a = asset(c, get(p), get(p + 16));
    a->value = add(c, a->value, get(p + 32));
  }
}
EXPORT("w_begin") N begin(N input, N len, N tracked) {
  Context *c = (Context *)reserve(sizeof(Context));
  memset(c, 0, sizeof(*c));
  if (len < 96) {
    error(c, 1);
    return (N)c;
  }
  input = copy(input, len);
  c->myself = input;
  U n = get(input + 80);
  if (n > (len - 96) / 48) {
    error(c, 1);
    return (N)c;
  }
  c->incoming = input + 96;
  c->incount = (N)n;
  N start = 96 + (N)n * 48;
  if ((len - start) % 16) {
    error(c, 1);
    return (N)c;
  }
  c->inputs = input + start;
  c->count = (len - start) / 16;
  c->tracked = tracked;
  // The bigint dispatcher reports a missing opcode before crediting the
  // incoming parcel; skipping the credit keeps the same first error.
  if (tracked && c->count)
    credit(c, c->incoming, c->incount);
  return (N)c;
}
EXPORT("w_forward") void forward(Context *c, N value) { c->forward = value; }
EXPORT("w_status") N status(Context *c) { return c->code; }
EXPORT("w_count") N count(Context *c) { return c->count; }
EXPORT("w_incoming") N incoming(Context *c) { return c->incount; }
EXPORT("w_input") N input(Context *c, N i) {
  if (i >= c->count) {
    error(c, 1);
    return word(0);
  }
  return c->inputs + i * 16;
}
static U shift_left(U v, N n) {
  L lo = (L)v, hi = (L)(v >> 64);
  if (!n) return v;
  if (n >= 64) return (U)(lo << (n - 64)) << 64;
  return ((U)((hi << n) | (lo >> (64 - n))) << 64) | (lo << n);
}
static U shift_right(U v, N n) {
  L lo = (L)v, hi = (L)(v >> 64);
  if (!n) return v;
  if (n >= 64) return hi >> (n - 64);
  return ((U)(hi >> n) << 64) | ((lo >> n) | (hi << (64 - n)));
}
// IEEE round-to-nearest, ties-to-even. Exact below 2^53; monotonic, so every
// larger value converts to at least 2^53.
EXPORT("w_tonumber") double tonumber(N p) {
  U v = get(p);
  L high = (L)(v >> 64), low = (L)v;
  N bits = high ? 128 - __builtin_clzll(high) : low ? 64 - __builtin_clzll(low) : 0;
  if (bits <= 53) return (double)low;
  N shift = bits - 53;
  L mantissa = (L)shift_right(v,shift);
  U remainder = v & (shift_left(1,shift) - 1), halfway = shift_left(1,shift - 1);
  if (remainder > halfway || (remainder == halfway && (mantissa & 1))) mantissa++;
  L scale_bits = (L)(1023 + shift) << 52;
  double scale; __builtin_memcpy(&scale, &scale_bits, 8);
  return (double)mantissa * scale;
}
EXPORT("w_literal") N literal(N a, N b, N c, N d) {
  return word((U)a | ((U)b << 32) | ((U)c << 64) | ((U)d << 96));
}
EXPORT("w_id") N id(Context *c, N b, N t) {
  if (c->code)
    return word(0);
  N p = reserve(32);
  put(p, get(b));
  put(p + 16, get(t));
  return p;
}
EXPORT("w_unknown") void unknown(Context *c, N value) {
  if (c->code)
    return;
  error(c, 12);
  U v = get(value);
  N temp = reserve(40), n = 0;
  do {
    N limbs[4];
    __builtin_memcpy(limbs, &v, 16);
    L rem = 0;
    for (int i = 3; i >= 0; i--) {
      L part = (rem << 32) | limbs[i];
      limbs[i] = (N)(part / 10);
      rem = part % 10;
    }
    __builtin_memcpy(&v, limbs, 16);
    ((unsigned char *)temp)[n++] = (unsigned char)(48 + rem);
  } while (v);
  c->tail = reserve(n);
  c->tlen = n;
  for (N i = 0; i < n; i++)
    ((unsigned char *)c->tail)[i] = ((unsigned char *)temp)[n - 1 - i];
}
/* ---- Exact wide arithmetic: checked *, /, %, mulDiv(Up), sqrt ----------
 * No compiler-rt is linked, so 128-bit values are split into little-endian
 * 32-bit limbs and every product/quotient uses native i64 operations only
 * (no __multi3/__udivti3, no variable-width 128-bit shifts, no data tables). */
#define DIV_ZERO 13
static void wide_limbs(U v, N *out) { __builtin_memcpy(out, &v, 16); }
static U wide_join(const N *p) {
  U v;
  __builtin_memcpy(&v, p, 16);
  return v;
}
static int wide_size(const N *v, int n) {
  while (n && !v[n - 1])
    n--;
  return n;
}
static void wide_clear(N *v, int n) {
  for (int i = 0; i < n; i++)
    v[i] = 0;
}
// p[0..7] = a * b exactly (schoolbook over significant limbs).
static void wide_mul256(U a, U b, N *p) {
  N x[4], y[4];
  wide_limbs(a, x);
  wide_limbs(b, y);
  wide_clear(p, 8);
  int nx = wide_size(x, 4), ny = wide_size(y, 4);
  for (int i = 0; i < nx; i++) {
    L carry = 0;
    for (int j = 0; j < ny; j++) {
      L t = (L)x[i] * y[j] + p[i + j] + carry;
      p[i + j] = (N)t;
      carry = t >> 32;
    }
    p[i + ny] = (N)carry;
  }
}
// Knuth algorithm D (Hacker's Delight divmnu) for m >= n >= 2, v[n-1] != 0,
// m <= 8: q[0..m-n] = u / v and r[0..n-1] = u % v.
static void wide_divlong(const N *u, int m, const N *v, int n, N *q, N *r) {
  int s = __builtin_clz(v[n - 1]);
  N vn[4], un[9];
  for (int i = n - 1; i > 0; i--)
    vn[i] = (v[i] << s) | (N)((L)v[i - 1] >> (32 - s));
  vn[0] = v[0] << s;
  un[m] = (N)((L)u[m - 1] >> (32 - s));
  for (int i = m - 1; i > 0; i--)
    un[i] = (u[i] << s) | (N)((L)u[i - 1] >> (32 - s));
  un[0] = u[0] << s;
  for (int j = m - n; j >= 0; j--) {
    L num = ((L)un[j + n] << 32) | un[j + n - 1];
    L qhat = num / vn[n - 1], rhat = num - qhat * vn[n - 1];
    while ((qhat >> 32) || qhat * vn[n - 2] > ((rhat << 32) | un[j + n - 2])) {
      qhat--;
      rhat += vn[n - 1];
      if (rhat >> 32)
        break;
    }
    long long t, k = 0;
    for (int i = 0; i < n; i++) {
      L p = qhat * vn[i];
      t = (long long)un[i + j] - k - (long long)(p & 0xffffffffu);
      un[i + j] = (N)t;
      k = (long long)(p >> 32) - (t >> 32);
    }
    t = (long long)un[j + n] - k;
    un[j + n] = (N)t;
    q[j] = (N)qhat;
    if (t < 0) {
      q[j]--;
      L carry = 0;
      for (int i = 0; i < n; i++) {
        L sum = (L)un[i + j] + vn[i] + carry;
        un[i + j] = (N)sum;
        carry = sum >> 32;
      }
      un[j + n] += (N)carry;
    }
  }
  for (int i = 0; i < n - 1; i++)
    r[i] = (un[i] >> s) | (N)((L)un[i + 1] << (32 - s));
  r[n - 1] = un[n - 1] >> s;
}
// u (m significant limbs) / v (n >= 1 significant limbs). The caller zeroes
// q (>= max(m, 2) limbs) and r (4 limbs).
static void wide_div(const N *u, int m, const N *v, int n, N *q, N *r) {
  if (m < n) {
    for (int i = 0; i < m; i++)
      r[i] = u[i];
    return;
  }
  if (m <= 2) {
    L x = (L)u[0] | ((L)(m > 1 ? u[1] : 0) << 32), y = (L)v[0] | ((L)(n > 1 ? v[1] : 0) << 32);
    L qq = x / y, rr = x - qq * y;
    q[0] = (N)qq;
    q[1] = (N)(qq >> 32);
    r[0] = (N)rr;
    r[1] = (N)(rr >> 32);
    return;
  }
  if (n == 1) {
    L k = 0;
    for (int j = m - 1; j >= 0; j--) {
      L t = (k << 32) | u[j];
      q[j] = (N)(t / v[0]);
      k = t - (L)q[j] * v[0];
    }
    r[0] = (N)k;
    return;
  }
  wide_divlong(u, m, v, n, q, r);
}
static U wide_mul(Context *c, U a, U b) {
  N p[8];
  wide_mul256(a, b, p);
  if (p[4] | p[5] | p[6] | p[7])
    error(c, 2);
  return wide_join(p);
}
// x / y (want_rem = 0) or x % y (want_rem = 1); y != 0.
static U wide_divide(U x, U y, int want_rem) {
  N u[4], v[4], q[4], r[4];
  wide_limbs(x, u);
  wide_limbs(y, v);
  wide_clear(q, 4);
  wide_clear(r, 4);
  wide_div(u, wide_size(u, 4), v, wide_size(v, 4), q, r);
  return wide_join(want_rem ? r : q);
}
// floor(a * b / d), the ceiling (mode 1), or the remainder a * b % d (mode
// 9), from the exact 256-bit product; checked like sdk/u128.ts. The mode is
// the op3 kind, so op3 has one call site and the body is not duplicated.
static U wide_muldiv(Context *c, U a, U b, U d, int mode) {
  if (!d) {
    error(c, DIV_ZERO);
    return 0;
  }
  N p[8], v[4], q[8], r[4];
  wide_mul256(a, b, p);
  wide_limbs(d, v);
  wide_clear(q, 8);
  wide_clear(r, 4);
  wide_div(p, wide_size(p, 8), v, wide_size(v, 4), q, r);
  if (mode == 9)
    return wide_join(r); // below d, so it always fits
  if (q[4] | q[5] | q[6] | q[7]) {
    error(c, 2);
    return 0;
  }
  U quotient = wide_join(q);
  if (mode == 1 && (r[0] | r[1] | r[2] | r[3])) {
    if (!~quotient) {
      error(c, 2);
      return 0;
    }
    quotient++;
  }
  return quotient;
}
// floor(sqrt(n)) for n < 2^256 given as 8 limbs. Newton's method from an
// upper bound decreases monotonically to the root (same as sdk/u128.ts isqrt;
// the start is clamped to 2^128 - 1, still >= the root for any 256-bit n).
static U wide_isqrt(const N *n) {
  int m = wide_size(n, 8);
  if (!m)
    return 0;
  int bits = 32 * m - __builtin_clz(n[m - 1]), e = (bits + 1) >> 1;
  N x[4];
  wide_clear(x, 4);
  if (e >= 128)
    x[0] = x[1] = x[2] = x[3] = ~0u;
  else
    x[e >> 5] = 1u << (e & 31);
  for (;;) {
    N q[8], r[4], y[8];
    wide_clear(q, 8);
    wide_clear(r, 4);
    wide_div(n, m, x, wide_size(x, 4), q, r);
    // y = (x + q) >> 1 over 9 limbs (q may exceed 128 bits near 2^256).
    L carry = 0;
    N sum[9];
    for (int i = 0; i < 8; i++) {
      L t = (L)q[i] + (i < 4 ? x[i] : 0) + carry;
      sum[i] = (N)t;
      carry = t >> 32;
    }
    sum[8] = (N)carry;
    for (int i = 0; i < 8; i++)
      y[i] = (sum[i] >> 1) | (sum[i + 1] << 31);
    int ge = (y[4] | y[5] | y[6] | y[7]) != 0;
    if (!ge) {
      ge = 1;
      for (int i = 3; i >= 0; i--)
        if (y[i] != x[i]) {
          ge = y[i] > x[i];
          break;
        }
    }
    if (ge)
      return wide_join(x);
    for (int i = 0; i < 4; i++)
      x[i] = y[i];
  }
}
/* ---- end wide arithmetic ---- */
EXPORT("w_op") N op(Context *c, N kind, N a, N b) {
  if (c->code)
    return 0;
  U x = get(a), y = get(b);
  switch (kind) {
  case 0:
    return word(add(c, x, y));
  case 1:
    if (y > x)
      error(c, 3);
    return word(x - y);
  case 2:
    return x == y;
  case 3:
    return x != y;
  case 4:
    return x < y;
  case 5:
    return x <= y;
  case 6:
    return x > y;
  case 7:
    return x >= y;
  }
  error(c, 1);
  return word(0);
}
EXPORT("w_readonly") void readonly(Context *c, N value) { c->read_only = value; }
EXPORT("w_fail") void fail(Context *c, N msg, N len) {
  if (!c->code) {
    c->code = 100;
    c->message = copy(msg, len);
    c->mlen = len;
  }
}
EXPORT("w_explain") void explain(Context *c, N msg, N len) {
  if (c->code == 4 || c->code == 5) {
    c->code = 100;
    c->message = copy(msg, len);
    c->mlen = len;
  }
}
static Entry *entry(Context *c, N key, N len) {
  Entry **p = &c->storage;
  while (*p) {
    if ((*p)->klen == len && equal((*p)->key, key, len))
      return *p;
    p = &(*p)->next;
  }
  Entry *e = (Entry *)reserve(sizeof(Entry));
  memset(e, 0, sizeof(*e));
  e->key = copy(key, len);
  e->klen = len;
  *p = e;
  return e;
}
EXPORT("w_load") N state_load(Context *c, N key, N len, N fallback, N size) {
  if (c->code)
    return word(0);
  Entry *e = entry(c, key, len);
  if (!e->value) {
    int n = request(e->key);
    if (n < 0) {
      error(c, 4);
      return word(0);
    }
    e->len = (N)n;
    e->value = reserve((N)n);
    if (n)
      load(e->key, e->value);
  }
  if (!e->len) {
    if (size == 16)
      return fallback;
    error(c, 5);
    return word(0);
  }
  if (e->len != size) {
    error(c, size == 16 ? 4 : 5);
    return word(0);
  }
  return e->value;
}
EXPORT("w_store") void state_store(Context *c, N key, N len, N value, N size) {
  if (!writable(c))
    return;
  Entry *e = entry(c, key, len);
  e->value = copy(value, size);
  e->len = size;
  e->dirty = 1;
}
static N checkpoint(Context *c) {
  N size = 4, n = 0;
  for (Entry *e = c->storage; e; e = e->next)
    if (e->dirty) {
      size += 8 + e->klen + e->len;
      n++;
    }
  N p = reserve(size), o = p;
  put32(o, n);
  o += 4;
  for (Entry *e = c->storage; e; e = e->next)
    if (e->dirty) {
      put32(o, e->klen);
      o += 4;
      memcpy((void *)o, (void *)e->key, e->klen);
      o += e->klen;
      put32(o, e->len);
      o += 4;
      memcpy((void *)o, (void *)e->value, e->len);
      o += e->len;
    }
  return p;
}
// One EXTCALL_CALL with sdk/runtime.ts extcall semantics, after the caller
// has debited the parcel from the ledger. Returns the response (transfer
// count, transfers, data) with its assets credited, or 0 with the same error
// as the bigint backend latched: a revert carrying the revert selector and a
// message reports "Extcall failed: <message>", any other revert "Extcall
// failed (no details available)". Precompiles (block 800000000) take no
// checkpoint and commit nothing, so the buffered writes stay valid; any other
// call committed them and may have changed storage through a callback.
static N host_call(Context *c, N cp, N parcel, L budget) {
  int result = call(cp, parcel, checkpoint(c), budget);
  N n = result < 0 ? (N)(-(long long)result) : (N)result;
  if (n < 16) {
    error(c, 10);
    return 0;
  }
  N returned = reserve(n);
  returndata(returned);
  U transfers = get(returned);
  if (transfers > (n - 16) / 48) {
    error(c, 10);
    return 0;
  }
  if (result < 0) {
    N data = returned + 16 + (N)transfers * 48, dlen = n - 16 - (N)transfers * 48;
    error(c, 10);
    if (dlen > 4 && ((unsigned char *)data)[0] == 8 && ((unsigned char *)data)[1] == 195 &&
        ((unsigned char *)data)[2] == 121 && ((unsigned char *)data)[3] == 160) {
      c->code = 11;
      c->tail = data + 4;
      c->tlen = dlen - 4;
    }
    return 0;
  }
  if (get(cp) != (U)800000000)
    c->storage = 0;
  credit(c, returned + 16, (N)transfers);
  return returned;
}
EXPORT("w_mint") void mint(Context *c, N amount) {
  if (!writable(c))
    return;
  Asset *a = asset(c, get(c->myself), get(c->myself + 16));
  a->value = add(c, a->value, get(amount));
}
EXPORT("w_auth") void auth(Context *c, N b, N t) {
  if (!writable(c))
    return;
  U block = get(b), tx = get(t);
  int received = 0;
  for (N i = 0; i < c->incount; i++) {
    N p = c->incoming + i * 48;
    if (get(p) == block && get(p + 16) == tx && get(p + 32) > 0)
      received = 1;
  }
  Asset *a = asset(c, block, tx);
  if (!received || !a->value) {
    error(c, 7);
    return;
  }
  if (block == get(c->myself) && tx == get(c->myself + 16))
    return;
  N budget = reserve(16);
  memset((void *)budget, 0, 16);
  fuel(budget);
  L f = (L)get(budget);
  if (f > 9007199254740991ULL) {
    error(c, 9);
    return;
  }
  N cp = reserve(48);
  put(cp, block);
  put(cp + 16, tx);
  put(cp + 32, 1);
  N parcel = reserve(64);
  put(parcel, 1);
  put(parcel + 16, block);
  put(parcel + 32, tx);
  put(parcel + 48, 1);
  a->value--;
  N returned = host_call(c, cp, parcel, f);
  if (!returned)
    return;
  N data = returned + 16 + (N)get(returned) * 48;
  if (get32(returned - 4) - (data - returned) != 1 || *(unsigned char *)data != 1)
    error(c, 8);
}
EXPORT("w_finish") N finish(Context *c, N value, N len, N message, N mlen) {
  if (c->code) {
    abort_call(0, 0, 0, 0);
    if (c->message) {
      message = c->message;
      mlen = c->mlen;
    }
    N n = 24 + mlen + c->tlen, p = reserve(n);
    memset((void *)p, 0, 20);
    ((unsigned char *)p)[20] = 8;
    ((unsigned char *)p)[21] = 195;
    ((unsigned char *)p)[22] = 121;
    ((unsigned char *)p)[23] = 160;
    if (mlen)
      memcpy((void *)(p + 24), (void *)message, mlen);
    if (c->tlen)
      memcpy((void *)(p + 24 + mlen), (void *)c->tail, c->tlen);
    return p;
  }
  N n = 0;
  if (c->tracked) {
    for (Asset *a = c->assets; a; a = a->next)
      if (a->value)
        n++;
  } else if (c->forward)
    n = c->incount;
  N storage = checkpoint(c), slen = get32(storage - 4), p = reserve(16 + n * 48 + slen + len),
    o = p;
  put(o, n);
  o += 16;
  if (c->tracked) {
    for (Asset *a = c->assets; a; a = a->next)
      if (a->value) {
        put(o, a->block);
        put(o + 16, a->tx);
        put(o + 32, a->value);
        o += 48;
      }
  } else if (c->forward) {
    memcpy((void *)o, (void *)c->incoming, n * 48);
    o += n * 48;
  }
  memcpy((void *)o, (void *)storage, slen);
  o += slen;
  if (len)
    memcpy((void *)o, (void *)value, len);
  return p;
}

/* ---- Three-operand checked math and asset custody (word-v1 AMM subset) ----
 * Like every other leaf, these no-op once an error is latched, so evaluation
 * after the first failing operation has no further effects. Error codes:
 * 2 u128 overflow, 3 u128 underflow, 6 view write, 13 u128 division by zero,
 * 14 INSUFFICIENT_LEDGER, 15 INSUFFICIENT_CUSTODY, 16 SELF_CUSTODY_UNSUPPORTED,
 * 17 SELF_SEND_USE_MINT_SELF (messages live in compiler/word.mjs).
 *
 * Wide operations deliberately do not extend op(): wasmi charges every call
 * for its callee's register frame, and binaryen inlines single-caller helpers,
 * so any wide code reachable from op() would tax every comparison and add. */
EXPORT("w_op3") N op3(Context *c, N kind, N a, N b, N d) {
  if (c->code)
    return 0;
  N p[8];
  switch (kind) {
  case 4: // checked a * b
    return word(wide_mul(c, get(a), get(b)));
  case 5: // a / b
  case 6: // a % b
    if (!get(b)) {
      error(c, DIV_ZERO);
      return word(0);
    }
    return word(wide_divide(get(a), get(b), kind == 6));
  case 7: // min: handles are immutable, so return the selected operand.
    return get(a) < get(b) ? a : b;
  case 8: // max
    return get(a) > get(b) ? a : b;
  case 0: // mulDiv, and a * b / d written with operators
  case 1: // mulDivUp
  case 9: // mulMod, and a * b % d written with operators
    return word(wide_muldiv(c, get(a), get(b), get(d), kind));
  case 2: // mulSqrt: floor(sqrt(a * b)) of the exact 256-bit product
    wide_mul256(get(a), get(b), p);
    return word(wide_isqrt(p));
  case 3: // sqrt
    wide_limbs(get(a), p);
    wide_clear(p + 4, 4);
    return word(wide_isqrt(p));
  }
  error(c, 1);
  return word(0);
}
static Asset *ledger_find(Context *c, U b, U t) {
  for (Asset *a = c->assets; a; a = a->next)
    if (a->block == b && a->tx == t)
      return a;
  return 0;
}
static int ledger_self(Context *c, U b, U t) { return b == get(c->myself) && t == get(c->myself + 16); }
// Spendable custody: host balance(myself, id) minus this invocation's ledger.
// Looking an asset up never inserts it, so response order matches sdk/assets.ts.
static U ledger_held(Context *c, U b, U t) {
  if (ledger_self(c, b, t)) {
    error(c, 16);
    return 0;
  }
  N who = reserve(32), what = reserve(32), out = reserve(16);
  memcpy((void *)who, (void *)c->myself, 32);
  put(what, b);
  put(what + 16, t);
  memset((void *)out, 0, 16);
  host_balance(who, what, out);
  // The canonical host returns the stored bytes (empty when never set);
  // zero-extend a short value exactly like sdk/bytes.ts bytesToU128.
  N n = get32(out - 4);
  unsigned char bytes[16];
  for (N i = 0; i < 16; i++)
    bytes[i] = i < n ? ((unsigned char *)out)[i] : 0;
  U total;
  __builtin_memcpy(&total, bytes, 16);
  Asset *a = ledger_find(c, b, t);
  U used = a ? a->value : 0;
  if (total < used) {
    error(c, 3);
    return 0;
  }
  return total - used;
}
EXPORT("w_custody") N custody(Context *c, N kind, N b, N t, N amount) {
  if (c->code)
    return 0;
  if (kind == 4) // this.context.myself: an Id pair pointing into the context
    return c->myself;
  U block = get(b), tx = get(t);
  if (kind == 0) { // received: total in the original incoming parcel
    U total = 0;
    for (N i = 0; i < c->incount; i++) {
      N p = c->incoming + i * 48;
      if (get(p) == block && get(p + 16) == tx)
        total = add(c, total, get(p + 32));
    }
    return c->code ? 0 : word(total);
  }
  if (kind == 1) {
    U v = ledger_held(c, block, tx);
    return c->code ? 0 : word(v);
  }
  if (kind != 2 && kind != 3) {
    error(c, 1);
    return 0;
  }
  if (!writable(c))
    return 0;
  U value = get(amount);
  if (kind == 2) { // retain: keep a ledger amount in custody
    Asset *a = ledger_find(c, block, tx);
    U available = a ? a->value : 0;
    if (available < value) {
      error(c, 14);
      return 0;
    }
    asset(c, block, tx)->value = available - value;
    return 0;
  }
  // send: pay custody to the caller with this response
  if (ledger_self(c, block, tx)) {
    error(c, 17);
    return 0;
  }
  U h = ledger_held(c, block, tx);
  if (c->code)
    return 0;
  if (h < value) {
    error(c, 15);
    return 0;
  }
  Asset *a = asset(c, block, tx);
  a->value = add(c, a->value, value);
  return 0;
}

/* ---- Chain queries, ledger reads and external calls (word-v1 vault,
 * treasury and router subset). They are separate leaves so the ones above,
 * and every contract that does not use these features, stay unchanged.
 * Error 18 is PRECOMPILE_TAKES_NO_ASSETS. */
// Kinds: 0 height() (the host's u64, zero-extended like bytesToU128),
// 1 available(id) (this invocation's ledger amount; never inserts).
EXPORT("w_query") N word_query(Context *c, N kind, N b, N t) {
  if (c->code)
    return 0;
  if (kind == 0) {
    N out = reserve(16);
    memset((void *)out, 0, 16);
    host_height(out);
    N n = get32(out - 4);
    unsigned char bytes[16];
    for (N i = 0; i < 16; i++)
      bytes[i] = i < n ? ((unsigned char *)out)[i] : 0;
    U v;
    __builtin_memcpy(&v, bytes, 16);
    return word(v);
  }
  if (kind == 1) {
    Asset *a = ledger_find(c, get(b), get(t));
    return word(a ? a->value : 0);
  }
  error(c, 1);
  return 0;
}
// this.assets.call(new Cellpack(target, [inputs]), parcel, fuel) as a
// statement. The compiler evaluates every argument first, in source order,
// then fills a builder [cellpack, parcel, next input, next transfer]:
// kind 0 creates it (a, b: target words, d: inputs | transfers << 16),
// 1 appends an input (a), 2 a transfer (a, b: id words, d: amount), and
// 3 invokes it with fuel word a, following sdk/assets.ts Assets.call.
EXPORT("w_extcall") N word_extcall(Context *c, N kind, N p, N a, N b, N d) {
  if (c->code)
    return 0;
  if (kind == 0) {
    N inputs = d & 0xffff, transfers = d >> 16, builder = reserve(16), cp = reserve(32 + inputs * 16),
      parcel = reserve(16 + transfers * 48);
    put(cp, get(a));
    put(cp + 16, get(b));
    put(parcel, transfers);
    put32(builder, cp);
    put32(builder + 4, parcel);
    put32(builder + 8, cp + 32);
    put32(builder + 12, parcel + 16);
    return builder;
  }
  if (kind == 1) {
    N o = get32(p + 8);
    put(o, get(a));
    put32(p + 8, o + 16);
    return 0;
  }
  if (kind == 2) {
    N o = get32(p + 12);
    put(o, get(a));
    put(o + 16, get(b));
    put(o + 32, get(d));
    put32(p + 12, o + 48);
    return 0;
  }
  if (kind != 3) {
    error(c, 1);
    return 0;
  }
  if (!writable(c))
    return 0;
  N cp = get32(p), parcel = get32(p + 4), count = (N)get(parcel);
  // The host never moves assets for a precompile call, so the ledger debit
  // below would silently turn them into custody.
  if (get(cp) == (U)800000000 && count) {
    error(c, 18);
    return 0;
  }
  // Each transfer leaves the ledger in parcel order; an absent asset is
  // inserted at the end, like the bigint ledger's Map.
  for (N i = 0; i < count; i++) {
    N q = parcel + 16 + i * 48;
    U block = get(q), tx = get(q + 16), value = get(q + 32);
    Asset *e = ledger_find(c, block, tx);
    U have = e ? e->value : 0;
    if (have < value) {
      error(c, 3);
      return 0;
    }
    asset(c, block, tx)->value = have - value;
  }
  host_call(c, cp, parcel, (L)get(a));
  return 0;
}
