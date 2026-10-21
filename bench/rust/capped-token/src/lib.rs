use alkanes_runtime::{
    declare_alkane, message::MessageDispatch, runtime::AlkaneResponder, storage::StoragePointer,
};
use alkanes_support::{
    cellpack::Cellpack,
    id::AlkaneId,
    parcel::{AlkaneTransfer, AlkaneTransferParcel},
    response::CallResponse,
};
use anyhow::{anyhow, Result};
use metashrew_support::{compat::to_arraybuffer_layout, index_pointer::KeyValuePointer};
use std::sync::Arc;

#[derive(Default)]
pub struct CappedToken(());
#[derive(MessageDispatch)]
enum CappedTokenMessage {
    #[opcode(0)]
    Initialize { authority: AlkaneId, cap: u128 },
    #[opcode(77)]
    #[returns(u128)]
    Mint { amount: u128 },
    #[opcode(101)]
    #[returns(u128)]
    TotalSupply,
    #[opcode(102)]
    #[returns(AlkaneId)]
    GetAuthority,
    #[opcode(103)]
    #[returns(u128)]
    GetCap,
}
fn ptr(key: &str) -> StoragePointer {
    StoragePointer::from_keyword(key)
}
fn credit(ledger: &mut Vec<AlkaneTransfer>, transfer: AlkaneTransfer) -> Result<()> {
    if let Some(existing) = ledger.iter_mut().find(|t| t.id == transfer.id) {
        existing.value = existing
            .value
            .checked_add(transfer.value)
            .ok_or_else(|| anyhow!("u128 overflow"))?;
    } else {
        ledger.push(transfer);
    }
    Ok(())
}
impl CappedToken {
    fn begin(&self, init: bool, view: bool) -> Result<()> {
        let state = ptr("/__alkanes/init").get_value::<u128>();
        if init {
            if state != 0 {
                return Err(anyhow!("ALREADY_INITIALIZED"));
            }
            ptr("/__alkanes/init").set_value::<u128>(1);
        } else {
            if state != 2 {
                return Err(anyhow!("NOT_INITIALIZED"));
            }
            if ptr("/__alkanes/lock").get_value::<u128>() != 0 {
                return Err(anyhow!("REENTRANT_CALL"));
            }
            if !view {
                ptr("/__alkanes/lock").set_value::<u128>(1);
            }
        }
        Ok(())
    }
    fn reject_incoming(&self) -> Result<()> {
        if !self.context()?.incoming_alkanes.0.is_empty() {
            return Err(anyhow!("contract rejects incoming assets"));
        }
        Ok(())
    }
    fn initialize(&self, authority: AlkaneId, cap: u128) -> Result<CallResponse> {
        self.reject_incoming()?;
        self.begin(true, false)?;
        if cap == 0 {
            return Err(anyhow!("INVALID_CAP"));
        }
        ptr("/authority").set(Arc::new(authority.into()));
        ptr("/cap").set_value::<u128>(cap);
        ptr("/__alkanes/init").set_value::<u128>(2);
        Ok(CallResponse::default())
    }
    fn mint(&self, amount: u128) -> Result<CallResponse> {
        self.begin(false, false)?;
        let context = self.context()?;
        let authority: AlkaneId = ptr("/authority").get().as_ref().clone().try_into()?;
        let mut ledger = Vec::<AlkaneTransfer>::new();
        for transfer in context.incoming_alkanes.0 {
            credit(&mut ledger, transfer)?;
        }
        let entry = ledger
            .iter_mut()
            .find(|t| t.id == authority && t.value > 0)
            .ok_or_else(|| anyhow!("AUTH_ASSET_REQUIRED"))?;
        if authority != context.myself {
            entry.value -= 1;
            // Same protocol as AuthenticatedResponder::only_owner, retaining the
            // returned parcel so every actual auth-contract output is accounted for.
            let returned = self.call(
                &Cellpack {
                    target: authority.clone(),
                    inputs: vec![1],
                },
                &AlkaneTransferParcel(vec![AlkaneTransfer {
                    id: authority,
                    value: 1,
                }]),
                self.fuel(),
            )?;
            if returned.data != [1] {
                return Err(anyhow!("AUTH_REJECTED"));
            }
            for transfer in returned.alkanes.0 {
                credit(&mut ledger, transfer)?;
            }
        }
        if amount == 0 {
            return Err(anyhow!("INVALID_AMOUNT"));
        }
        let supply = ptr("/supply").get_value::<u128>();
        let remaining = ptr("/cap")
            .get_value::<u128>()
            .checked_sub(supply)
            .ok_or_else(|| anyhow!("u128 underflow"))?;
        if amount > remaining {
            return Err(anyhow!("CAP_EXCEEDED"));
        }
        let next = supply
            .checked_add(amount)
            .ok_or_else(|| anyhow!("u128 overflow"))?;
        ptr("/supply").set_value::<u128>(next);
        credit(
            &mut ledger,
            AlkaneTransfer {
                id: context.myself,
                value: amount,
            },
        )?;
        ptr("/__alkanes/lock").set_value::<u128>(0);
        Ok(CallResponse {
            alkanes: AlkaneTransferParcel(ledger.into_iter().filter(|t| t.value != 0).collect()),
            data: next.to_le_bytes().to_vec(),
        })
    }
    fn total_supply(&self) -> Result<CallResponse> {
        self.reject_incoming()?;
        self.begin(false, true)?;
        Ok(CallResponse {
            data: ptr("/supply").get_value::<u128>().to_le_bytes().to_vec(),
            ..CallResponse::default()
        })
    }
    fn get_authority(&self) -> Result<CallResponse> {
        self.reject_incoming()?;
        self.begin(false, true)?;
        Ok(CallResponse {
            data: ptr("/authority").get().as_ref().clone(),
            ..CallResponse::default()
        })
    }
    fn get_cap(&self) -> Result<CallResponse> {
        self.reject_incoming()?;
        self.begin(false, true)?;
        Ok(CallResponse {
            data: ptr("/cap").get_value::<u128>().to_le_bytes().to_vec(),
            ..CallResponse::default()
        })
    }
}
impl AlkaneResponder for CappedToken {}
declare_alkane! {impl AlkaneResponder for CappedToken {type Message=CappedTokenMessage;}}
