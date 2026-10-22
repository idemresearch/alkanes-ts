//! Rust twin of contracts/counter, written against alkanes-runtime for the
//! benchmark. Behavior and storage layout match the TypeScript version.

use alkanes_runtime::runtime::AlkaneResponder;
use alkanes_runtime::storage::StoragePointer;
use alkanes_runtime::{declare_alkane, message::MessageDispatch};
#[allow(unused_imports)]
use alkanes_runtime::{
    println,
    stdio::{stdout, Write},
};
use alkanes_support::response::CallResponse;
use anyhow::{anyhow, Result};
use metashrew_support::compat::to_arraybuffer_layout;
use metashrew_support::index_pointer::KeyValuePointer;
use std::sync::Arc;

#[derive(Default)]
pub struct Counter(());

#[derive(MessageDispatch)]
enum CounterMessage {
    #[opcode(0)]
    Initialize,

    #[opcode(1)]
    #[returns(u128)]
    Increment { by: u128 },

    #[opcode(2)]
    #[returns(u128)]
    GetCount,

    #[opcode(3)]
    IncrementThenFail,

    #[opcode(4)]
    #[returns(u128)]
    GetHeight,

    #[opcode(5)]
    #[returns(u128)]
    Sum { n: u128 },

    #[opcode(6)]
    Fill { n: u128 },
}

impl Counter {
    fn reject_assets(&self) -> Result<()> {
        if !self.context()?.incoming_alkanes.0.is_empty() {
            return Err(anyhow!("contract rejects incoming assets"));
        }
        Ok(())
    }
    fn initialized(&self) -> StoragePointer {
        StoragePointer::from_keyword("/initialized")
    }

    fn count(&self) -> StoragePointer {
        StoragePointer::from_keyword("/count")
    }

    fn initialize(&self) -> Result<CallResponse> {
        self.reject_assets()?;
        let mut initialized = self.initialized();
        if initialized.get().len() != 0 {
            return Err(anyhow!("already initialized"));
        }
        initialized.set(Arc::new(vec![1]));
        self.count().set_value::<u128>(0);
        Ok(CallResponse::default())
    }

    fn increment(&self, by: u128) -> Result<CallResponse> {
        self.reject_assets()?;
        let next = self
            .count()
            .get_value::<u128>()
            .checked_add(by)
            .ok_or_else(|| anyhow!("u128 overflow"))?;
        self.count().set_value::<u128>(next);
        let mut response = CallResponse::default();
        response.data = next.to_le_bytes().to_vec();
        Ok(response)
    }

    fn get_count(&self) -> Result<CallResponse> {
        self.reject_assets()?;
        let mut response = CallResponse::default();
        response.data = self.count().get_value::<u128>().to_le_bytes().to_vec();
        Ok(response)
    }

    fn increment_then_fail(&self) -> Result<CallResponse> {
        self.reject_assets()?;
        let next = self.count().get_value::<u128>().checked_add(1).ok_or_else(|| anyhow!("u128 overflow"))?;
        self.count().set_value::<u128>(next);
        Err(anyhow!("intentional failure"))
    }

    fn get_height(&self) -> Result<CallResponse> {
        self.reject_assets()?;
        let height = self.height() as u128;
        println!("counter: block height is {}", height);
        let mut response = CallResponse::default();
        response.data = height.to_le_bytes().to_vec();
        Ok(response)
    }

    fn sum(&self, n: u128) -> Result<CallResponse> {
        self.reject_assets()?;
        let mut total: u128 = 0;
        for i in 0..n {
            let square = i.checked_mul(i).ok_or_else(|| anyhow!("u128 overflow"))?;
            total = total.checked_add(square).ok_or_else(|| anyhow!("u128 overflow"))?;
        }
        let mut response = CallResponse::default();
        response.data = total.to_le_bytes().to_vec();
        Ok(response)
    }

    fn fill(&self, n: u128) -> Result<CallResponse> {
        self.reject_assets()?;
        let slots = StoragePointer::from_keyword("/slots/");
        for i in 0..n {
            slots.select(&i.to_le_bytes().to_vec()).set_value::<u128>(i);
        }
        Ok(CallResponse::default())
    }
}

impl AlkaneResponder for Counter {}

declare_alkane! {
    impl AlkaneResponder for Counter {
        type Message = CounterMessage;
    }
}
