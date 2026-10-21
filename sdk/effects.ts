// A runtime backstop for compiler-enforced views, shared by storage and the
// lowest SDK extcall boundary. Legacy contracts begin in writable mode.
let readOnly = false;
export function setReadOnly(value: boolean): void { readOnly = value; }
export function assertWritable(): void {
  if (readOnly) throw new Error("view cannot mutate storage or call a mutating contract");
}
