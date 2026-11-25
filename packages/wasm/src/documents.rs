//! A page of documents retained by the client core between operations.

use canopy_matcher::update::{UpdateOptions, apply_update};
use canopy_matcher::{compile_projection, compile_sort};
use canopy_port::{split_documents, value_of};
use canopy_protocol::bson::{decode_document, encode_document};
use canopy_protocol::{DocRef, Document, Value};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::errors::thrown;
use crate::filter::Filter;

/// An owned page of BSON documents. Release the handle with the generated `free()` method.
#[wasm_bindgen]
pub struct DocumentPage {
    documents: Vec<Document>,
}

#[wasm_bindgen]
impl DocumentPage {
    /// Decodes consecutive BSON documents into an owned page.
    #[wasm_bindgen(js_name = "fromBson")]
    pub fn from_bson(bytes: &[u8]) -> Result<DocumentPage, JsValue> {
        let documents = split_documents(bytes)
            .and_then(|items| items.into_iter().map(decode_document).collect())
            .map_err(|error| thrown(&error))?;
        Ok(Self { documents })
    }

    /// Returns the page as consecutive BSON documents.
    pub fn bson(&self) -> Result<Vec<u8>, JsValue> {
        let mut out = Vec::new();
        for document in &self.documents {
            out.extend(encode_document(document).map_err(|error| thrown(&error))?);
        }
        Ok(out)
    }

    /// Returns one decision byte per document, in page order.
    #[wasm_bindgen(js_name = "matchFilter")]
    pub fn match_filter(&self, filter: &Filter) -> Vec<u8> {
        self.documents.iter().map(|document| filter.decide_document(document)).collect()
    }

    /// Sorts the page using the MongoDB sort and its implicit identifier tie breaker.
    pub fn sort(&mut self, spec: &str) -> Result<(), JsValue> {
        value_of(spec)
            .and_then(|spec| compile_sort(&spec))
            .and_then(|sort| sort.sort(&mut self.documents))
            .map_err(|error| thrown(&error))
    }

    /// Projects every document in the page with the same specification.
    pub fn project(&mut self, spec: &str) -> Result<(), JsValue> {
        let projection =
            value_of(spec).and_then(|spec| compile_projection(&spec)).map_err(|error| thrown(&error))?;
        for document in &mut self.documents {
            *document = projection.apply(DocRef::Owned(document));
        }
        Ok(())
    }

    /// Applies one update to all documents. A refusal leaves the page unchanged.
    #[wasm_bindgen(js_name = "applyUpdate")]
    pub fn apply_update(
        &mut self,
        update: &str,
        array_filters: &str,
        is_insert: bool,
        now: Option<String>,
    ) -> Result<(), JsValue> {
        let update = value_of(update).map_err(|error| thrown(&error))?;
        let Value::Array(array_filters) = value_of(array_filters).map_err(|error| thrown(&error))? else {
            return Err(thrown(&canopy_protocol::CanopyError::invalid_query(
                "Array filters must be an array",
            )));
        };
        self.update(&update, array_filters, is_insert, now.as_deref())
    }

    /// Applies an update document and positional filters supplied as BSON.
    #[wasm_bindgen(js_name = "applyBsonUpdate")]
    pub fn apply_bson_update(
        &mut self,
        update: &[u8],
        array_filters: &[u8],
        is_insert: bool,
        now: Option<String>,
    ) -> Result<(), JsValue> {
        let update = Value::Document(decode_document(update).map_err(|error| thrown(&error))?);
        let array_filters = split_documents(array_filters)
            .and_then(|items| {
                items.into_iter().map(|item| decode_document(item).map(Value::Document)).collect()
            })
            .map_err(|error| thrown(&error))?;
        self.update(&update, array_filters, is_insert, now.as_deref())
    }
}

impl DocumentPage {
    fn update(
        &mut self,
        update: &Value,
        array_filters: Vec<Value>,
        is_insert: bool,
        now: Option<&str>,
    ) -> Result<(), JsValue> {
        let now = now.map(str::parse).transpose().map_err(|_| {
            thrown(&canopy_protocol::CanopyError::invalid_query(
                "The clock must be an integer in milliseconds",
            ))
        })?;
        let options = UpdateOptions { is_insert, array_filters, now };
        self.documents = self
            .documents
            .iter()
            .map(|document| apply_update(document, update, &options))
            .collect::<Result<_, _>>()
            .map_err(|error| thrown(&error))?;
        Ok(())
    }
}
