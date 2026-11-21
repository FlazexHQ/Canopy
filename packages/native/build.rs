//! Sets the linker flags a Node-API addon needs on each platform. It reruns only when this file changes, so
//! Cargo never scans the `node_modules` folder beside the crate.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    napi_build::setup();
}
