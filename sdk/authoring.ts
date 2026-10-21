// Compiler markers. Importing this module is safe; executing a decorated
// contract without the Alkanes frontend is deliberately an error.
export type u128 = bigint;

import type { Context } from "./types.ts";
import type { Assets, Auth } from "./assets.ts";
export type { AlkaneId } from "./types.ts";

export class Contract {
  protected get context(): Context { return compilerOnly(); }
  protected get assets(): Assets { return compilerOnly(); }
  protected get auth(): Auth { return compilerOnly(); }
}

export interface StateOptions { key: string }
export interface MethodOptions { opcode: number | bigint; abiName?: string; incomingAssets?: "reject" | "forward" }

function compilerOnly(..._args: unknown[]): never {
  throw new Error("Decorated contracts must be built with the Alkanes compiler frontend");
}

export function state(_options: StateOptions): typeof compilerOnly { return compilerOnly; }
export function method(_options: MethodOptions): typeof compilerOnly { return compilerOnly; }
export function view(_options: MethodOptions): typeof compilerOnly { return compilerOnly; }
export function init(_options: MethodOptions): typeof compilerOnly { return compilerOnly; }
export function assert(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
