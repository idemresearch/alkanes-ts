use alkanes_runtime::{
    declare_alkane, message::MessageDispatch, runtime::AlkaneResponder, storage::StoragePointer,
};
use alkanes_support::{cellpack::Cellpack, parcel::AlkaneTransfer, response::CallResponse};
use anyhow::{anyhow, Result};
use metashrew_support::{compat::to_arraybuffer_layout, index_pointer::KeyValuePointer};
#[derive(Default)]
pub struct TestAuth(());
#[derive(MessageDispatch)]
enum TestAuthMessage {
    #[opcode(0)]
    Initialize { mode: u128 },
    #[opcode(1)]
    Authenticate,
    #[opcode(2)]
    #[returns(u128)]
    Calls,
}
impl TestAuth {
    fn initialize(&self, mode: u128) -> Result<CallResponse> {
        self.observe_initialization()?;
        StoragePointer::from_keyword("/mode").set_value::<u128>(mode);
        let mut response = CallResponse::default();
        response.alkanes.pay(AlkaneTransfer {
            id: self.context()?.myself,
            value: 1,
        });
        Ok(response)
    }
    fn authenticate(&self) -> Result<CallResponse> {
        let context = self.context()?;
        if context.incoming_alkanes.0.len() != 1
            || context.incoming_alkanes.0[0].id != context.myself
            || context.incoming_alkanes.0[0].value != 1
        {
            return Err(anyhow!("BAD_AUTH_CALL"));
        }
        let mode = StoragePointer::from_keyword("/mode").get_value::<u128>();
        let mut calls = StoragePointer::from_keyword("/calls");
        calls.set_value::<u128>(calls.get_value::<u128>() + 1);
        if mode == 2 {
            return Err(anyhow!("AUTH_FAILURE"));
        }
        if mode == 3 || mode == 4 {
            let inputs = if mode == 3 {
                vec![77, 1]
            } else {
                vec![0, context.myself.block, context.myself.tx]
            };
            let result = self.call(
                &Cellpack {
                    target: context.caller.clone(),
                    inputs,
                },
                &context.incoming_alkanes,
                self.fuel(),
            );
            let expected = if mode == 3 {
                "REENTRANT_CALL"
            } else {
                "ALREADY_INITIALIZED"
            };
            if !result
                .err()
                .map(|e| e.to_string().contains(expected))
                .unwrap_or(false)
            {
                return Err(anyhow!("REENTRANCY_NOT_BLOCKED"));
            }
        }
        let mut response = CallResponse::forward(&context.incoming_alkanes);
        response.data = vec![if mode == 1 { 0 } else { 1 }];
        Ok(response)
    }
    fn calls(&self) -> Result<CallResponse> {
        Ok(CallResponse {
            data: StoragePointer::from_keyword("/calls")
                .get_value::<u128>()
                .to_le_bytes()
                .to_vec(),
            ..CallResponse::default()
        })
    }
}
impl AlkaneResponder for TestAuth {}
declare_alkane! {impl AlkaneResponder for TestAuth {type Message=TestAuthMessage;}}
