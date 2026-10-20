//! A model of the alkanes VM host on wasmi 0.37.2, configured the way
//! alkanes-rs configures it: fuel metering on, no start function, memory grown
//! to 512 pages, and the same `env` host functions and buffer layout.
//!
//! Contracts run in a `World` holding deployed modules and per-alkane storage.
//! Every call gets a fresh instance; storage writes returned in the response
//! commit only on success, and extcalls execute the callee nested inside the
//! host function, as the indexer does. Fuel the callee burns is charged to the
//! caller. Host-function fuel surcharges and alkane balances are not modeled.

use anyhow::{anyhow, bail, Result};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};
use wasmi::*;

pub const START_FUEL: u64 = 100_000_000;
pub const REVERT: [u8; 4] = [0x08, 0xc3, 0x79, 0xa0];

pub type AlkaneId = (u128, u128);
type Storage = HashMap<Vec<u8>, Vec<u8>>;

pub fn engine() -> Engine {
    let mut config = Config::default();
    config.consume_fuel(true);
    Engine::new(&config)
}

#[derive(Clone, Default)]
pub struct WorldState {
    storage: HashMap<AlkaneId, Storage>,
}

pub struct World {
    pub engine: Engine,
    linker: Rc<Linker<Frame>>,
    modules: HashMap<AlkaneId, Module>,
    state: RefCell<WorldState>,
    pub height: u64,
    pub logs: RefCell<Vec<String>>,
    /// (instantiate + memory grow, export call) for the most recent outermost call.
    pub timing: Cell<(Duration, Duration)>,
    /// Grow memory to 512 pages after instantiation, as the indexer does.
    pub grow_memory: bool,
}

pub struct Frame {
    world: Rc<World>,
    myself: AlkaneId,
    caller: AlkaneId,
    context: Vec<u8>,
    failed: bool,
    returndata: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub alkanes: Vec<(AlkaneId, u128)>,
    pub data: Vec<u8>,
}

pub struct Outcome {
    /// Ok(response), or Err(revert message / trap).
    pub result: Result<Response, String>,
    pub fuel_used: u64,
}

pub fn u128s(values: &[u128]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn take<'a>(data: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    if data.len() < n {
        bail!("buffer truncated");
    }
    let (head, rest) = data.split_at(n);
    *data = rest;
    Ok(head)
}

fn u128_at(data: &mut &[u8]) -> Result<u128> {
    Ok(u128::from_le_bytes(take(data, 16)?.try_into()?))
}

fn u32_at(data: &mut &[u8]) -> Result<u32> {
    Ok(u32::from_le_bytes(take(data, 4)?.try_into()?))
}

fn parse_parcel(data: &mut &[u8]) -> Result<Vec<(AlkaneId, u128)>> {
    let n = u128_at(data)?;
    (0..n).map(|_| Ok(((u128_at(data)?, u128_at(data)?), u128_at(data)?))).collect()
}

fn encode_parcel(parcel: &[(AlkaneId, u128)]) -> Vec<u8> {
    let mut values = vec![parcel.len() as u128];
    for ((block, tx), value) in parcel {
        values.extend([*block, *tx, *value]);
    }
    u128s(&values)
}

fn parse_storage_map(data: &mut &[u8]) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
    let n = u32_at(data)?;
    (0..n)
        .map(|_| {
            let klen = u32_at(data)? as usize;
            let key = take(data, klen)?.to_vec();
            let vlen = u32_at(data)? as usize;
            Ok((key, take(data, vlen)?.to_vec()))
        })
        .collect()
}

fn memory(caller: &Caller<'_, Frame>) -> Memory {
    caller.get_export("memory").and_then(Extern::into_memory).expect("memory export")
}

fn read_ab(caller: &Caller<'_, Frame>, ptr: i32) -> Vec<u8> {
    let data = memory(caller).data(caller);
    let ptr = ptr as usize;
    let len = u32::from_le_bytes(data[ptr - 4..ptr].try_into().unwrap()) as usize;
    data[ptr..ptr + len].to_vec()
}

fn write_ab(caller: &mut Caller<'_, Frame>, ptr: i32, value: &[u8]) -> i32 {
    let mem = memory(caller);
    mem.write(&mut *caller, ptr as usize - 4, &(value.len() as u32).to_le_bytes()).unwrap();
    mem.write(&mut *caller, ptr as usize, value).unwrap();
    ptr
}

#[derive(Clone, Copy)]
enum Kind {
    Call,
    Static,
    Delegate,
}

fn extcall(c: &mut Caller<'_, Frame>, kind: Kind, cellpack: i32, alkanes: i32, checkpoint: i32) -> i32 {
    let world = c.data().world.clone();
    let myself = c.data().myself;
    let result = (|| -> Result<Outcome> {
        let cellpack = read_ab(c, cellpack);
        let mut cp = &cellpack[..];
        let target = (u128_at(&mut cp)?, u128_at(&mut cp)?);
        let mut inputs = Vec::new();
        while cp.len() >= 16 {
            inputs.push(u128_at(&mut cp)?);
        }
        let incoming = parse_parcel(&mut &read_ab(c, alkanes)[..])?;
        // The caller's uncommitted writes become visible to the callee.
        let pending = parse_storage_map(&mut &read_ab(c, checkpoint)[..])?;
        world.state.borrow_mut().storage.entry(myself).or_default().extend(pending);
        let fuel = c.get_fuel()?;
        let saved = world.state.borrow().clone();
        let outcome = match kind {
            Kind::Delegate => world.execute_as(target, myself, c.data().caller, &inputs, &incoming, fuel),
            _ => world.execute_as(target, target, myself, &inputs, &incoming, fuel),
        };
        if matches!(kind, Kind::Static) {
            *world.state.borrow_mut() = saved;
        }
        c.set_fuel(fuel.saturating_sub(outcome.fuel_used))?;
        Ok(outcome)
    })();
    let (returndata, ok) = match result {
        Ok(Outcome { result: Ok(r), .. }) => ([encode_parcel(&r.alkanes), r.data].concat(), true),
        Ok(Outcome { result: Err(e), .. }) => ([encode_parcel(&[]), REVERT.to_vec(), e.into_bytes()].concat(), false),
        Err(e) => ([encode_parcel(&[]), REVERT.to_vec(), e.to_string().into_bytes()].concat(), false),
    };
    let len = returndata.len() as i32;
    c.data_mut().returndata = returndata;
    if ok { len } else { -len }
}

fn linker(engine: &Engine) -> Result<Linker<Frame>> {
    let mut l = Linker::<Frame>::new(engine);
    l.func_wrap("env", "abort", |mut c: Caller<'_, Frame>, _: i32, _: i32, _: i32, _: i32| {
        c.data_mut().failed = true;
    })?;
    l.func_wrap("env", "__log", |c: Caller<'_, Frame>, v: i32| {
        let msg = String::from_utf8_lossy(&read_ab(&c, v)).to_string();
        c.data().world.logs.borrow_mut().push(msg);
    })?;
    l.func_wrap("env", "__request_storage", |c: Caller<'_, Frame>, k: i32| -> i32 {
        let key = read_ab(&c, k);
        let f = c.data();
        let state = f.world.state.borrow();
        state.storage.get(&f.myself).and_then(|s| s.get(&key)).map_or(0, |v| v.len() as i32)
    })?;
    l.func_wrap("env", "__load_storage", |mut c: Caller<'_, Frame>, k: i32, v: i32| -> i32 {
        let key = read_ab(&c, k);
        let value = {
            let f = c.data();
            let state = f.world.state.borrow();
            state.storage.get(&f.myself).and_then(|s| s.get(&key)).cloned().unwrap_or_default()
        };
        write_ab(&mut c, v, &value)
    })?;
    l.func_wrap("env", "__balance", |mut c: Caller<'_, Frame>, _: i32, _: i32, out: i32| {
        write_ab(&mut c, out, &[0u8; 16]);
    })?;
    l.func_wrap("env", "__request_context", |c: Caller<'_, Frame>| -> i32 { c.data().context.len() as i32 })?;
    l.func_wrap("env", "__load_context", |mut c: Caller<'_, Frame>, out: i32| -> i32 {
        let ctx = c.data().context.clone();
        write_ab(&mut c, out, &ctx)
    })?;
    l.func_wrap("env", "__sequence", |mut c: Caller<'_, Frame>, out: i32| {
        write_ab(&mut c, out, &0u128.to_le_bytes());
    })?;
    l.func_wrap("env", "__fuel", |mut c: Caller<'_, Frame>, out: i32| {
        let fuel = c.get_fuel().unwrap();
        write_ab(&mut c, out, &fuel.to_le_bytes());
    })?;
    l.func_wrap("env", "__height", |mut c: Caller<'_, Frame>, out: i32| {
        let height = c.data().world.height;
        write_ab(&mut c, out, &height.to_le_bytes());
    })?;
    l.func_wrap("env", "__returndatacopy", |mut c: Caller<'_, Frame>, out: i32| {
        let data = c.data().returndata.clone();
        write_ab(&mut c, out, &data);
    })?;
    l.func_wrap("env", "__request_transaction", |_: Caller<'_, Frame>| -> i32 { 0 })?;
    l.func_wrap("env", "__load_transaction", |mut c: Caller<'_, Frame>, out: i32| {
        write_ab(&mut c, out, &[]);
    })?;
    l.func_wrap("env", "__request_block", |_: Caller<'_, Frame>| -> i32 { 0 })?;
    l.func_wrap("env", "__load_block", |mut c: Caller<'_, Frame>, out: i32| {
        write_ab(&mut c, out, &[]);
    })?;
    l.func_wrap("env", "__call", |mut c: Caller<'_, Frame>, a: i32, b: i32, d: i32, _: i64| -> i32 {
        extcall(&mut c, Kind::Call, a, b, d)
    })?;
    l.func_wrap("env", "__staticcall", |mut c: Caller<'_, Frame>, a: i32, b: i32, d: i32, _: i64| -> i32 {
        extcall(&mut c, Kind::Static, a, b, d)
    })?;
    l.func_wrap("env", "__delegatecall", |mut c: Caller<'_, Frame>, a: i32, b: i32, d: i32, _: i64| -> i32 {
        extcall(&mut c, Kind::Delegate, a, b, d)
    })?;
    Ok(l)
}

impl World {
    pub fn new(engine: Engine) -> Result<Rc<World>> {
        Ok(Rc::new(World {
            linker: Rc::new(linker(&engine)?),
            engine,
            modules: HashMap::new(),
            state: RefCell::new(WorldState::default()),
            height: 900_000,
            logs: RefCell::new(Vec::new()),
            timing: Cell::new((Duration::ZERO, Duration::ZERO)),
            grow_memory: true,
        }))
    }

    pub fn deploy(self: &mut Rc<World>, id: AlkaneId, module: Module) {
        Rc::get_mut(self).expect("deploy before running calls").modules.insert(id, module);
    }

    pub fn set_grow_memory(self: &mut Rc<World>, grow: bool) {
        Rc::get_mut(self).expect("configure before running calls").grow_memory = grow;
    }

    pub fn snapshot(&self) -> WorldState {
        self.state.borrow().clone()
    }

    pub fn restore(&self, state: WorldState) {
        *self.state.borrow_mut() = state;
        self.logs.borrow_mut().clear();
    }

    fn instantiate(self: &Rc<World>, code: AlkaneId, frame: Frame, fuel: u64) -> Result<(Store<Frame>, Instance)> {
        let module = self.modules.get(&code).ok_or_else(|| anyhow!("no contract at {code:?}"))?;
        let mut store = Store::new(&self.engine, frame);
        store.set_fuel(fuel)?;
        let linker = self.linker.clone();
        let instance = linker.instantiate(&mut store, module)?.ensure_no_start(&mut store)?;
        let mem = instance.get_memory(&store, "memory").ok_or_else(|| anyhow!("no memory export"))?;
        let pages = mem.size(&store);
        if self.grow_memory && pages < 512 {
            mem.grow(&mut store, 512 - pages)?;
        }
        Ok((store, instance))
    }

    fn call_export(store: &mut Store<Frame>, instance: &Instance, export: &str) -> Result<Vec<u8>> {
        let func = instance.get_typed_func::<(), i32>(&*store, export)?;
        let ptr = func.call(&mut *store, ())? as usize;
        let mem = instance.get_memory(&*store, "memory").unwrap();
        let data = mem.data(&*store);
        let len = u32::from_le_bytes(data[ptr - 4..ptr].try_into()?) as usize;
        Ok(data[ptr..ptr + len].to_vec())
    }

    /// Runs `__execute` as `myself` with `code`'s module (they differ only for
    /// delegatecall), committing storage writes on success.
    pub fn execute_as(
        self: &Rc<World>,
        code: AlkaneId,
        myself: AlkaneId,
        caller: AlkaneId,
        inputs: &[u128],
        incoming: &[(AlkaneId, u128)],
        fuel: u64,
    ) -> Outcome {
        let mut context = u128s(&[myself.0, myself.1, caller.0, caller.1, 0]);
        context.extend(encode_parcel(incoming));
        context.extend(u128s(inputs));
        let frame = Frame { world: self.clone(), myself, caller, context, failed: false, returndata: Vec::new() };
        let saved = self.snapshot();
        let mut fuel_used = 0;
        let result = (|| -> Result<Response, String> {
            let t = Instant::now();
            let (mut store, instance) = self.instantiate(code, frame, fuel).map_err(|e| e.to_string())?;
            let instantiated = t.elapsed();
            let raw = Self::call_export(&mut store, &instance, "__execute");
            // Nested calls finish first, so the outermost call's timing wins.
            self.timing.set((instantiated, t.elapsed() - instantiated));
            fuel_used = fuel - store.get_fuel().unwrap();
            let raw = raw.map_err(|e| e.to_string())?;
            let mut r = &raw[..];
            let alkanes = parse_parcel(&mut r).map_err(|e| e.to_string())?;
            let writes = parse_storage_map(&mut r).map_err(|e| e.to_string())?;
            if store.data().failed {
                return Err(if r.starts_with(&REVERT) {
                    String::from_utf8_lossy(&r[4..]).to_string()
                } else {
                    "revert".to_string()
                });
            }
            self.state.borrow_mut().storage.entry(myself).or_default().extend(writes);
            Ok(Response { alkanes, data: r.to_vec() })
        })();
        if result.is_err() {
            self.restore(saved);
        }
        Outcome { result, fuel_used }
    }

    pub fn execute(self: &Rc<World>, target: AlkaneId, caller: AlkaneId, inputs: &[u128]) -> Outcome {
        self.execute_as(target, target, caller, inputs, &[], START_FUEL)
    }

    pub fn meta(self: &Rc<World>, target: AlkaneId) -> Outcome {
        let frame = Frame {
            world: self.clone(),
            myself: target,
            caller: (0, 0),
            context: Vec::new(),
            failed: false,
            returndata: Vec::new(),
        };
        let mut fuel_used = 0;
        let result = (|| -> Result<Response, String> {
            let t = Instant::now();
            let (mut store, instance) = self.instantiate(target, frame, START_FUEL).map_err(|e| e.to_string())?;
            let instantiated = t.elapsed();
            let raw = Self::call_export(&mut store, &instance, "__meta");
            self.timing.set((instantiated, t.elapsed() - instantiated));
            fuel_used = START_FUEL - store.get_fuel().unwrap();
            Ok(Response { alkanes: Vec::new(), data: raw.map_err(|e| e.to_string())? })
        })();
        Outcome { result, fuel_used }
    }
}
