import {Contract,method,type u128} from '../../sdk/authoring.ts';
import {AlkaneId,Cellpack,AlkaneTransferParcel,CallResponse,call} from '../../sdk/index.ts';
export default class WordRelay extends Contract {
  @method({opcode:9}) initialize():void{}
  @method({opcode:0}) invoke(block:u128,tx:u128,opcode:u128,value:u128):CallResponse {
    return call(new Cellpack(new AlkaneId(block,tx),[opcode,value]),new AlkaneTransferParcel(),1_000_000);
  }
}
