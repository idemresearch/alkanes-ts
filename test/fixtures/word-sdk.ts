import {Contract,method,view,type u128} from '../../sdk/authoring.ts';
import {StoragePointer,height,log} from '../../sdk/index.ts';
export default class WordSDKProbe extends Contract {
  private readonly value=new StoragePointer('/raw');
  @view({opcode:0}) product(a:u128,b:u128):u128{return a*b;}
  @view({opcode:1}) rounded(a:u128):u128{return BigInt(Number(a));}
  @method({opcode:2}) store(a:u128):u128{this.value.setU128(a);return this.value.getU128();}
  @view({opcode:3}) read():u128{return this.value.getU128();}
  @view({opcode:4}) height():u128{const h=height();log('height '+h.toString());return h;}
}
