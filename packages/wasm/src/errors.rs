//! How Rust errors become JavaScript errors.

use canopy_protocol::CanopyError;
use js_sys::{Error, Reflect};
use wasm_bindgen::JsValue;

/// A JavaScript error whose `code` is the stable `CANOPY_*` code and whose message starts with the name of the
/// matching TypeScript error class and a colon, such as `UnsupportedQueryError: $where is not supported`, as
/// the Node-API port throws them.
pub(crate) fn thrown(error: &CanopyError) -> JsValue {
    let thrown = Error::new(&format!("{}: {}", error.name(), error.message()));
    let _ = Reflect::set(&thrown, &JsValue::from_str("code"), &JsValue::from_str(error.code().as_str()));
    thrown.into()
}
