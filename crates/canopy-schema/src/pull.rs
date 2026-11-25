use canopy_protocol::{CanopyError, ErrorCode};

use crate::emit::append_collection;
use crate::typescript::quote;
use crate::{CollectionSchema, EmitOptions, emit_schema_file};

/// Default number of documents to read per collection without a validator.
pub const DEFAULT_SAMPLE_SIZE: i32 = 1_000;

/// Parses the value of a pull sample limit for the database schema reader.
pub fn parse_sample_size(value: &str) -> Result<i32, CanopyError> {
    if value.is_empty() {
        return Err(CanopyError::new(ErrorCode::ConfigInvalid, "--sample needs a value"));
    }
    if !value.starts_with('0')
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && let Ok(size) = value.parse()
    {
        return Ok(size);
    }
    Err(CanopyError::new(ErrorCode::ConfigInvalid, "--sample needs a positive integer"))
}

/// The editable schema file operation to perform after loading collection shapes.
#[derive(Debug, PartialEq, Eq)]
pub enum PullUpdate {
    /// Write a new file or replace a file with force enabled.
    Write(String),
    /// Write the existing source with one new collection definition.
    Append(String),
    /// Keep the existing file and its original line endings.
    Current,
    /// Keep an edited file. The proposed output can be used to display a diff.
    Edited(String),
}

/// Prepares a pull file update from loaded schemas and optional existing source.
/// The caller selects exposed collections and loads validators or samples before calling this function.
pub fn update_schema_file(
    schemas: &[CollectionSchema],
    collection: Option<&str>,
    existing: Option<&str>,
    file: &str,
    force: bool,
    options: &EmitOptions<'_>,
) -> Result<PullUpdate, CanopyError> {
    let selected = match collection {
        Some(name) => {
            let schema = schemas.iter().find(|schema| schema.name == name).ok_or_else(|| {
                CanopyError::new(
                    ErrorCode::NotFound,
                    format!("Collection {name} does not exist in the database"),
                )
            })?;
            if let Some(source) = existing {
                if source.contains(&format!("collection({},", quote(name))) {
                    let message = if force {
                        format!("Replacing one collection is not supported; edit {name} by hand in {file}")
                    } else {
                        format!("{file} already declares {name}")
                    };
                    return Err(CanopyError::new(ErrorCode::ConfigInvalid, message));
                }
                return append_collection(source, schema).map(PullUpdate::Append).ok_or_else(|| {
                    CanopyError::new(
                        ErrorCode::ConfigInvalid,
                        "Unrecognised schema file: expected the schema builder import and export const schema = defineSchema(...)",
                    )
                });
            }
            std::slice::from_ref(schema)
        }
        None => schemas,
    };
    let generated = emit_schema_file(selected, options);
    match existing {
        Some(source) if source.replace("\r\n", "\n") == generated => Ok(PullUpdate::Current),
        Some(_) if !force => Ok(PullUpdate::Edited(generated)),
        _ => Ok(PullUpdate::Write(generated)),
    }
}
