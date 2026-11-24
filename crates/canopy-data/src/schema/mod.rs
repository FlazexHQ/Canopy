//! Collection schemas: the shape of the documents of a collection, read from its `$jsonSchema` validator,
//! a configured JSON Schema or inferred from sampled documents, and restricted to the fields a role may
//! access. GraphQL builds its types from them.

mod shape;

pub use shape::{Field, ObjectShape, RestrictMode, ScalarType, Shape, restrict_shape, union};

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
