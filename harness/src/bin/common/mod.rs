//! Shared fresh-instance fuel runner for the isolation and optimization suites.
use anyhow::{anyhow, ensure, Context, Result};
use std::path::PathBuf;
use wasmi::{Caller, Engine, Extern, Instance, Linker, Memory, Module, Store};
use wasmi_check::{u128s, START_FUEL};

struct Host {
    payload: Vec<u8>,
    context: Vec<u8>,
    failed: bool,
}

fn memory(c: &Caller<'_, Host>) -> Memory {
    c.get_export("memory")
        .and_then(Extern::into_memory)
        .expect("memory export")
}

fn write_ab(c: &mut Caller<'_, Host>, ptr: i32, bytes: &[u8]) -> i32 {
    let mem = memory(c);
    mem.write(
        &mut *c,
        ptr as usize - 4,
        &(bytes.len() as u32).to_le_bytes(),
    )
    .unwrap();
    mem.write(&mut *c, ptr as usize, bytes).unwrap();
    ptr
}

fn linker(engine: &Engine) -> Result<Linker<Host>> {
    let mut l = Linker::new(engine);
    l.func_wrap("env", "__fuel", |mut c: Caller<'_, Host>, out: i32| {
        write_ab(&mut c, out, &u128::from(START_FUEL).to_le_bytes());
    })?;
    // CappedToken's startup probe links these imports but must never call them.
    for name in ["__call", "__delegatecall", "__staticcall"] {
        l.func_wrap(
            "env",
            name,
            |mut c: Caller<'_, Host>, _: i32, _: i32, _: i32, _: i64| -> i32 {
                c.data_mut().failed = true;
                -1
            },
        )?;
    }
    l.func_wrap(
        "env",
        "__returndatacopy",
        |mut c: Caller<'_, Host>, _: i32| {
            c.data_mut().failed = true;
        },
    )?;
    l.func_wrap(
        "env",
        "abort",
        |mut c: Caller<'_, Host>, _: i32, _: i32, _: i32, _: i32| {
            c.data_mut().failed = true;
        },
    )?;
    // A runtime panic must fail the sample even if the caller returns a value.
    l.func_wrap("env", "__log", |mut c: Caller<'_, Host>, _: i32| {
        c.data_mut().failed = true;
    })?;
    l.func_wrap("env", "__request_context", |c: Caller<'_, Host>| -> i32 {
        c.data().context.len() as i32
    })?;
    l.func_wrap(
        "env",
        "__load_context",
        |mut c: Caller<'_, Host>, out: i32| -> i32 {
            let bytes = c.data().context.clone();
            write_ab(&mut c, out, &bytes)
        },
    )?;
    l.func_wrap(
        "env",
        "__request_storage",
        |c: Caller<'_, Host>, _: i32| -> i32 { c.data().payload.len() as i32 },
    )?;
    l.func_wrap(
        "env",
        "__load_storage",
        |mut c: Caller<'_, Host>, _: i32, out: i32| -> i32 {
            let bytes = c.data().payload.clone();
            write_ab(&mut c, out, &bytes)
        },
    )?;
    Ok(l)
}

pub struct Fixture {
    module: Module,
    linker: Linker<Host>,
    engine: Engine,
    grow: bool,
}

impl Fixture {
    pub fn load(engine: &Engine, path: PathBuf, grow: bool) -> Result<Self> {
        let bytes = std::fs::read(&path).with_context(|| {
            format!(
                "read {}; build the corresponding benchmark fixtures first",
                path.display()
            )
        })?;
        Ok(Self {
            module: Module::new(engine, &bytes[..])?,
            linker: linker(engine)?,
            engine: engine.clone(),
            grow,
        })
    }

    fn instance(&self, payload: u32) -> Result<(Store<Host>, Instance)> {
        let host = Host {
            payload: (0..payload)
                .map(|i| (i.wrapping_mul(17).wrapping_add(3) & 255) as u8)
                .collect(),
            // Context: self, caller, vout, empty incoming parcel, opcode zero.
            context: u128s(&[2, 1, 2, 100, 0, 0, 0]),
            failed: false,
        };
        let mut store = Store::new(&self.engine, host);
        store.set_fuel(START_FUEL)?;
        let instance = self
            .linker
            .instantiate(&mut store, &self.module)?
            .ensure_no_start(&mut store)?;
        if self.grow {
            let mem = instance
                .get_memory(&store, "memory")
                .ok_or(anyhow!("no memory"))?;
            let pages = mem.size(&store);
            if pages < 512 {
                mem.grow(&mut store, 512 - pages)?;
            }
        }
        Ok((store, instance))
    }
}

#[derive(Clone, Copy)]
pub enum Call {
    Init,
    Execute,
    Probe(&'static str, u32),
}

fn call(store: &mut Store<Host>, instance: &Instance, call: Call) -> Result<u32> {
    let result = match call {
        Call::Init => {
            instance
                .get_typed_func::<(), ()>(&*store, "__bench_init")?
                .call(&mut *store, ())?;
            0
        }
        Call::Execute => {
            let ptr = instance
                .get_typed_func::<(), i32>(&*store, "__execute")?
                .call(&mut *store, ())? as usize;
            let mem = instance
                .get_memory(&*store, "memory")
                .ok_or(anyhow!("no memory"))?;
            let data = mem.data(&*store);
            let prefix = data
                .get(ptr.checked_sub(4).ok_or(anyhow!("bad response pointer"))?..ptr)
                .ok_or(anyhow!("bad response prefix"))?;
            let len = u32::from_le_bytes(prefix.try_into()?) as usize;
            ensure!(
                len == 20 && data.get(ptr..ptr + len) == Some(&[0u8; 20]),
                "nonempty or invalid no-op response"
            );
            0
        }
        Call::Probe(name, arg) => {
            let func = instance.get_typed_func::<i32, wasmi::core::F64>(
                &*store,
                &format!("contract_probe_{name}"),
            )?;
            let value: f64 = func.call(&mut *store, arg as i32)?.into();
            ensure!(
                value.is_finite()
                    && value >= 0.0
                    && value <= u32::MAX as f64
                    && value.fract() == 0.0,
                "invalid scalar {value}"
            );
            value as u32
        }
    };
    ensure!(
        !store.data().failed,
        "fixture aborted or logged a runtime diagnostic"
    );
    Ok(result)
}

pub struct Case {
    pub call: Call,
    pub warm: bool,
    pub prepare: Option<u32>,
    pub payload: u32,
    pub expected: u32,
}

impl Case {
    pub fn probe(name: &'static str, n: u32, expected: u32) -> Self {
        Self {
            call: Call::Probe(name, n),
            warm: true,
            prepare: None,
            payload: 0,
            expected,
        }
    }
}

pub fn measure(f: &Fixture, case: &Case, iterations: usize) -> Result<u64> {
    let mut first = None;
    for _ in 0..iterations {
        let (mut store, instance) = f.instance(case.payload)?;
        if case.warm {
            call(&mut store, &instance, Call::Init)?;
        }
        if let Some(n) = case.prepare {
            ensure!(
                call(&mut store, &instance, Call::Probe("prepare", n))? == n,
                "prepare failed"
            );
        }
        let before = store.get_fuel()?;
        let result = call(&mut store, &instance, case.call)?;
        let fuel = before - store.get_fuel()?;
        ensure!(
            result == case.expected,
            "expected {}, got {result}",
            case.expected
        );
        if let Some(previous) = first {
            ensure!(
                previous == fuel,
                "nondeterministic fuel: {previous} vs {fuel}"
            );
        }
        first = Some(fuel);
    }
    first.ok_or(anyhow!("iterations must be positive"))
}
