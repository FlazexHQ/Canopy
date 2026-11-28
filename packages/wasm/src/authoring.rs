//! Validation of the canonical authoring documents that `canopy.js` builders produce.

use canopy_authoring::AuthoringError;
use js_sys::{Error, Reflect};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

/// A JavaScript `AuthoringError` whose message is `<path>: <reason>`, with the stable `code` and the RFC 6901
/// `path` of the refused value as properties.
fn refused(error: &AuthoringError) -> JsValue {
    let thrown = Error::new(&error.to_string());
    thrown.set_name("AuthoringError");
    let _ = Reflect::set(&thrown, &JsValue::from_str("code"), &JsValue::from_str(error.code().as_str()));
    let _ = Reflect::set(&thrown, &JsValue::from_str("path"), &JsValue::from_str(error.path()));
    thrown.into()
}

/// Validates a canonical policy set (JSON text) and returns its bundle version, the hash publishing stores.
#[wasm_bindgen(js_name = "validatePolicySetDocument")]
pub fn validate_policy_set_document(text: &str) -> Result<String, JsValue> {
    canopy_authoring::validate_policy_set(text)
        .map(|set| set.version().to_owned())
        .map_err(|error| refused(&error))
}

/// Validates one canonical policy test case (JSON text).
#[wasm_bindgen(js_name = "validatePolicyTestDocument")]
pub fn validate_policy_test_document(text: &str) -> Result<(), JsValue> {
    canopy_authoring::validate_policy_test(text).map_err(|error| refused(&error))
}

/// Validates a canonical unresolved config document (JSON text).
#[wasm_bindgen(js_name = "validateConfigDocument")]
pub fn validate_config_document(text: &str) -> Result<(), JsValue> {
    canopy_authoring::validate_config(text).map_err(|error| refused(&error))
}

/// Validates a canonical collection schema document (JSON text).
#[wasm_bindgen(js_name = "validateCollectionSchemaDocument")]
pub fn validate_collection_schema_document(text: &str) -> Result<(), JsValue> {
    canopy_authoring::validate_collection_schema(text).map_err(|error| refused(&error))
}

/// Validates a whole bundle (JSON text) and returns the bundle version of its policies, or `undefined` when
/// it has none.
#[wasm_bindgen(js_name = "validateBundle")]
pub fn validate_bundle(text: &str) -> Result<Option<String>, JsValue> {
    canopy_authoring::validate_bundle(text)
        .map(|bundle| bundle.policies.map(|set| set.version().to_owned()))
        .map_err(|error| refused(&error))
}
