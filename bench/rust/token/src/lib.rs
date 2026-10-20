//! Rust twin of contracts/token, written against alkanes-runtime for the
//! benchmark. Behavior and storage layout match the TypeScript version.

use alkanes_runtime::runtime::AlkaneResponder;
use alkanes_runtime::storage::StoragePointer;
use alkanes_runtime::{declare_alkane, message::MessageDispatch};
#[allow(unused_imports)]
use alkanes_runtime::{
    println,
    stdio::{stdout, Write},
};
use alkanes_support::{
    cellpack::Cellpack,
    context::Context,
    id::AlkaneId,
    parcel::{AlkaneTransfer, AlkaneTransferParcel},
    response::CallResponse,
};
use anyhow::{anyhow, Result};
use metashrew_support::compat::to_arraybuffer_layout;
use metashrew_support::index_pointer::KeyValuePointer;
use std::sync::Arc;

const NAME: &str = "TypeScript Token";
const SYMBOL: &str = "TST";

#[derive(Default)]
pub struct Token(());

#[derive(MessageDispatch)]
enum TokenMessage {
    #[opcode(0)]
    Initialize { supply: u128 },

    #[opcode(77)]
    Mint { amount: u128 },

    #[opcode(99)]
    #[returns(String)]
    GetName,

    #[opcode(100)]
    #[returns(String)]
    GetSymbol,

    #[opcode(101)]
    #[returns(u128)]
    GetTotalSupply,

    #[opcode(200)]
    #[returns(Vec<u8>)]
    ForwardCall { block: u128, tx: u128, opcode: u128 },
}

impl Token {
    fn total_supply(&self) -> StoragePointer {
        StoragePointer::from_keyword("/totalsupply")
    }

    fn owner(&self) -> StoragePointer {
        StoragePointer::from_keyword("/owner")
    }

    fn mint_to_caller(&self, context: &Context, amount: u128) -> Result<CallResponse> {
        let supply = self
            .total_supply()
            .get_value::<u128>()
            .checked_add(amount)
            .ok_or_else(|| anyhow!("u128 overflow"))?;
        self.total_supply().set_value::<u128>(supply);
        let mut response = CallResponse::forward(&context.incoming_alkanes);
        response.alkanes.pay(AlkaneTransfer {
            id: context.myself.clone(),
            value: amount,
        });
        Ok(response)
    }

    fn initialize(&self, supply: u128) -> Result<CallResponse> {
        let context = self.context()?;
        let mut owner = self.owner();
        if owner.get().len() != 0 {
            return Err(anyhow!("already initialized"));
        }
        owner.set(Arc::new(context.caller.clone().into()));
        self.mint_to_caller(&context, supply)
    }

    fn mint(&self, amount: u128) -> Result<CallResponse> {
        let context = self.context()?;
        let caller: Vec<u8> = context.caller.clone().into();
        if self.owner().get().as_ref() != &caller {
            return Err(anyhow!("caller is not the owner"));
        }
        self.mint_to_caller(&context, amount)
    }

    fn get_name(&self) -> Result<CallResponse> {
        let context = self.context()?;
        let mut response = CallResponse::forward(&context.incoming_alkanes);
        response.data = NAME.as_bytes().to_vec();
        Ok(response)
    }

    fn get_symbol(&self) -> Result<CallResponse> {
        let context = self.context()?;
        let mut response = CallResponse::forward(&context.incoming_alkanes);
        response.data = SYMBOL.as_bytes().to_vec();
        Ok(response)
    }

    fn get_total_supply(&self) -> Result<CallResponse> {
        let context = self.context()?;
        let mut response = CallResponse::forward(&context.incoming_alkanes);
        response.data = self.total_supply().get_value::<u128>().to_le_bytes().to_vec();
        Ok(response)
    }

    fn forward_call(&self, block: u128, tx: u128, opcode: u128) -> Result<CallResponse> {
        let context = self.context()?;
        let inner = self.call(
            &Cellpack {
                target: AlkaneId { block, tx },
                inputs: vec![opcode],
            },
            &AlkaneTransferParcel::default(),
            1_000_000,
        )?;
        let mut response = CallResponse::forward(&context.incoming_alkanes);
        response.data = inner.data;
        Ok(response)
    }
}

impl AlkaneResponder for Token {}

declare_alkane! {
    impl AlkaneResponder for Token {
        type Message = TokenMessage;
    }
}
