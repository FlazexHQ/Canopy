//! Collection schemas: the shape of the documents of a collection, read from its `$jsonSchema` validator,
//! a configured JSON Schema or inferred from sampled documents, and restricted to the fields a role may
//! access. GraphQL builds its types from them.

mod infer;
mod json_schema;
mod shape;
mod source;

pub use infer::{EnumOptions, InferOptions, infer_schema};
pub use json_schema::from_json_schema;
pub use shape::{Field, ObjectShape, RestrictMode, ScalarType, Shape, restrict_shape, union};
pub use source::{SchemaCache, SchemaCacheOptions, SchemaSourceOptions, load_schema};

pub(crate) fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn field_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn index(key: &str) -> Option<u32> {
        let index = key.parse::<u32>().ok()?;
        (index < u32::MAX && index.to_string() == key).then_some(index)
    }
    match (index(a), index(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => js_cmp(a, b),
    }
}

/// Where a collection schema comes from, in priority order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaSource {
    /// The collection's `$jsonSchema` validator.
    Validator,
    /// A JSON Schema from the configuration.
    Config,
    /// Inferred from sampled documents.
    Inferred,
}

/// The schema of one collection.
#[derive(Clone, Debug, PartialEq)]
pub struct CollectionSchema {
    /// The collection.
    pub name: String,
    /// The shape of its documents.
    pub shape: ObjectShape,
    /// Where the shape comes from.
    pub source: SchemaSource,
    /// For inferred schemas, how many documents were sampled.
    pub sampled: Option<usize>,
}
