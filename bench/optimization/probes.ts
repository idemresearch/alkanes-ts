// Paired kernels: same algorithm, only scriptc's type contracts differ.
import type { Acyclic, Immutable, Int32, NoThrow } from "@scriptc/types";

let numbers: number[] = [];
let integers: number[] = [];
const table: number[] = [3, 7, 11, 19];
const immutableTable: Immutable<number[]> = [3, 7, 11, 19];

export function execute(_context: Uint8Array): Uint8Array { return new Uint8Array(20); }
export function meta(): Uint8Array { return new Uint8Array(0); }

export function prepare(n: number): number {
  numbers = [];
  integers = [];
  for (let i = 0; i < n; i++) {
    const value = (Math.imul(i, 7919) + 17) | 0;
    numbers.push(value);
    integers.push(value);
  }
  return numbers.length;
}

export function plainIntegerArray(_n: number): number {
  let hash = 0;
  for (let i = 0; i < numbers.length; i = (i + 1) | 0) hash = (Math.imul(hash, 33) + numbers[i]) | 0;
  return hash >>> 0;
}

export function contractedIntegerArray(_n: number): number {
  let hash: Int32 = 0;
  for (let i: Int32 = 0; i < integers.length; i = (i + 1) | 0) hash = (Math.imul(hash, 33) + integers[i]) | 0;
  return hash >>> 0;
}

function plainMix(value: number): number { return (Math.imul(value, 33) + 7) | 0; }
function contractedMix(value: number): NoThrow<number> { return (Math.imul(value, 33) + 7) | 0; }

export function plainNoThrow(n: number): number {
  let hash = 0;
  for (let i = 0; i < n; i++) hash = plainMix(hash);
  return hash >>> 0;
}

export function contractedNoThrow(n: number): number {
  let hash = 0;
  for (let i = 0; i < n; i++) hash = contractedMix(hash);
  return hash >>> 0;
}

class PlainNode {
  constructor(public readonly value: number) {}
}
class ContractedNode implements Acyclic {
  constructor(public readonly value: number) {}
}

export function plainAcyclic(n: number): number {
  const nodes: PlainNode[] = [];
  for (let i = 0; i < n; i++) nodes.push(new PlainNode(i));
  let sum = 0;
  for (const node of nodes) sum += node.value;
  return sum >>> 0;
}

export function contractedAcyclic(n: number): number {
  const nodes: ContractedNode[] = [];
  for (let i = 0; i < n; i++) nodes.push(new ContractedNode(i));
  let sum = 0;
  for (const node of nodes) sum += node.value;
  return sum >>> 0;
}

export function plainImmutable(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += table[i & 3];
  return sum >>> 0;
}

export function contractedImmutable(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += immutableTable[i & 3];
  return sum >>> 0;
}
