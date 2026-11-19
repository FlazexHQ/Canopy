//! Plain JavaScript objects and arrays built and read field by field.

use js_sys::{Array, Object, Reflect};
use wasm_bindgen::JsValue;

/// Builds a plain object from its fields; a field whose value is `None` is left out.
pub(crate) fn object(fields: &[(&str, Option<JsValue>)]) -> JsValue {
    let object = Object::new();
    for (name, value) in fields {
        if let Some(value) = value {
            let _ = Reflect::set(&object, &JsValue::from_str(name), value);
        }
    }
    object.into()
}

/// An array of strings.
pub(crate) fn strings(items: &[String]) -> JsValue {
    items.iter().map(|item| JsValue::from_str(item)).collect::<Array>().into()
}

/// An array built from items.
pub(crate) fn array<T>(items: &[T], each: impl Fn(&T) -> JsValue) -> JsValue {
    items.iter().map(each).collect::<Array>().into()
}

/// A field of an object, `None` when it is missing or `undefined`.
pub(crate) fn field(object: &JsValue, name: &str) -> Option<JsValue> {
    Reflect::get(object, &JsValue::from_str(name)).ok().filter(|value| !value.is_undefined())
}
