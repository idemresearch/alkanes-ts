import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AlkanesVM} from './vm.mjs';

// The JS host follows alkanes-rs src/utils.rs credit_balances,
// checked_debit_with_minting and transfer_from.
const a={block:2n,tx:1n},b={block:2n,tx:2n},token={block:2n,tx:9n},user={block:0n,tx:0n};
const MAX=(1n<<128n)-1n;

test('debits beyond a balance fail except for the debtor\'s own ID, which mints the shortfall',()=>{
  const vm=new AlkanesVM();
  vm.credit(a,[{id:token,value:5n}]);
  assert.throws(()=>vm.debit(a,[{id:token,value:6n}]),/balance underflow/);
  vm.debit(a,[{id:token,value:5n}]);assert.equal(vm.balanceOf(a,token),0n);
  // Own ID: existing balance is used first, then the rest is minted.
  vm.credit(a,[{id:a,value:3n}]);
  vm.debit(a,[{id:a,value:10n}]);assert.equal(vm.balanceOf(a,a),0n);
});

test('transfers move each entry in order and never touch the non-contract [0,0]',()=>{
  const vm=new AlkanesVM();
  vm.credit(a,[{id:token,value:5n}]);
  // Self-transfer of duplicate entries succeeds because each entry is debited then credited.
  vm.transfer([{id:token,value:5n},{id:token,value:5n}],a,a);assert.equal(vm.balanceOf(a,token),5n);
  vm.transfer([{id:token,value:2n}],a,b);
  assert.equal(vm.balanceOf(a,token),3n);assert.equal(vm.balanceOf(b,token),2n);
  vm.transfer([{id:token,value:3n}],a,user);
  assert.equal(vm.balanceOf(a,token),3n,'transfer_from skips a [0,0] recipient entirely');
  vm.credit(user,[{id:token,value:1n}]);assert.equal(vm.balanceOf(user,token),0n);
  assert.throws(()=>vm.credit(b,[{id:token,value:MAX}]),/balance overflow/);
});

test('balance movement can be disabled for parcel-isolation tests',()=>{
  const vm=new AlkanesVM({balances:false});
  vm.credit(a,[{id:token,value:5n}]);vm.debit(a,[{id:token,value:50n}]);
  assert.equal(vm.balanceOf(a,token),0n);
});
