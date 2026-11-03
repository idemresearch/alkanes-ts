// The frontend lowers bigint operators in contract bodies to these functions.
// Keep this implementation outside that transform: operations here use wider
// bigint intermediates, then check the result at each source operation.
export const U128_LIMIT = (1n << 128n) - 1n;

export function checked(value: bigint): bigint {
  if (value < 0n) throw new Error("u128 underflow");
  if (value > U128_LIMIT) throw new Error("u128 overflow");
  return value;
}

export function add(a: bigint, b: bigint): bigint { return checked(checked(a) + checked(b)); }
export function sub(a: bigint, b: bigint): bigint { return checked(checked(a) - checked(b)); }
export function mul(a: bigint, b: bigint): bigint { return checked(checked(a) * checked(b)); }
export function div(a: bigint, b: bigint): bigint {
  checked(a); checked(b);
  if (b === 0n) throw new Error("u128 division by zero");
  return a / b;
}
export function mod(a: bigint, b: bigint): bigint {
  checked(a); checked(b);
  if (b === 0n) throw new Error("u128 division by zero");
  return a % b;
}
export function bitAnd(a: bigint, b: bigint): bigint { return checked(a) & checked(b); }
export function bitOr(a: bigint, b: bigint): bigint { return checked(a) | checked(b); }
export function bitXor(a: bigint, b: bigint): bigint { return checked(a) ^ checked(b); }
export function shl(a: bigint, b: bigint): bigint {
  checked(a); checked(b);
  if (b >= 128n) throw new Error("u128 shift out of range");
  return checked(a << b);
}
export function shr(a: bigint, b: bigint): bigint {
  checked(a); checked(b);
  if (b >= 128n) throw new Error("u128 shift out of range");
  return a >> b;
}
export function bitNot(a: bigint): bigint { return U128_LIMIT ^ checked(a); }

// Explicit wrapping, and a wider product for AMM-style mul/div. The public
// boundaries validate operands even when called from ordinary TypeScript.
export function wrappingAdd(a: bigint, b: bigint): bigint { return (checked(a) + checked(b)) & U128_LIMIT; }
export function wrappingSub(a: bigint, b: bigint): bigint { return (checked(a) - checked(b)) & U128_LIMIT; }
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  checked(a); checked(b); checked(denominator);
  if (denominator === 0n) throw new Error("u128 division by zero");
  return checked((a * b) / denominator);
}
export function mulDivUp(a: bigint, b: bigint, denominator: bigint): bigint {
  checked(a); checked(b); checked(denominator);
  if (denominator === 0n) throw new Error("u128 division by zero");
  const product = a * b;
  return checked(product / denominator + (product % denominator === 0n ? 0n : 1n));
}
export function min(a: bigint, b: bigint): bigint { return checked(a) < checked(b) ? a : b; }
export function max(a: bigint, b: bigint): bigint { return checked(a) > checked(b) ? a : b; }

// Floor square root of a nonnegative integer below 2^256 (Newton's method from
// an upper bound, so the sequence decreases monotonically to the root).
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let bits = 0n;
  for (let v = n; v > 0n; v = v >> 1n) bits = bits + 1n;
  let x = 1n << ((bits + 1n) >> 1n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
export function sqrt(a: bigint): bigint { return isqrt(checked(a)); }
// floor(sqrt(a * b)) with the exact 256-bit product; the root always fits u128.
export function mulSqrt(a: bigint, b: bigint): bigint { return isqrt(checked(a) * checked(b)); }
