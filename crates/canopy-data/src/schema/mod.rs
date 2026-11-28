//! Collection schemas loaded from validators, configuration or sampled documents.

mod source;

pub(crate) use canopy_schema::js_cmp;
pub use canopy_schema::{
    CollectionSchema, EnumOptions, Field, InferOptions, ObjectShape, RestrictMode, ScalarType, SchemaSource,
    Shape, from_json_schema, infer_schema, restrict_shape, union,
};
pub use source::{SchemaCache, SchemaCacheOptions, SchemaSourceOptions, load_schema};
