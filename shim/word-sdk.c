// Additional SDK leaves for checked loops, raw storage and legacy responses.
// Contract dispatch, loops, ownership checks and response policy remain TS.
#include "word.c"
HOST("__height") void host_height(N);
HOST("__log") void host_log(N);

EXPORT("w_copybytes") N copybytes(N p, N n) { return copy(p, n); }
EXPORT("w_copyraw") N copyraw(N p, N n) { return copy(p, n); }
EXPORT("w_size") N size(N p) { return get32(p - 4); }
EXPORT("w_concat") N concat(N a, N b) {
  N an = size(a), bn = size(b), p = reserve(an + bn);
  memcpy((void *)p, (void *)a, an);
  memcpy((void *)(p + an), (void *)b, bn);
  return p;
}
EXPORT("w_equalbytes") N equalbytes(N a, N b) {
  return size(a) == size(b) && equal(a, b, size(a));
}
EXPORT("w_decode") N decode(Context *c, N p, N offset) {
  if (c->code) return word(0);
  N n = size(p), out = word(0);
  if (offset < n) {
    n -= offset;
    if (n > 16) n = 16;
    memcpy((void *)out, (void *)(p + offset), n);
  }
  return out;
}
EXPORT("w_rawload") N rawload(Context *c, N key) {
  if (c->code) return reserve(0);
  Entry *e = entry(c, key, size(key));
  if (!e->value) {
    int n = request(e->key);
    if (n < 0) { error(c, 4); return reserve(0); }
    e->len = (N)n;
    e->value = reserve(e->len);
    if (n) load(e->key, e->value);
  }
  return copy(e->value, e->len);
}
EXPORT("w_rawstore") void rawstore(Context *c, N key, N value) {
  state_store(c, key, size(key), value, size(value));
}
EXPORT("w_context") N context(Context *c, N which) {
  return copy(c->myself + which * 32, which == 2 ? 16 : 32);
}
EXPORT("w_parcel") N parcel(Context *c) {
  return copy(c->incoming - 16, 16 + c->incount * 48);
}
EXPORT("w_pay") N pay(N parcel, N b, N t, N value) {
  N n = size(parcel), p = reserve(n + 48);
  memcpy((void *)p, (void *)parcel, n);
  put(p, get(p) + 1);
  put(p + n, get(b));
  put(p + n + 16, get(t));
  put(p + n + 32, get(value));
  return p;
}
EXPORT("w_mul") N mul(Context *c, N a, N b) {
  if (c->code) return 0;
  N x[4], y[4], product[8] = {0};
  __builtin_memcpy(x, (void *)a, 16);
  __builtin_memcpy(y, (void *)b, 16);
  for (N i = 0; i < 4; i++) {
    L carry = 0;
    for (N j = 0; j < 4; j++) {
      L part = (L)x[i] * y[j] + product[i + j] + carry;
      product[i + j] = (N)part;
      carry = part >> 32;
    }
    product[i + 4] = (N)carry;
  }
  if (product[4] || product[5] || product[6] || product[7]) error(c, 2);
  N p = reserve(16);
  memcpy((void *)p, product, 16);
  return p;
}
EXPORT("w_fromnumber") N fromnumber(Context *c, double value) {
  if (c->code) return 0;
  // Comparing with 2^128 also rejects positive infinity. NaN fails >= 0.
  if (!(value >= 0 && value < 0x1p128)) { error(c, value < 0 ? 3 : 2); return 0; }
  if (value == 0) return word(0);
  L bits; __builtin_memcpy(&bits, &value, 8);
  int exponent = (int)((bits >> 52) & 2047) - 1023;
  L mantissa = (bits & 0xfffffffffffffULL) | (1ULL << 52);
  U v;
  if (exponent < 0) { error(c, 2); return 0; }
  if (exponent < 52) {
    N shift = 52 - exponent;
    if (mantissa & ((1ULL << shift) - 1)) { error(c, 2); return 0; }
    v = mantissa >> shift;
  } else v = shift_left(mantissa, exponent - 52);
  return word(v);
}
EXPORT("w_decimal") N decimal(N p) {
  U v = get(p);
  unsigned char digits[40];
  N n = 0;
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
    digits[n++] = (unsigned char)(48 + rem);
  } while (v);
  N out = reserve(n);
  for (N i = 0; i < n; i++) ((unsigned char *)out)[i] = digits[n - 1 - i];
  return out;
}
EXPORT("w_height") N height(void) {
  N p = word(0);
  host_height(p);
  return p;
}
EXPORT("w_log") void log_bytes(N p) { host_log(p); }
EXPORT("w_failbytes") void failbytes(Context *c, N p) { fail(c, p, size(p)); }
EXPORT("w_call") N extcall(Context *c, N cp, N parcel, double budget) {
  if (!writable(c)) return 0;
  if (!(budget >= 0 && budget <= 9007199254740991.0) || (double)(L)budget != budget) {
    error(c, 9); return 0;
  }
  int result = call(cp, parcel, checkpoint(c), (L)budget);
  N n = result < 0 ? (N)(-(long long)result) : (N)result;
  if (n < 16) { error(c, 10); return 0; }
  N returned = reserve(n);
  returndata(returned);
  U transfers = get(returned);
  if (transfers > (n - 16) / 48) { error(c, 10); return 0; }
  N data = returned + 16 + (N)transfers * 48, dlen = n - 16 - (N)transfers * 48;
  if (result < 0) {
    error(c, 10);
    if (dlen > 4 && ((unsigned char *)data)[0] == 8 && ((unsigned char *)data)[1] == 195 &&
        ((unsigned char *)data)[2] == 121 && ((unsigned char *)data)[3] == 160) {
      c->code = 11; c->tail = data + 4; c->tlen = dlen - 4;
    }
    return 0;
  }
  // Precompiles (block 800000000) take no checkpoint and commit nothing, so
  // the buffered writes stay valid; any other call may have changed storage.
  if (get(cp) != (U)800000000) c->storage = 0;
  return returned;
}
EXPORT("w_responsepart") N responsepart(N p, N which) {
  N parcel_len = 16 + (N)get(p) * 48;
  return which ? copy(p + parcel_len, size(p) - parcel_len) : copy(p, parcel_len);
}
EXPORT("w_finishresponse") N finishresponse(Context *c, N parcel, N data, N message, N mlen) {
  if (c->code) return finish(c, 0, 0, message, mlen);
  N storage = checkpoint(c), pn = size(parcel), sn = size(storage), dn = size(data);
  N p = reserve(pn + sn + dn);
  memcpy((void *)p, (void *)parcel, pn);
  memcpy((void *)(p + pn), (void *)storage, sn);
  memcpy((void *)(p + pn + sn), (void *)data, dn);
  return p;
}
