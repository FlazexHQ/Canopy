# S12 prototype: Rust driver fidelity

The prototype of [S12](../../../docs/spikes/S12-rust-driver-fidelity.md). It is a standalone Cargo project (its own `[workspace]`
and `Cargo.lock`), not a member of the root Cargo workspace, and it depends on `canopy-protocol` and
`canopy-matcher` by path so the raw BSON path is the one the gateway would use.

It needs a MongoDB replica set (change streams and snapshot reads do not work on a standalone server), for
example from the repository root:

```sh
bun packages/testing/scripts/mongod.ts --version 8.0.34 --dir <scratch folder> --port 27217
```

Then, from this folder:

```sh
cargo run --release -- checks --uri "mongodb://localhost:27217/?replicaSet=rs0"
cargo run --release -- s2 --uri "mongodb://localhost:27217/?replicaSet=rs0" --runs 10000 --lanes 4 --seed 1
cargo run --release -- bench --uri "mongodb://localhost:27217/?replicaSet=rs0" --events 5000
```

- `checks` runs one focused check per capability and prints `PASS`, `FAIL` or `SKIP` with the observed values.
  The lost history check only runs against a server whose oplog is 16 MiB or smaller.
- `s2` is the randomized snapshot plus stream test (`src/s2.rs` describes what a run checks). `--fault
  operation-time` and `--fault apply-at-t` inject a deliberate bug to show that the checks catch it.
- `bench` measures the cost of reading captured change events decoded and as raw BSON, and the drain rate
  of a stream per event type.

Each command uses its own database (`s12_checks`, `s12_s2`, `s12_bench`) and drops it at the start and
on success.
