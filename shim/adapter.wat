;; Bridges the alkanes contract ABI to a scriptc wasm32-wasi library module.
;;
;; wasm-merge links this module in under the name "scriptc", so it supplies the
;; module's callback imports (scriptc.__alk_* and scriptc.panic), and it imports
;; the module's own exports under the name "contract".
;;
;; Alkanes passes byte buffers in "arraybuffer layout": the pointer addresses
;; the data, and the u32 length sits in the 4 bytes before it. scriptc passes
;; (pointer, length) pairs. Every buffer handed to the host is allocated with 8
;; bytes of headroom because a 64-bit host writes the length as a usize.
;;
;; scriptc rejects reentry, so callbacks cannot use scriptc_alloc. Buffers made
;; inside callbacks come from an arena the adapter grows with memory.grow
;; (scriptc's allocator takes whole pages from memory.grow too, so the two never
;; overlap). Each callback that queries the host starts by resetting the arena,
;; which also discards the previous scratch result.

(module
  (import "contract" "memory" (memory 0))
  (import "contract" "_initialize" (func $wasi_initialize))
  (import "contract" "scriptc_alloc" (func $alloc (param i32) (result i32)))
  (import "contract" "contract_init" (func $contract_init))
  (import "contract" "contract_execute" (func $contract_execute (param i32 i32 i32 i32)))
  (import "contract" "contract_meta" (func $contract_meta (param i32 i32)))

  (import "env" "abort" (func $env_abort (param i32 i32 i32 i32)))
  (import "env" "__log" (func $env_log (param i32)))
  (import "env" "__request_storage" (func $env_request_storage (param i32) (result i32)))
  (import "env" "__load_storage" (func $env_load_storage (param i32 i32) (result i32)))
  (import "env" "__balance" (func $env_balance (param i32 i32 i32)))
  (import "env" "__request_context" (func $env_request_context (result i32)))
  (import "env" "__load_context" (func $env_load_context (param i32) (result i32)))
  (import "env" "__sequence" (func $env_sequence (param i32)))
  (import "env" "__fuel" (func $env_fuel (param i32)))
  (import "env" "__height" (func $env_height (param i32)))
  (import "env" "__returndatacopy" (func $env_returndatacopy (param i32)))
  (import "env" "__request_transaction" (func $env_request_transaction (result i32)))
  (import "env" "__load_transaction" (func $env_load_transaction (param i32)))
  (import "env" "__request_block" (func $env_request_block (result i32)))
  (import "env" "__load_block" (func $env_load_block (param i32)))
  (import "env" "__call" (func $env_call (param i32 i32 i32 i64) (result i32)))
  (import "env" "__staticcall" (func $env_staticcall (param i32 i32 i32 i64) (result i32)))
  (import "env" "__delegatecall" (func $env_delegatecall (param i32 i32 i32 i64) (result i32)))

  (global $initialized (mut i32) (i32.const 0))
  (global $arena_base (mut i32) (i32.const 0))
  (global $arena_end (mut i32) (i32.const 0))
  (global $arena_next (mut i32) (i32.const 0))
  ;; The most recent host result, read back by the SDK via __alk_scratch_read.
  (global $scratch (mut i32) (i32.const 0))

  ;; Arena arraybuffer of `len` bytes; returns its data pointer.
  (func $reserve (export "__adapter_reserve") (param $len i32) (result i32)
    (local $size i32)
    (local $pages i32)
    (local $old i32)
    (local $p i32)
    ;; 4-byte length prefix + data + 4 bytes of headroom, rounded up to 8.
    (local.set $size (i32.and (i32.add (local.get $len) (i32.const 15)) (i32.const -8)))
    (if (i32.gt_u (local.get $size) (i32.sub (global.get $arena_end) (global.get $arena_next)))
      (then
        (local.set $pages (i32.shr_u (i32.add (local.get $size) (i32.const 65535)) (i32.const 16)))
        (local.set $old (memory.grow (local.get $pages)))
        (if (i32.eq (local.get $old) (i32.const -1)) (then (unreachable)))
        (global.set $arena_base (i32.shl (local.get $old) (i32.const 16)))
        (global.set $arena_next (global.get $arena_base))
        (global.set $arena_end (i32.add (global.get $arena_base) (i32.shl (local.get $pages) (i32.const 16))))))
    (local.set $p (global.get $arena_next))
    (global.set $arena_next (i32.add (local.get $p) (local.get $size)))
    (i32.store (local.get $p) (local.get $len))
    (i32.add (local.get $p) (i32.const 4)))

  (func $reset_arena
    (global.set $arena_next (global.get $arena_base))
    (global.set $scratch (i32.const 0)))

  ;; scriptc_alloc-backed arraybuffer, for use outside callbacks only.
  (func $new_buffer (param $len i32) (result i32)
    (local $p i32)
    (local.set $p (call $alloc (i32.add (local.get $len) (i32.const 8))))
    (if (i32.eqz (local.get $p)) (then (unreachable)))
    (i32.store (local.get $p) (local.get $len))
    (i32.add (local.get $p) (i32.const 4)))

  (func $buffer_len (param $data i32) (result i32)
    (i32.load (i32.sub (local.get $data) (i32.const 4))))

  ;; Copies a (pointer, length) span into a fresh arena arraybuffer.
  (func $to_buffer (param $ptr i32) (param $len i32) (result i32)
    (local $data i32)
    (local.set $data (call $reserve (local.get $len)))
    (memory.copy (local.get $data) (local.get $ptr) (local.get $len))
    (local.get $data))

  (func $new_scratch (param $len i32) (result i32)
    (global.set $scratch (call $reserve (local.get $len)))
    (global.get $scratch))

  (func $ensure_initialized
    (if (i32.eqz (global.get $initialized))
      (then
        (global.set $initialized (i32.const 1))
        (call $wasi_initialize)
        (call $contract_init))))

  ;; Copies a scriptc bytes result (written to two output slots) into an
  ;; arraybuffer the host can read.
  (func $result_buffer (param $slots i32) (result i32)
    (local $len i32)
    (local $data i32)
    (local.set $len (i32.load (i32.add (local.get $slots) (i32.const 4))))
    (local.set $data (call $new_buffer (local.get $len)))
    (memory.copy (local.get $data) (i32.load (local.get $slots)) (local.get $len))
    (local.get $data))

  ;; ---- alkanes entry points ------------------------------------------------

  (func (export "__execute") (result i32)
    (local $ctx i32)
    (local $len i32)
    (local $slots i32)
    (call $ensure_initialized)
    (local.set $len (call $env_request_context))
    (local.set $ctx (call $new_buffer (local.get $len)))
    (drop (call $env_load_context (local.get $ctx)))
    (local.set $slots (call $alloc (i32.const 8)))
    (call $contract_execute (local.get $ctx) (local.get $len) (local.get $slots)
      (i32.add (local.get $slots) (i32.const 4)))
    (call $result_buffer (local.get $slots)))

  (func (export "__meta") (result i32)
    (local $slots i32)
    (call $ensure_initialized)
    (local.set $slots (call $alloc (i32.const 8)))
    (call $contract_meta (local.get $slots) (i32.add (local.get $slots) (i32.const 4)))
    (call $result_buffer (local.get $slots)))

  ;; ---- scriptc callbacks ---------------------------------------------------

  (func (export "__alk_abort")
    (call $env_abort (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))

  (func (export "__alk_log") (param $ptr i32) (param $len i32)
    (local $data i32)
    (local.set $data (call $to_buffer (local.get $ptr) (local.get $len)))
    (call $env_log (local.get $data)))

  ;; Reads 4 bytes of scratch. Offsets past the end land in the allocation's
  ;; headroom; the SDK ignores bytes beyond the length it was given.
  ;; The offset is declared f64 in the build profile: scriptc would convert a
  ;; u32 argument with an out-of-line ToUint32 on every call, and this is the
  ;; callback every host read repeats. $u32 does the same conversion here; the
  ;; build inserts it (U32_CONVERSION in compiler/word-abi.mjs) at the marker.
  (func (export "__alk_scratch_read") (param $offset f64) (result i32)
    (i32.load (i32.add (global.get $scratch) (call $u32 (local.get $offset)))))
  ;; @u32-conversion

  (func (export "__alk_load_storage") (param $ptr i32) (param $len i32) (result i32)
    (local $key i32)
    (local $out i32)
    (call $reset_arena)
    (local.set $key (call $to_buffer (local.get $ptr) (local.get $len)))
    (local.set $out (call $new_scratch (call $env_request_storage (local.get $key))))
    (drop (call $env_load_storage (local.get $key) (local.get $out)))
    (call $buffer_len (local.get $out)))

  (func (export "__alk_balance") (param $who_ptr i32) (param $who_len i32)
                                 (param $what_ptr i32) (param $what_len i32) (result i32)
    (local $who i32)
    (local $what i32)
    (local $out i32)
    (call $reset_arena)
    (local.set $who (call $to_buffer (local.get $who_ptr) (local.get $who_len)))
    (local.set $what (call $to_buffer (local.get $what_ptr) (local.get $what_len)))
    (local.set $out (call $new_scratch (i32.const 16)))
    (call $env_balance (local.get $who) (local.get $what) (local.get $out))
    (call $buffer_len (local.get $out)))

  (func (export "__alk_sequence") (result i32)
    (local $out i32)
    (call $reset_arena)
    (local.set $out (call $new_scratch (i32.const 16)))
    (call $env_sequence (local.get $out))
    (call $buffer_len (local.get $out)))

  (func (export "__alk_fuel") (result i32)
    (local $out i32)
    (call $reset_arena)
    (local.set $out (call $new_scratch (i32.const 16)))
    (call $env_fuel (local.get $out))
    (call $buffer_len (local.get $out)))

  (func (export "__alk_height") (result i32)
    (local $out i32)
    (call $reset_arena)
    (local.set $out (call $new_scratch (i32.const 16)))
    (call $env_height (local.get $out))
    (call $buffer_len (local.get $out)))

  (func (export "__alk_transaction") (result i32)
    (local $out i32)
    (call $reset_arena)
    (local.set $out (call $new_scratch (call $env_request_transaction)))
    (call $env_load_transaction (local.get $out))
    (call $buffer_len (local.get $out)))

  (func (export "__alk_block") (result i32)
    (local $out i32)
    (call $reset_arena)
    (local.set $out (call $new_scratch (call $env_request_block)))
    (call $env_load_block (local.get $out))
    (call $buffer_len (local.get $out)))

  ;; kind: 0 = call, 1 = delegatecall, 2 = staticcall. Returns the host result
  ;; (returndata length, negated on failure) and leaves returndata in scratch.
  (func (export "__alk_extcall")
    (param $kind i32)
    (param $cellpack_ptr i32) (param $cellpack_len i32)
    (param $alkanes_ptr i32) (param $alkanes_len i32)
    (param $storage_ptr i32) (param $storage_len i32)
    (param $fuel f64)
    (result i32)
    (local $cellpack i32)
    (local $alkanes i32)
    (local $storage i32)
    (local $fuel_u64 i64)
    (local $result i32)
    (local $size i32)
    (call $reset_arena)
    (local.set $cellpack (call $to_buffer (local.get $cellpack_ptr) (local.get $cellpack_len)))
    (local.set $alkanes (call $to_buffer (local.get $alkanes_ptr) (local.get $alkanes_len)))
    (local.set $storage (call $to_buffer (local.get $storage_ptr) (local.get $storage_len)))
    (local.set $fuel_u64 (i64.trunc_sat_f64_u (local.get $fuel)))
    (local.set $result
      (if (result i32) (i32.eq (local.get $kind) (i32.const 1))
        (then (call $env_delegatecall (local.get $cellpack) (local.get $alkanes) (local.get $storage) (local.get $fuel_u64)))
        (else
          (if (result i32) (i32.eq (local.get $kind) (i32.const 2))
            (then (call $env_staticcall (local.get $cellpack) (local.get $alkanes) (local.get $storage) (local.get $fuel_u64)))
            (else (call $env_call (local.get $cellpack) (local.get $alkanes) (local.get $storage) (local.get $fuel_u64)))))))
    (local.set $size
      (if (result i32) (i32.lt_s (local.get $result) (i32.const 0))
        (then (i32.sub (i32.const 0) (local.get $result)))
        (else (local.get $result))))
    (call $env_returndatacopy (call $new_scratch (local.get $size)))
    (local.get $result))

  ;; A scriptc trap or uncaught exception. Log the diagnostic, flag the failure
  ;; to the host, and return; scriptc traps right after, which reverts the call.
  (func (export "panic") (param $ptr i32) (param $len i32)
    (local $data i32)
    (local.set $data (call $to_buffer (local.get $ptr) (local.get $len)))
    (call $env_log (local.get $data))
    (call $env_abort (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
)
