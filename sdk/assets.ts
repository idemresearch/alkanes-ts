import { assertWritable } from "./effects.ts";
import { balance, call, fuel } from "./runtime.ts";
import { AlkaneId, AlkaneTransfer, AlkaneTransferParcel, CallResponse, Cellpack, Context } from "./types.ts";
import { add, checked, sub } from "./u128.ts";

// Invocation-local accounting. Incoming assets, self issuance and successful
// call returns enter this ledger, and whatever remains in it is returned to the
// caller. Everything else the contract owns is custody: it stays held unless
// the contract explicitly moves it into the ledger with send().
//
// The host credits incoming assets and call returns to the contract's balance
// before code observes them, and debits the response afterwards. So for any
// asset other than the contract's own ID, host balance minus ledger is exactly
// the custody that may still be spent: prior holdings, plus amounts retained
// in this invocation, minus amounts already sent.
export class Assets {
  private balances = new Map<string, AlkaneTransfer>();
  private reconciliationFailed = false;
  private readonly incoming: AlkaneTransferParcel;

  constructor(private readonly context: Context) {
    this.incoming = new AlkaneTransferParcel(context.incomingAlkanes.transfers.slice());
    this.credit(this.incoming);
  }

  private credit(parcel: AlkaneTransferParcel): void {
    for (const transfer of parcel.transfers) {
      const key = transfer.id.toString();
      const existing = this.balances.get(key);
      const value = add(existing === undefined ? 0n : existing.value, checked(transfer.value));
      this.balances.set(key, new AlkaneTransfer(transfer.id, value));
    }
  }

  available(id: AlkaneId): bigint {
    const entry = this.balances.get(id.toString());
    return entry === undefined ? 0n : entry.value;
  }

  // Total of `id` in the invocation's original incoming parcel.
  received(id: AlkaneId): bigint {
    let total = 0n;
    for (const transfer of this.incoming.transfers) if (transfer.id.equals(id)) total = add(total, checked(transfer.value));
    return total;
  }

  // Spendable custody of another asset: host balance minus this ledger.
  held(id: AlkaneId): bigint {
    if (id.equals(this.context.myself)) throw new Error("SELF_CUSTODY_UNSUPPORTED");
    return sub(balance(this.context.myself, id), this.available(id));
  }

  // Keeps `amount` of a ledger asset in custody instead of returning it. For
  // the contract's own ID this takes the tokens out of circulation.
  retain(id: AlkaneId, amount: bigint): void {
    assertWritable();
    const value = checked(amount);
    if (this.available(id) < value) throw new Error("INSUFFICIENT_LEDGER");
    this.balances.set(id.toString(), new AlkaneTransfer(id, this.available(id) - value));
  }

  // Pays `amount` of an asset held in custody to the caller with this response.
  send(id: AlkaneId, amount: bigint): void {
    assertWritable();
    const value = checked(amount);
    if (id.equals(this.context.myself)) throw new Error("SELF_SEND_USE_MINT_SELF");
    if (this.held(id) < value) throw new Error("INSUFFICIENT_CUSTODY");
    this.credit(new AlkaneTransferParcel().pay(id, value));
  }

  mintSelf(amount: bigint): void {
    assertWritable();
    this.credit(new AlkaneTransferParcel().pay(this.context.myself, checked(amount)));
  }

  call(cellpack: Cellpack, transfers: AlkaneTransferParcel, fuelLimit: number): CallResponse {
    assertWritable();
    const saved = this.balances;
    this.balances = new Map<string, AlkaneTransfer>();
    for (const entry of saved.values()) this.balances.set(entry.id.toString(), entry);
    let response: CallResponse;
    try {
      for (const transfer of transfers.transfers) {
        const remaining = sub(this.available(transfer.id), checked(transfer.value));
        this.balances.set(transfer.id.toString(), new AlkaneTransfer(transfer.id, remaining));
      }
      response = call(cellpack, transfers, fuelLimit);
    } catch (error) {
      this.balances = saved;
      throw error;
    }
    try { this.credit(response.alkanes); }
    catch (error) {
      // The host call already succeeded. A caught reconciliation error must
      // never let the invocation publish an incomplete asset ledger.
      this.reconciliationFailed = true;
      throw error;
    }
    return response;
  }

  finish(data: Uint8Array): CallResponse {
    if (this.reconciliationFailed) throw new Error("ASSET_RECONCILIATION_FAILED");
    const parcel = new AlkaneTransferParcel();
    for (const entry of this.balances.values()) if (entry.value !== 0n) parcel.pay(entry.id, entry.value);
    return new CallResponse(parcel, data);
  }

  authenticate(authority: AlkaneId): void {
    assertWritable();
    let received = false;
    for (const transfer of this.incoming.transfers) {
      if (transfer.id.equals(authority) && transfer.value > 0n) received = true;
    }
    // AuthenticatedResponder checks the invocation's original incoming parcel.
    // Self issuance or a mutated Context must not manufacture that proof.
    if (!received) throw new Error("AUTH_ASSET_REQUIRED");
    if (this.available(authority) === 0n) throw new Error("AUTH_ASSET_REQUIRED");
    if (authority.equals(this.context.myself)) return;
    const budget = fuel();
    if (budget > 9_007_199_254_740_991n) throw new Error("AUTH_FUEL_OUT_OF_RANGE");
    const response = this.call(new Cellpack(authority, [1n]), new AlkaneTransferParcel().pay(authority, 1n), Number(budget));
    if (response.data.length !== 1 || response.data[0] !== 1) throw new Error("AUTH_REJECTED");
  }
}

export class Auth {
  constructor(private readonly assets: Assets) {}
  require(authority: AlkaneId): void { this.assets.authenticate(authority); }
}
