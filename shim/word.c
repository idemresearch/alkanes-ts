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
  if (tracked)
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
  int result = call(cp, parcel, checkpoint(c), f);
  N n = result < 0 ? (N)(-(long long)result) : (N)result;
  if (n < 16) {
    error(c, 10);
    return;
  }
  N returned = reserve(n);
  returndata(returned);
  U transfers = get(returned);
  if (transfers > (n - 16) / 48) {
    error(c, 10);
    return;
  }
  N data = returned + 16 + (N)transfers * 48, dlen = n - 16 - (N)transfers * 48;
  if (result < 0) {
    error(c, 11);
    if (dlen >= 4 && ((unsigned char *)data)[0] == 8 && ((unsigned char *)data)[1] == 195 &&
        ((unsigned char *)data)[2] == 121 && ((unsigned char *)data)[3] == 160) {
      c->tail = data + 4;
      c->tlen = dlen - 4;
    }
    return;
  }
  c->storage = 0;
  credit(c, returned + 16, (N)transfers);
  if (dlen != 1 || *(unsigned char *)data != 1)
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
