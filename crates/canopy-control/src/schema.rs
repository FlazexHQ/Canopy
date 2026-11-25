//! Validators of untrusted request bodies. Each refusal is a `CANOPY_VALIDATION_FAILED` error naming the
//! path of the first problem, and objects refuse unknown fields so a misspelled option is never ignored.

use canopy_protocol::json::{js_number_string, write_json_string};
use canopy_protocol::{CanopyError, ErrorCode, Value};

/// A validator of one value.
#[derive(Debug, Clone)]
pub(crate) enum Schema {
    /// A string whose UTF-16 length is within bounds, optionally checked by a predicate.
    String { min: usize, max: usize, pattern: Option<fn(&str) -> bool> },
    /// A safe integer within optional bounds.
    Integer { min: Option<i64>, max: Option<i64> },
    /// A finite number within optional bounds.
    Number { min: Option<f64>, max: Option<f64> },
    /// `true` or `false`.
    Boolean,
    /// One of a fixed set of strings.
    OneOf(&'static [&'static str]),
    /// An array of at most `max` items.
    Array(Box<Schema>, usize),
    /// Any document.
    Document,
    /// Any value.
    Unknown,
    /// A field that may be absent.
    Optional(Box<Schema>),
    /// A value that may also be `null`.
    Nullable(Box<Schema>),
    /// A document with exactly these fields.
    Object(Vec<(&'static str, Schema)>),
}

/// A string of at least `min` and at most `max` UTF-16 code units.
pub(crate) fn string(min: usize, max: usize) -> Schema {
    Schema::String { min, max, pattern: None }
}

/// An optional field.
pub(crate) fn optional(schema: Schema) -> Schema {
    Schema::Optional(Box::new(schema))
}

/// An integer within bounds.
pub(crate) fn integer(min: i64, max: i64) -> Schema {
    Schema::Integer { min: Some(min), max: Some(max) }
}

/// A validation failure at `path`, phrased as the TypeScript validators phrase it.
pub(crate) fn failure(path: &str, message: &str) -> CanopyError {
    let subject = if path.is_empty() { "The body" } else { path };
    let mut details = String::from("{\"path\":");
    write_json_string(&mut details, path);
    details.push('}');
    CanopyError::new(ErrorCode::ValidationFailed, format!("{subject} {message}")).with_details(details)
}

/// The length of a string as JavaScript counts it.
pub(crate) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The value of a number as JavaScript sees it: an int32 or a double. Every other BSON type is not a
/// JavaScript number.
pub(crate) fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Int32(number) => Some(f64::from(*number)),
        Value::Double(number) => Some(*number),
        _ => None,
    }
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[allow(clippy::cast_precision_loss)]
fn bound(number: i64) -> f64 {
    number as f64
}

impl Schema {
    /// Checks `value` (absent when `None`) at `path`.
    pub(crate) fn check(&self, value: Option<&Value>, path: &str) -> Result<(), CanopyError> {
        match self {
            Schema::Optional(inner) => match value {
                None => Ok(()),
                Some(value) => inner.check(Some(value), path),
            },
            Schema::Nullable(inner) => match value {
                Some(Value::Null) => Ok(()),
                other => inner.check(other, path),
            },
            Schema::String { min, max, pattern } => {
                let Some(Value::String(text)) = value else {
                    return Err(failure(path, "must be a string"));
                };
                let length = js_length(text);
                if length < *min {
                    return Err(failure(path, &format!("must have at least {min} characters")));
                }
                if length > *max {
                    return Err(failure(path, &format!("must have at most {max} characters")));
                }
                if pattern.is_some_and(|matches| !matches(text)) {
                    return Err(failure(path, "has an invalid format"));
                }
                Ok(())
            }
            Schema::Integer { min, max } => {
                let number = value.and_then(js_number);
                let Some(number) =
                    number.filter(|number| number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER)
                else {
                    return Err(failure(path, "must be an integer"));
                };
                if let Some(min) = min
                    && number < bound(*min)
                {
                    return Err(failure(path, &format!("must be at least {min}")));
                }
                if let Some(max) = max
                    && number > bound(*max)
                {
                    return Err(failure(path, &format!("must be at most {max}")));
                }
                Ok(())
            }
            Schema::Number { min, max } => {
                let Some(number) = value.and_then(js_number).filter(|number| number.is_finite()) else {
                    return Err(failure(path, "must be a number"));
                };
                if let Some(min) = min
                    && number < *min
                {
                    return Err(failure(path, &format!("must be at least {}", js_number_string(*min))));
                }
                if let Some(max) = max
                    && number > *max
                {
                    return Err(failure(path, &format!("must be at most {}", js_number_string(*max))));
                }
                Ok(())
            }
            Schema::Unknown => Ok(()),
            Schema::Document => match value {
                Some(Value::Document(_)) => Ok(()),
                _ => Err(failure(path, "must be an object")),
            },
            Schema::Boolean => match value {
                Some(Value::Bool(_)) => Ok(()),
                _ => Err(failure(path, "must be true or false")),
            },
            Schema::OneOf(allowed) => match value {
                Some(Value::String(text)) if allowed.contains(&text.as_str()) => Ok(()),
                _ => Err(failure(path, &format!("must be one of {}", allowed.join(", ")))),
            },
            Schema::Array(item, max) => {
                let Some(Value::Array(items)) = value else {
                    return Err(failure(path, "must be an array"));
                };
                if items.len() > *max {
                    return Err(failure(path, &format!("must have at most {max} items")));
                }
                for (index, entry) in items.iter().enumerate() {
                    item.check(Some(entry), &format!("{path}[{index}]"))?;
                }
                Ok(())
            }
            Schema::Object(shape) => {
                let Some(Value::Document(document)) = value else {
                    return Err(failure(path, "must be an object"));
                };
                let join = |key: &str| if path.is_empty() { key.to_owned() } else { format!("{path}.{key}") };
                for key in document.keys() {
                    if !shape.iter().any(|(name, _)| *name == key) {
                        return Err(failure(&join(key), "is not allowed"));
                    }
                }
                for (key, schema) in shape {
                    let field = join(key);
                    match document.get(key) {
                        None if !matches!(schema, Schema::Optional(_)) => {
                            return Err(failure(&field, "is required"));
                        }
                        None => {}
                        Some(raw) => schema.check(Some(raw), &field)?,
                    }
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_protocol::Document;

    fn doc(fields: Vec<(&str, Value)>) -> Value {
        let mut document = Document::new();
        for (key, value) in fields {
            document.insert(key, value);
        }
        Value::Document(document)
    }

    fn message(result: Result<(), CanopyError>) -> (String, Option<String>) {
        match result {
            Ok(()) => (String::new(), None),
            Err(error) => (error.message().to_owned(), error.details().map(str::to_owned)),
        }
    }

    #[test]
    fn objects_name_the_first_missing_unknown_or_invalid_field() {
        let schema = Schema::Object(vec![
            ("token", string(1, 200)),
            ("email", string(3, 320)),
            ("name", optional(string(0, 200))),
        ]);
        assert_eq!(
            message(schema.check(Some(&doc(vec![])), "")),
            ("token is required".to_owned(), Some("{\"path\":\"token\"}".to_owned()))
        );
        let unknown = doc(vec![("extra", Value::Bool(true)), ("token", Value::String("t".into()))]);
        assert_eq!(message(schema.check(Some(&unknown), "")).0, "extra is not allowed");
        let short = doc(vec![("token", Value::String("t".into())), ("email", Value::String("ab".into()))]);
        assert_eq!(message(schema.check(Some(&short), "")).0, "email must have at least 3 characters");
        assert_eq!(message(schema.check(Some(&Value::Null), "")).0, "The body must be an object");
        assert_eq!(message(schema.check(None, "body")).0, "body must be an object");
        let ok = doc(vec![("token", Value::String("t".into())), ("email", Value::String("a@b".into()))]);
        assert!(schema.check(Some(&ok), "").is_ok());
    }

    #[test]
    fn numbers_follow_javascript_types_and_bounds() {
        let rate = Schema::Number { min: Some(0.0), max: Some(1.0) };
        assert_eq!(message(rate.check(Some(&Value::Int32(2)), "rate")).0, "rate must be at most 1");
        assert!(rate.check(Some(&Value::Double(0.5)), "rate").is_ok());
        assert_eq!(message(rate.check(Some(&Value::Int64(1)), "rate")).0, "rate must be a number");
        let days = integer(1, 3650);
        assert_eq!(message(days.check(Some(&Value::Double(1.5)), "d")).0, "d must be an integer");
        assert_eq!(message(days.check(Some(&Value::Int32(0)), "d")).0, "d must be at least 1");
        assert!(days.check(Some(&Value::Double(365.0)), "d").is_ok());
    }

    #[test]
    fn lengths_count_utf16_code_units() {
        assert_eq!(js_length("😀"), 2);
        let schema = string(1, 1);
        assert_eq!(
            message(schema.check(Some(&Value::String("😀".into())), "s")).0,
            "s must have at most 1 characters"
        );
    }

    #[test]
    fn arrays_nullable_and_one_of() {
        let roles = Schema::Array(Box::new(string(1, 200)), 2);
        let three = Value::Array(vec![Value::String("a".into()); 3]);
        assert_eq!(message(roles.check(Some(&three), "roles")).0, "roles must have at most 2 items");
        let bad = Value::Array(vec![Value::String("a".into()), Value::Int32(1)]);
        assert_eq!(message(roles.check(Some(&bad), "roles")).0, "roles[1] must be a string");
        let nullable = Schema::Nullable(Box::new(integer(1, 5)));
        assert!(nullable.check(Some(&Value::Null), "n").is_ok());
        let kind = Schema::OneOf(&["cookie", "bearer"]);
        assert_eq!(
            message(kind.check(Some(&Value::String("x".into())), "t")).0,
            "t must be one of cookie, bearer"
        );
    }
}
