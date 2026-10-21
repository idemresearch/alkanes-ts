import {Contract,method,view,type u128} from '../../sdk/authoring.ts';
export default class ForwardProbe extends Contract {
 static readonly incomingAssets='forward';
 @method({opcode:0}) echo(w:u128):u128{return w;}
 @view({opcode:1}) read():u128{return 0n;}
}
