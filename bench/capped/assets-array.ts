import { assertWritable } from "./effects.ts";
import { call, fuel } from "./runtime.ts";
import { AlkaneId, AlkaneTransfer, AlkaneTransferParcel, CallResponse, Cellpack, Context } from "./types.ts";
import { add, checked, sub } from "./u128.ts";

export class Assets {
  private balances: AlkaneTransfer[] = [];
  private reconciliationFailed = false;
  private readonly incoming: AlkaneTransferParcel;
  constructor(private readonly context: Context) {
    this.incoming = new AlkaneTransferParcel(context.incomingAlkanes.transfers.slice());
    this.credit(this.incoming);
  }
  private index(id: AlkaneId): number {
    for (let i=0;i<this.balances.length;i++) if(this.balances[i].id.equals(id)) return i;
    return -1;
  }
  private set(id:AlkaneId,value:bigint):void {
    const i=this.index(id),entry=new AlkaneTransfer(id,value);
    if(i<0)this.balances.push(entry);else this.balances[i]=entry;
  }
  private credit(parcel:AlkaneTransferParcel):void {
    for(const transfer of parcel.transfers) this.set(transfer.id,add(this.available(transfer.id),checked(transfer.value)));
  }
  available(id:AlkaneId):bigint {
    const i=this.index(id);return i<0?0n:this.balances[i].value;
  }
  mintSelf(amount:bigint):void {
    assertWritable();this.set(this.context.myself,add(this.available(this.context.myself),checked(amount)));
  }
  call(cellpack:Cellpack,transfers:AlkaneTransferParcel,fuelLimit:number):CallResponse {
    assertWritable();const saved=this.balances;this.balances=saved.slice();
    let response:CallResponse;
    try {
      for(const transfer of transfers.transfers)this.set(transfer.id,sub(this.available(transfer.id),checked(transfer.value)));
      response=call(cellpack,transfers,fuelLimit);
    }catch(error){this.balances=saved;throw error;}
    try{this.credit(response.alkanes);}catch(error){this.reconciliationFailed=true;throw error;}
    return response;
  }
  finish(data:Uint8Array):CallResponse {
    if(this.reconciliationFailed)throw new Error("ASSET_RECONCILIATION_FAILED");
    const parcel=new AlkaneTransferParcel();
    for(const entry of this.balances)if(entry.value!==0n)parcel.pay(entry.id,entry.value);
    return new CallResponse(parcel,data);
  }
  authenticate(authority:AlkaneId):void {
    assertWritable();let received=false;
    for(const transfer of this.incoming.transfers)if(transfer.id.equals(authority)&&transfer.value>0n)received=true;
    if(!received||this.available(authority)===0n)throw new Error("AUTH_ASSET_REQUIRED");
    if(authority.equals(this.context.myself))return;
    const budget=fuel();if(budget>9_007_199_254_740_991n)throw new Error("AUTH_FUEL_OUT_OF_RANGE");
    const response=this.call(new Cellpack(authority,[1n]),new AlkaneTransferParcel().pay(authority,1n),Number(budget));
    if(response.data.length!==1||response.data[0]!==1)throw new Error("AUTH_REJECTED");
  }
}
export class Auth {
  constructor(private readonly assets:Assets){}
  require(authority:AlkaneId):void{this.assets.authenticate(authority);}
}
