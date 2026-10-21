import { assertWritable } from "./effects.ts";
import { call, fuel } from "./runtime.ts";
import { AlkaneId, AlkaneTransfer, AlkaneTransferParcel, CallResponse, Cellpack, Context } from "./types.ts";
import { add, checked, sub } from "./u128.ts";

// Invocation-local accounting. Only incoming assets and successful call
// returns enter this ledger; assets already held by the contract stay held.
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
