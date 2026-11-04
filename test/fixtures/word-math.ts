import {Contract,view,type u128} from '../../sdk/authoring.ts';
import {mulDiv,mulDivUp,mulSqrt,sqrt,min,max} from '../../sdk/u128.ts';
// Differential probe for the word-v1 wide arithmetic: every operation, plus
// local reassignment, ternaries, boolean equality, helpers and error order.
export default class WordMath extends Contract {
 @view({opcode:1}) muldiv(a:u128,b:u128,d:u128):u128{return mulDiv(a,b,d);}
 @view({opcode:2}) muldivup(a:u128,b:u128,d:u128):u128{return mulDivUp(a,b,d);}
 @view({opcode:3}) mulsqrt(a:u128,b:u128):u128{return mulSqrt(a,b);}
 @view({opcode:4}) root(a:u128):u128{return sqrt(a);}
 @view({opcode:5}) least(a:u128,b:u128):u128{return min(a,b);}
 @view({opcode:6}) most(a:u128,b:u128):u128{return max(a,b);}
 @view({opcode:7}) quotient(a:u128,b:u128):u128{return a/b;}
 @view({opcode:8}) remainder(a:u128,b:u128):u128{return a%b;}
 @view({opcode:9}) product(a:u128,b:u128):u128{return a*b;}
 // Several operations can fail; the first one evaluated must win.
 @view({opcode:10}) order(a:u128,b:u128,d:u128):u128{return mulDiv(a*b,a/d,b%d+1n);}
 @view({opcode:11}) chain(a:u128,b:u128,d:u128):u128{
  let x=a;
  x%=d;
  x*=b;
  x/=d;
  x+=1n;
  x-=1n;
  return x;
 }
 private bigger(a:u128,b:u128):boolean{return a>b;}
 private pick(flag:boolean,a:u128,b:u128):u128{return flag?a:b;}
 private mean(a:u128,b:u128):u128{let s=a;s+=b;s=s/2n;return s;}
 @view({opcode:12}) helpers(a:u128,b:u128,d:u128):u128{
  const up=this.bigger(a,b);
  const same=up===(b<a);
  if(same!==true)return 0n;
  let out=this.pick(up,mulDivUp(a,b,d),this.mean(a,b));
  out=up?out:min(out,max(a,b));
  return out;
 }
}
