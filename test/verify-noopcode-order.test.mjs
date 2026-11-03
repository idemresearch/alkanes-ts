// Minor, host-unreachable divergence newly inherited by AmmPool when it moves to
// word-v1: w_begin credits the incoming parcel before the "No opcode provided"
// check, while the bigint dispatcher checks the opcode before new Assets(context)
// credits it. Only an input with NO opcode and duplicate incoming entries whose
// sum exceeds u128 observes it (a canonical host overflows in credit_balances
// before contract code runs, so the VM reproduces it only with balances:false).
// Both outcomes revert with identical state; only the revert message differs.
import {test} from 'node:test';
import {MAX,inc,ids,buildPair,differential} from './differential.mjs';

test('AmmPool: no-opcode + overflowing duplicate incoming reverts with the bigint message',()=>{
 const amm=buildPair('verify-amm-noop','contracts/amm-pool/index.ts');
 const pool={block:2n,tx:80n},a={block:2n,tx:81n},b={block:2n,tx:82n};
 differential(amm,pool,[
  [{inputs:[0,...ids(a,b)]},'ok'],
  [{inputs:[],incoming:inc([a,5])},/No opcode provided/],
  // bigint: "No opcode provided"; word-v1 (this patch): "u128 overflow".
  [{inputs:[],incoming:inc([a,MAX],[a,1])},/No opcode provided/],
 ],{balances:false});
});
