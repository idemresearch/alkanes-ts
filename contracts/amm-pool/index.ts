import { Contract, state, init, method, view, assert, type AlkaneId, type u128 } from "../../sdk/authoring.ts";
import { mulDiv, mulDivUp, mulSqrt } from "../../sdk/u128.ts";

// Constant-product pool for two alkanes. LP shares are this contract's own
// alkane: adding liquidity issues them, removing liquidity takes them back
// into the pool's custody (out of circulation).
//
// Reserves are stored, not read from balances, so assets sent to the pool by
// other means never change prices or share value. Unused deposit amounts and
// unrelated incoming assets are returned with the response.
export default class AmmPool extends Contract {
  @state({ key: "/token0" }) private token0!: AlkaneId;
  @state({ key: "/token1" }) private token1!: AlkaneId;
  @state({ key: "/reserve0" }) private reserve0: u128 = 0n;
  @state({ key: "/reserve1" }) private reserve1: u128 = 0n;
  // Circulating LP plus the permanently locked minimum liquidity.
  @state({ key: "/supply" }) private supply: u128 = 0n;

  @init({ opcode: 0 })
  initialize(token0: AlkaneId, token1: AlkaneId): void {
    assert(!(token0.block === token1.block && token0.tx === token1.tx), "IDENTICAL_TOKENS");
    // The pool's own ID is its LP share; it cannot also be a reserve asset.
    const self = this.context.myself;
    assert(!(token0.block === self.block && token0.tx === self.tx), "LP_TOKEN_AS_RESERVE");
    assert(!(token1.block === self.block && token1.tx === self.tx), "LP_TOKEN_AS_RESERVE");
    this.token0 = token0;
    this.token1 = token1;
  }

  // Deposits token0 and token1 at the current price and issues LP shares.
  // The first deposit sets the price and locks 1000 shares forever.
  @method({ opcode: 1, incomingAssets: "forward" })
  addLiquidity(minLiquidity: u128): u128 {
    const desired0 = this.assets.received(this.token0);
    const desired1 = this.assets.received(this.token1);
    assert(desired0 > 0n && desired1 > 0n, "INSUFFICIENT_INPUT");
    let used0 = desired0;
    let used1 = desired1;
    let liquidity = 0n;
    if (this.supply === 0n) {
      const root = mulSqrt(desired0, desired1);
      assert(root > 1000n, "INSUFFICIENT_LIQUIDITY_MINTED");
      liquidity = root - 1000n;
      this.supply = root;
    } else {
      const optimal1 = mulDiv(desired0, this.reserve1, this.reserve0);
      if (optimal1 <= desired1) used1 = optimal1;
      else used0 = mulDiv(desired1, this.reserve0, this.reserve1);
      const byToken0 = mulDiv(used0, this.supply, this.reserve0);
      const byToken1 = mulDiv(used1, this.supply, this.reserve1);
      liquidity = byToken0 < byToken1 ? byToken0 : byToken1;
      assert(liquidity > 0n, "INSUFFICIENT_LIQUIDITY_MINTED");
      this.supply += liquidity;
    }
    assert(liquidity >= minLiquidity, "SLIPPAGE");
    this.assets.retain(this.token0, used0);
    this.assets.retain(this.token1, used1);
    this.reserve0 += used0;
    this.reserve1 += used1;
    this.assets.mintSelf(liquidity);
    return liquidity;
  }

  // Redeems the incoming LP shares for a proportional share of both reserves.
  @method({ opcode: 2, incomingAssets: "forward" })
  removeLiquidity(min0: u128, min1: u128): u128 {
    const liquidity = this.assets.received(this.context.myself);
    assert(liquidity > 0n, "INSUFFICIENT_INPUT");
    const amount0 = mulDiv(liquidity, this.reserve0, this.supply);
    const amount1 = mulDiv(liquidity, this.reserve1, this.supply);
    assert(amount0 > 0n && amount1 > 0n, "INSUFFICIENT_LIQUIDITY_BURNED");
    assert(amount0 >= min0 && amount1 >= min1, "SLIPPAGE");
    this.assets.retain(this.context.myself, liquidity);
    this.supply -= liquidity;
    this.reserve0 -= amount0;
    this.reserve1 -= amount1;
    this.assets.send(this.token0, amount0);
    this.assets.send(this.token1, amount1);
    return liquidity;
  }

  // Swaps the entire incoming amount of one pool token for the other, with a
  // 0.3% fee that stays in the reserves.
  @method({ opcode: 3, incomingAssets: "forward" })
  swap(minOut: u128): u128 {
    const in0 = this.assets.received(this.token0);
    const in1 = this.assets.received(this.token1);
    assert((in0 > 0n) !== (in1 > 0n), "SINGLE_INPUT_REQUIRED");
    const zeroForOne = in0 > 0n;
    const amountIn = zeroForOne ? in0 : in1;
    const reserveIn = zeroForOne ? this.reserve0 : this.reserve1;
    const reserveOut = zeroForOne ? this.reserve1 : this.reserve0;
    assert(reserveIn > 0n && reserveOut > 0n, "INSUFFICIENT_LIQUIDITY");
    const amountOut = this.amountOut(amountIn, reserveIn, reserveOut);
    assert(amountOut > 0n, "INSUFFICIENT_OUTPUT_AMOUNT");
    assert(amountOut >= minOut, "SLIPPAGE");
    if (zeroForOne) {
      this.assets.retain(this.token0, amountIn);
      this.assets.send(this.token1, amountOut);
      this.reserve0 = reserveIn + amountIn;
      this.reserve1 = reserveOut - amountOut;
    } else {
      this.assets.retain(this.token1, amountIn);
      this.assets.send(this.token0, amountOut);
      this.reserve1 = reserveIn + amountIn;
      this.reserve0 = reserveOut - amountOut;
    }
    return amountOut;
  }

  // Output for an exact input, 0.3% fee: in*997*rOut / (rIn*1000 + in*997).
  private amountOut(amountIn: u128, reserveIn: u128, reserveOut: u128): u128 {
    const inWithFee = amountIn * 997n;
    return mulDiv(inWithFee, reserveOut, reserveIn * 1000n + inWithFee);
  }

  @view({ opcode: 10 })
  quote0For1(amountIn: u128): u128 { return this.amountOut(amountIn, this.reserve0, this.reserve1); }

  @view({ opcode: 11 })
  quote1For0(amountIn: u128): u128 { return this.amountOut(amountIn, this.reserve1, this.reserve0); }

  @view({ opcode: 20 })
  getReserve0(): u128 { return this.reserve0; }

  @view({ opcode: 21 })
  getReserve1(): u128 { return this.reserve1; }

  @view({ opcode: 22 })
  totalSupply(): u128 { return this.supply; }

  @view({ opcode: 23 })
  getToken0(): AlkaneId { return this.token0; }

  @view({ opcode: 24 })
  getToken1(): AlkaneId { return this.token1; }
}
