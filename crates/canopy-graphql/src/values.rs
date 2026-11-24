//! Values crossing the GraphQL boundary: arguments and variables coerced to their input types the way
//! graphql-js and the Canopy scalars read them, and BSON values written for their output types.

use canopy_protocol::ejson::{
    DecodeOptions, base64_encode, decode, forgiving_base64_decode, is_decimal128_text, iso_string,
    js_string_to_number, parse_iso_date, write_ejson,
};
use canopy_protocol::json::{Json, js_number_string, write_json_string};
use canopy_protocol::{Binary, Document, Value, ValueRef, is_int32, object_id_hex, parse_object_id};

/// A coerced input value. Custom scalars are already BSON; enum values are what the enum value stands for.
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// `null`.
    Null,
    /// A boolean.
    Bool(bool),
    /// An `Int`.
    Int(i32),
    /// A `Float`.
    Float(f64),
    /// A `String`.
    String(String),
    /// An enum value: what it stands for, such as a document field.
    Enum(String),
    /// A list.
    List(Vec<Input>),
    /// An input object, with the fields that were given or have a default, in order.
    Object(Vec<(String, Input)>),
    /// A custom scalar, as BSON.
    Bson(Value),
}

impl Input {
    /// The field of an input object.
    pub fn get(&self, name: &str) -> Option<&Input> {
        match self {
            Input::Object(fields) => fields.iter().find(|(key, _)| key == name).map(|(_, value)| value),
            _ => None,
        }
    }

    /// Whether the value is absent or null.
    pub fn is_null(value: Option<&Input>) -> bool {
        matches!(value, None | Some(Input::Null))
    }

    /// The value as BSON, the way the JavaScript value reaches the driver: numbers become an int32 when they
    /// are one and a double otherwise.
    pub fn to_value(&self) -> Value {
        match self {
            Input::Null => Value::Null,
            Input::Bool(value) => Value::Bool(*value),
            Input::Int(value) => Value::Int32(*value),
            Input::Float(value) => Value::from_js_number(*value),
            Input::String(value) | Input::Enum(value) => Value::String(value.clone()),
            Input::List(items) => Value::Array(items.iter().map(Input::to_value).collect()),
            Input::Object(fields) => {
                let mut document = Document::with_capacity(fields.len());
                for (key, value) in fields {
                    document.insert(key, value.to_value());
                }
                Value::Document(document)
            }
            Input::Bson(value) => value.clone(),
        }
    }
}

/// A plain value for error messages: graphql-js `inspect` of the JavaScript value.
#[derive(Clone, Debug)]
pub enum Shown<'a> {
    /// A JSON value from variables.
    Json(&'a Json),
    /// A BSON value from a document.
    Bson(ValueRef<'a>),
}

fn inspect_json(out: &mut String, value: &Json, depth: usize) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Json::Number(value) => out.push_str(&js_number_string(*value)),
        Json::String(text) => write_json_string(out, text),
        Json::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
            } else if depth >= 2 {
                out.push_str("[Array]");
            } else {
                out.push('[');
                for (position, item) in items.iter().enumerate() {
                    if position > 0 {
                        out.push_str(", ");
                    }
                    inspect_json(out, item, depth + 1);
                }
                out.push(']');
            }
        }
        Json::Object(entries) => {
            if entries.is_empty() {
                out.push_str("{}");
            } else if depth >= 2 {
                out.push_str("[Object]");
            } else {
                out.push_str("{ ");
                for (position, (key, item)) in entries.iter().enumerate() {
                    if position > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(key);
                    out.push_str(": ");
                    inspect_json(out, item, depth + 1);
                }
                out.push_str(" }");
            }
        }
    }
}

/// graphql-js `inspect` of a JSON value.
pub fn inspect(value: &Json) -> String {
    let mut out = String::new();
    inspect_json(&mut out, value, 0);
    out
}

fn shown(value: &Shown<'_>) -> String {
    match value {
        Shown::Json(json) => {
            let mut out = String::new();
            canopy_protocol::json::write_json(&mut out, json);
            out
        }
        Shown::Bson(value) => {
            let mut out = String::new();
            match write_ejson(&mut out, *value, false) {
                Ok(()) => out,
                Err(_) => "it".to_owned(),
            }
        }
    }
}

fn invalid(scalar: &str, value: &Shown<'_>) -> String {
    format!("{scalar} cannot represent {}", shown(value))
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER
}

fn is_long_text(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// Reads a custom scalar from a JSON value: a variable, or a literal already turned into JSON. The error is
/// the scalar's own message.
pub fn parse_custom(scalar: &str, value: &Json) -> Result<Value, String> {
    let fail = || Err(invalid(scalar, &Shown::Json(value)));
    match scalar {
        "ObjectId" => {
            let text = match value {
                Json::String(text) => Some(text.as_str()),
                Json::Object(_) => match value.get("$oid") {
                    Some(Json::String(text)) => Some(text.as_str()),
                    _ => None,
                },
                _ => None,
            };
            match text.and_then(|text| parse_object_id(&text.to_ascii_lowercase())) {
                Some(id) => Ok(Value::ObjectId(id)),
                None => fail(),
            }
        }
        "DateTime" => {
            let ms = match value {
                Json::String(text) => parse_iso_date(text).map(|ms| ms as f64),
                Json::Number(number) => Some(*number),
                _ => None,
            };
            match ms {
                Some(ms) if ms.is_finite() && ms.abs() <= 8.64e15 =>
                {
                    #[allow(clippy::cast_possible_truncation)]
                    Ok(Value::DateTime(ms.trunc() as i64))
                }
                _ => fail(),
            }
        }
        "Long" => match value {
            Json::Number(number) if is_safe_integer(*number) =>
            {
                #[allow(clippy::cast_possible_truncation)]
                Ok(Value::Int64(*number as i64))
            }
            Json::String(text) if is_long_text(text) => {
                text.parse::<i64>().map(Value::Int64).or_else(|_| fail())
            }
            _ => fail(),
        },
        "Decimal" => {
            let text = match value {
                Json::Number(number) => Some(js_number_string(*number)),
                Json::String(text) => Some(text.clone()),
                _ => None,
            };
            match text {
                Some(text) if is_decimal128_text(&text) => Ok(Value::Decimal128(text)),
                _ => fail(),
            }
        }
        "Binary" => match value {
            Json::String(text)
                if text.len() % 4 == 0
                    && text.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'='
                    }) =>
            {
                match forgiving_base64_decode(text) {
                    Some(bytes) => Ok(Value::Binary(Box::new(Binary { subtype: 0, bytes }))),
                    None => fail(),
                }
            }
            _ => fail(),
        },
        "JSON" => decode(value, DecodeOptions::default())
            .map_err(|error| format!("JSON is not valid Extended JSON: {}", error.message())),
        _ => fail(),
    }
}

/// The message of a built in scalar that cannot read a variable value, or `None` when it can.
pub fn parse_builtin(scalar: &str, value: &Json) -> Result<Input, String> {
    let shown = || inspect(value);
    match scalar {
        "Int" => match value {
            Json::Number(number) if number.is_finite() && number.fract() == 0.0 => {
                if is_int32(*number) {
                    #[allow(clippy::cast_possible_truncation)]
                    Ok(Input::Int(*number as i32))
                } else {
                    Err(format!("Int cannot represent non 32-bit signed integer value: {}", shown()))
                }
            }
            _ => Err(format!("Int cannot represent non-integer value: {}", shown())),
        },
        "Float" => match value {
            Json::Number(number) if number.is_finite() => Ok(Input::Float(*number)),
            _ => Err(format!("Float cannot represent non numeric value: {}", shown())),
        },
        "String" => match value {
            Json::String(text) => Ok(Input::String(text.clone())),
            _ => Err(format!("String cannot represent a non string value: {}", shown())),
        },
        "Boolean" => match value {
            Json::Bool(flag) => Ok(Input::Bool(*flag)),
            _ => Err(format!("Boolean cannot represent a non boolean value: {}", shown())),
        },
        "ID" => match value {
            Json::String(text) => Ok(Input::String(text.clone())),
            Json::Number(number) if number.fract() == 0.0 => Ok(Input::String(js_number_string(*number))),
            _ => Err(format!("ID cannot represent value: {}", shown())),
        },
        _ => Err(format!("Unknown scalar {scalar}")),
    }
}

fn unwrapped_number(value: ValueRef<'_>) -> Option<f64> {
    match value {
        ValueRef::Int32(number) => Some(f64::from(number)),
        ValueRef::Double(number) => Some(number),
        _ => None,
    }
}

fn js_text(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::String(text) => {
            let mut out = String::new();
            write_json_string(&mut out, text);
            out
        }
        ValueRef::Int32(number) => number.to_string(),
        ValueRef::Double(number) => js_number_string(number),
        ValueRef::Bool(flag) => flag.to_string(),
        ValueRef::Null | ValueRef::Undefined => "null".to_owned(),
        ValueRef::ObjectId(id) => object_id_hex(&id),
        ValueRef::DateTime(ms) => iso_string(ms),
        other => {
            let mut out = String::new();
            match write_ejson(&mut out, other, false) {
                Ok(()) => out,
                Err(_) => "it".to_owned(),
            }
        }
    }
}

/// Writes a document value for a leaf output type, or the message of the field error when it cannot.
pub fn serialize(scalar: &str, value: ValueRef<'_>) -> Result<Json, String> {
    match scalar {
        "String" => match value {
            ValueRef::String(text) | ValueRef::Symbol(text) => Ok(Json::String(text.to_owned())),
            ValueRef::Bool(flag) => Ok(Json::String(flag.to_string())),
            other => match unwrapped_number(other) {
                Some(number) if number.is_finite() => Ok(Json::String(js_number_string(number))),
                _ => Err(format!("String cannot represent value: {}", js_text(other))),
            },
        },
        "Int" => {
            let number = match value {
                ValueRef::Bool(flag) => Some(if flag { 1.0 } else { 0.0 }),
                ValueRef::String(text) if !text.is_empty() => {
                    Some(js_string_to_number(text).unwrap_or(f64::NAN))
                }
                other => unwrapped_number(other),
            };
            match number {
                Some(number) if number.is_finite() && number.fract() == 0.0 => {
                    if is_int32(number) {
                        Ok(Json::Number(number))
                    } else {
                        Err(format!(
                            "Int cannot represent non 32-bit signed integer value: {}",
                            js_text(value)
                        ))
                    }
                }
                _ => Err(format!("Int cannot represent non-integer value: {}", js_text(value))),
            }
        }
        "Float" => {
            let number = match value {
                ValueRef::Bool(flag) => Some(if flag { 1.0 } else { 0.0 }),
                ValueRef::String(text) if !text.is_empty() => {
                    Some(js_string_to_number(text).unwrap_or(f64::NAN))
                }
                other => unwrapped_number(other),
            };
            match number {
                Some(number) if number.is_finite() => Ok(Json::Number(number)),
                _ => Err(format!("Float cannot represent non numeric value: {}", js_text(value))),
            }
        }
        "Boolean" => match value {
            ValueRef::Bool(flag) => Ok(Json::Bool(flag)),
            other => match unwrapped_number(other) {
                Some(number) if number.is_finite() => Ok(Json::Bool(number != 0.0)),
                _ => Err(format!("Boolean cannot represent a non boolean value: {}", js_text(other))),
            },
        },
        "ObjectId" => match value {
            ValueRef::ObjectId(id) => Ok(Json::String(object_id_hex(&id))),
            other => Err(invalid("ObjectId", &Shown::Bson(other))),
        },
        "DateTime" => match value {
            ValueRef::DateTime(ms) if ms.unsigned_abs() <= 8_640_000_000_000_000 => {
                Ok(Json::String(iso_string(ms)))
            }
            other => Err(invalid("DateTime", &Shown::Bson(other))),
        },
        "Long" => match value {
            ValueRef::Int64(number) => Ok(Json::String(number.to_string())),
            other => match unwrapped_number(other) {
                Some(number) if is_safe_integer(number) => Ok(Json::String(js_number_string(number))),
                _ => Err(invalid("Long", &Shown::Bson(other))),
            },
        },
        "Decimal" => match value {
            ValueRef::Decimal128(decimal) => Ok(Json::String(decimal.to_text())),
            other => Err(invalid("Decimal", &Shown::Bson(other))),
        },
        "Binary" => match value {
            ValueRef::Binary { bytes, .. } => Ok(Json::String(base64_encode(bytes))),
            other => Err(invalid("Binary", &Shown::Bson(other))),
        },
        "JSON" => {
            let mut text = String::new();
            write_ejson(&mut text, value, false).map_err(|error| error.message().to_owned())?;
            canopy_protocol::json::parse_json(&text).map_err(|error| error.message().to_owned())
        }
        other => Err(format!("Unknown scalar {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Json {
        canopy_protocol::json::parse_json(text).unwrap_or(Json::Null)
    }

    #[test]
    fn custom_scalars_read_their_input_forms() {
        let id = "600000000000000000000001";
        assert!(matches!(parse_custom("ObjectId", &Json::String(id.to_uppercase())), Ok(Value::ObjectId(_))));
        assert!(matches!(
            parse_custom("ObjectId", &json(r#"{"$oid":"600000000000000000000001"}"#)),
            Ok(Value::ObjectId(_))
        ));
        assert_eq!(
            parse_custom("ObjectId", &Json::Number(5.0)),
            Err("ObjectId cannot represent 5".to_owned())
        );
        assert_eq!(
            parse_custom("ObjectId", &Json::String("x".into())),
            Err("ObjectId cannot represent \"x\"".to_owned())
        );
        assert_eq!(parse_custom("DateTime", &Json::Number(86_400_000.0)), Ok(Value::DateTime(86_400_000)));
        assert_eq!(
            parse_custom("DateTime", &Json::String("2026-01-01T00:00:00.000Z".into())),
            Ok(Value::DateTime(1_767_225_600_000))
        );
        assert!(parse_custom("DateTime", &Json::Bool(true)).is_err());
        assert_eq!(
            parse_custom("Long", &Json::String("-9223372036854775808".into())),
            Ok(Value::Int64(i64::MIN))
        );
        assert!(parse_custom("Long", &Json::String("9223372036854775808".into())).is_err());
        assert!(parse_custom("Long", &Json::Number(1.5)).is_err());
        assert_eq!(
            parse_custom("Decimal", &Json::String("1.50".into())),
            Ok(Value::Decimal128("1.50".into()))
        );
        assert!(parse_custom("Decimal", &Json::String("abc".into())).is_err());
        assert!(matches!(parse_custom("Binary", &Json::String("AAEC".into())), Ok(Value::Binary(_))));
        assert!(parse_custom("Binary", &Json::String("AAE".into())).is_err());
        assert_eq!(parse_custom("JSON", &json(r#"{"$numberLong":"5"}"#)), Ok(Value::Int64(5)));
    }

    #[test]
    fn built_in_scalars_refuse_with_the_graphql_js_messages() {
        assert_eq!(parse_builtin("Int", &Json::Number(3.0)), Ok(Input::Int(3)));
        assert_eq!(
            parse_builtin("Int", &Json::String("two".into())),
            Err("Int cannot represent non-integer value: \"two\"".into())
        );
        assert_eq!(
            parse_builtin("Int", &Json::Number(3e10)),
            Err("Int cannot represent non 32-bit signed integer value: 30000000000".into())
        );
        assert_eq!(parse_builtin("Float", &Json::Number(1.5)), Ok(Input::Float(1.5)));
        assert_eq!(
            parse_builtin("String", &json(r#"{"a":[1,{"b":2}]}"#)),
            Err("String cannot represent a non string value: { a: [1, [Object]] }".into())
        );
        assert_eq!(
            parse_builtin("Boolean", &Json::Null),
            Err("Boolean cannot represent a non boolean value: null".into())
        );
    }

    #[test]
    fn leaves_are_written_like_graphql_js_and_the_canopy_scalars() {
        assert_eq!(serialize("String", ValueRef::Double(1.5)), Ok(Json::String("1.5".into())));
        assert_eq!(serialize("String", ValueRef::Bool(true)), Ok(Json::String("true".into())));
        assert_eq!(serialize("Int", ValueRef::Double(2.0)), Ok(Json::Number(2.0)));
        assert_eq!(
            serialize("Int", ValueRef::Double(2.5)),
            Err("Int cannot represent non-integer value: 2.5".into())
        );
        assert_eq!(
            serialize("Int", ValueRef::String("x")),
            Err("Int cannot represent non-integer value: \"x\"".into())
        );
        assert_eq!(serialize("Float", ValueRef::Int32(3)), Ok(Json::Number(3.0)));
        assert_eq!(serialize("Boolean", ValueRef::Int32(0)), Ok(Json::Bool(false)));
        assert_eq!(
            serialize("ObjectId", ValueRef::ObjectId([0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])),
            Ok(Json::String("600000000000000000000001".into()))
        );
        assert_eq!(
            serialize("ObjectId", ValueRef::String("x")),
            Err("ObjectId cannot represent \"x\"".into())
        );
        assert_eq!(
            serialize("DateTime", ValueRef::DateTime(0)),
            Ok(Json::String("1970-01-01T00:00:00.000Z".into()))
        );
        assert_eq!(
            serialize("Long", ValueRef::Int64(i64::MAX)),
            Ok(Json::String("9223372036854775807".into()))
        );
        assert_eq!(serialize("Long", ValueRef::Int32(7)), Ok(Json::String("7".into())));
        assert_eq!(
            serialize("Binary", ValueRef::Binary { subtype: 0, bytes: &[0, 1, 2] }),
            Ok(Json::String("AAEC".into()))
        );
        assert_eq!(serialize("JSON", ValueRef::Int64(5)), Ok(Json::Number(5.0)));
    }
}
