# S11 prototype: native realtime gateway

The prototype of [S11](../S11-native-gateway.md). It is a standalone Cargo project (its own `[workspace]` and
`Cargo.lock`), not a member of the root Cargo workspace, and depends on `canopy-protocol`, `canopy-matcher`,
`canopy-query` and `canopy-policy` by path.

| Binary | What it is |
|---|---|
| `gateway` | The prototype gateway: Tokio, Hyper and `tokio-tungstenite`; one change stream read as raw BSON; the bench policies compiled by `canopy-policy`; observers shared by identical queries, indexed by a top level equality; frame bodies encoded once and shared by every receiving connection. It speaks the part of `canopy.v1` the benchmark uses. |
| `bench` | The load driver. Seeds the collection of `packages/realtime/bench/fanout.ts`, starts one server (this gateway, or `canopy-realtime` from source on Bun or Node), opens real WebSocket connections over loopback, drives writes with `packages/realtime/bench/writer.ts`, and prints one JSON line per scenario. |

It needs a MongoDB replica set. From the repository root, for example:

```sh
bun packages/testing/scripts/mongod.ts --version 8.0.34 --dir <scratch folder> --port 37017
```

Then, from this folder:

```sh
cargo build --release
./target/release/bench --uri "mongodb://127.0.0.1:37017/?replicaSet=rs0" --server rust \
  --scenarios idle:10000,owners:10000:5:1000,hot:5000:20
./target/release/bench --uri "mongodb://127.0.0.1:37017/?replicaSet=rs0" --server bun --engine ts \
  --scenarios idle:10000,owners:10000:5:1000,hot:5000:20
./target/release/bench --uri "mongodb://127.0.0.1:37017/?replicaSet=rs0" --server node --node <path to node> \
  --scenarios idle:10000,owners:10000:5:1000,hot:5000:20
```

Scenarios:

- `idle:<connections>`: connections that only say hello. Reports the server memory per connection.
- `owners:<connections>:<subs>:<writes/s>`: connection `k` signs in as `u<k>` and subscribes up to five queries
  on its own documents (all, `status` equality, two `score` ranges, and both). The writer updates random
  documents of those owners.
- `hot:<connections>:<writes/s>`: every connection is a `viewer` and subscribes `{hot: true}`, one shared query.

Other flags: `--seconds` (write phase, default 10), `--docs` (default 200000), `--owners` (default 10000),
`--port` (default 8090), `--engine ts|native|wasm` for the sidecar, `--read-buffer` for the gateway, and `--out`
to append the results to a JSON file.

The client binds its sockets to `127.0.0.2` and up, on ports 10000 to 48999, so that one Windows machine can open
50k connections without changing the dynamic port range.

What the gateway leaves out, on purpose: token signatures are not verified (it reads the claims), snapshots are
not reconciled with events that arrive while they are read (the driver writes only after every subscription is
ready), field rules are not applied (the bench policies have none), and a connection that falls behind is
dropped with `resync` instead of being buffered.
