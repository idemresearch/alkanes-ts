//! Standalone native Wasm lower bound, without alkanes-runtime or an allocator.
//! black_box prevents LLVM from replacing arithmetic loops with closed forms
//! or eliminating the encoding roundtrip. Its cost remains in the baseline.
#![no_std]

use core::hint::black_box;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// u32 length prefix followed by a valid empty ExtendedCallResponse.
static EMPTY: [u8; 24] = [
    20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

#[no_mangle]
pub extern "C" fn __execute() -> *const u8 {
    unsafe { EMPTY.as_ptr().add(4) }
}

#[no_mangle]
pub extern "C" fn __bench_init() {}

#[no_mangle]
pub extern "C" fn contract_probe_noop(n: u32) -> f64 {
    n as f64
}

#[no_mangle]
pub extern "C" fn contract_probe_number_math(n: u32) -> f64 {
    let mut total = 0f64;
    for i in 0..n {
        let i = black_box(i) as f64;
        total += i * i;
    }
    // Inputs are limited to 10,000: the sum is exact in f64.
    (total as u64) as u32 as f64
}

#[no_mangle]
pub extern "C" fn contract_probe_bigint_math(n: u32) -> f64 {
    let mut total = 0u128;
    for i in 0..u128::from(n) {
        let i = black_box(i);
        total = total.wrapping_add(i * i);
    }
    total as u32 as f64
}

#[no_mangle]
pub extern "C" fn contract_probe_checked_math(n: u32) -> f64 {
    let mut total = 0u128;
    for i in 0..u128::from(n) {
        let i = black_box(i);
        total = total.checked_add(i * i).unwrap();
    }
    total as u32 as f64
}

#[no_mangle]
pub extern "C" fn contract_probe_encoding_control(n: u32) -> f64 {
    let mut total = 0u128;
    for i in 0..n {
        total = total.wrapping_add(black_box((1u128 << 96) + u128::from(i)));
    }
    total as u32 as f64
}

#[no_mangle]
pub extern "C" fn contract_probe_encoding_roundtrip(n: u32) -> f64 {
    let mut total = 0u128;
    for i in 0..n {
        let bytes = black_box(((1u128 << 96) + u128::from(i)).to_le_bytes());
        total = total.wrapping_add(u128::from_le_bytes(bytes));
    }
    total as u32 as f64
}
