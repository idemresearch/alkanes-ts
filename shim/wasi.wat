;; Deterministic WASI Preview 1 stand-ins, linked in as "wasi_snapshot_preview1".
;;
;; Alkanes executes contracts during block indexing, so anything observable
;; must be identical on every indexer: no environment, a clock fixed at zero,
;; and no randomness. stdout/stderr go to the alkanes __log host function.

(module
  (import "contract" "memory" (memory 0))
  ;; fd_write runs inside contract code, where scriptc_alloc would be reentry,
  ;; so log buffers come from the adapter's arena.
  (import "scriptc" "__adapter_reserve" (func $reserve (param i32) (result i32)))
  (import "env" "__log" (func $env_log (param i32)))

  (func (export "environ_get") (param i32 i32) (result i32)
    (i32.const 0))

  (func (export "environ_sizes_get") (param $count i32) (param $size i32) (result i32)
    (i32.store (local.get $count) (i32.const 0))
    (i32.store (local.get $size) (i32.const 0))
    (i32.const 0))

  (func (export "args_get") (param i32 i32) (result i32)
    (i32.const 0))

  (func (export "args_sizes_get") (param $count i32) (param $size i32) (result i32)
    (i32.store (local.get $count) (i32.const 0))
    (i32.store (local.get $size) (i32.const 0))
    (i32.const 0))

  (func (export "clock_time_get") (param i32 i64) (param $out i32) (result i32)
    (i64.store (local.get $out) (i64.const 0))
    (i32.const 0))

  (func (export "clock_res_get") (param i32) (param $out i32) (result i32)
    (i64.store (local.get $out) (i64.const 1))
    (i32.const 0))

  ;; Nondeterministic by definition; using it in a contract is a bug.
  (func (export "random_get") (param i32 i32) (result i32)
    (unreachable))

  (func (export "proc_exit") (param i32)
    (unreachable))

  (func (export "sched_yield") (result i32)
    (i32.const 0))

  ;; Writes each iovec as one alkanes log line.
  (func (export "fd_write") (param $fd i32) (param $iovs i32) (param $count i32) (param $written i32) (result i32)
    (local $i i32)
    (local $ptr i32)
    (local $len i32)
    (local $total i32)
    (local $data i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $ptr (i32.load (i32.add (local.get $iovs) (i32.shl (local.get $i) (i32.const 3)))))
        (local.set $len (i32.load (i32.add (local.get $iovs) (i32.add (i32.shl (local.get $i) (i32.const 3)) (i32.const 4)))))
        (if (local.get $len)
          (then
            (local.set $data (call $reserve (local.get $len)))
            (memory.copy (local.get $data) (local.get $ptr) (local.get $len))
            (call $env_log (local.get $data))))
        (local.set $total (i32.add (local.get $total) (local.get $len)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (i32.store (local.get $written) (local.get $total))
    (i32.const 0))

  ;; Everything else reports ENOSYS (52).
  (func (export "fd_close") (param i32) (result i32) (i32.const 52))
  (func (export "fd_seek") (param i32 i64 i32 i32) (result i32) (i32.const 52))
  (func (export "fd_read") (param i32 i32 i32 i32) (result i32) (i32.const 52))
  (func (export "fd_fdstat_get") (param i32 i32) (result i32) (i32.const 52))
  (func (export "fd_prestat_get") (param i32 i32) (result i32) (i32.const 8))
  (func (export "fd_prestat_dir_name") (param i32 i32 i32) (result i32) (i32.const 52))
)
