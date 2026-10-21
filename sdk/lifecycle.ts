import { StoragePointer } from "./runtime.ts";

// Reserved storage schema shared by generated TS and the Rust comparison.
const status = new StoragePointer("/__alkanes/init");
const lock = new StoragePointer("/__alkanes/lock");

export function beginInvocation(initializer: boolean, view: boolean): void {
  const state = status.getU128();
  if (initializer) {
    if (state !== 0n) throw new Error("ALREADY_INITIALIZED");
    status.setU128(1n);
  } else {
    if (state !== 2n) throw new Error("NOT_INITIALIZED");
    if (lock.getU128() !== 0n) throw new Error("REENTRANT_CALL");
    if (!view) lock.setU128(1n);
  }
}

export function finishInvocation(initializer: boolean, view: boolean): void {
  if (initializer) status.setU128(2n);
  else if (!view) lock.setU128(0n);
}
