//! A JSON Schema checker for the draft 2020-12 keywords the authoring schemas use. It stops at the first
//! failure and visits keywords in the order Ajv does (the type, then `$ref`, `const`, `enum` and the
//! applicators, then the number, string, array and object keywords), so the reported path is the one the
//! R0 recorders captured with Ajv.

use std::collections::HashMap;

use canopy_protocol::CanopyError;
use canopy_protocol::json::{Json, parse_json, write_json};
use regex::Regex;

use crate::pointer::Pointer;

/// Why a value does not match a schema: where, and the keyword's message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) path: String,
    pub(crate) message: String,
}

/// A pattern as JavaScript reads it with the `u` flag: `\w` and `\d` stay ASCII, `\s` is JavaScript's
/// whitespace, and a negative lookahead at the start becomes a second expression that must not match.
struct Pattern {
    matches: Regex,
    refuses: Option<Regex>,
}

impl Pattern {
    fn is_match(&self, text: &str) -> bool {
        self.matches.is_match(text) && !self.refuses.as_ref().is_some_and(|refuses| refuses.is_match(text))
    }
}

/// What `\s` matches in JavaScript.
const WHITESPACE: &str =
    r"\t\n\x0B\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

fn translate(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut class = false;
    let mut chars = pattern.chars();
    while let Some(char) = chars.next() {
        match char {
            '\\' => match chars.next() {
                Some('w') if class => out.push_str("0-9A-Za-z_"),
                Some('w') => out.push_str("[0-9A-Za-z_]"),
                Some('W') if !class => out.push_str("[^0-9A-Za-z_]"),
                Some('d') if class => out.push_str("0-9"),
                Some('d') => out.push_str("[0-9]"),
                Some('D') if !class => out.push_str("[^0-9]"),
                Some('s') if class => out.push_str(WHITESPACE),
                Some('s') => out.push_str(&format!("[{WHITESPACE}]")),
                Some('S') if !class => out.push_str(&format!("[^{WHITESPACE}]")),
                Some(next) => {
                    out.push('\\');
                    out.push(next);
                }
                None => out.push('\\'),
            },
            '[' if !class => {
                class = true;
                out.push(char);
            }
            ']' if class => {
                class = false;
                out.push(char);
            }
            _ => out.push(char),
        }
    }
    out
}

/// The end of a group that starts at `open`, or `None` when it is not closed.
fn group_end(pattern: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut class = false;
    let mut escaped = false;
    for (index, char) in pattern.char_indices().skip_while(|(index, _)| *index < open) {
        if escaped {
            escaped = false;
            continue;
        }
        match char {
            '\\' => escaped = true,
            '[' if !class => class = true,
            ']' if class => class = false,
            '(' if !class => depth += 1,
            ')' if !class => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn compile(pattern: &str) -> Result<Pattern, CanopyError> {
    let invalid =
        |error: regex::Error| CanopyError::invalid_query(format!("Invalid schema pattern: {error}"));
    if let Some(rest) = pattern.strip_prefix("^(?!") {
        let end = group_end(pattern, 1).ok_or_else(|| CanopyError::invalid_query("Unclosed lookahead"))?;
        let refused = &rest[..end - 4];
        let remaining = &pattern[end + 1..];
        return Ok(Pattern {
            matches: Regex::new(&format!("^{}", translate(remaining))).map_err(invalid)?,
            refuses: Some(Regex::new(&format!("^(?:{})", translate(refused))).map_err(invalid)?),
        });
    }
    Ok(Pattern { matches: Regex::new(&translate(pattern)).map_err(invalid)?, refuses: None })
}

/// A compiled authoring schema.
pub(crate) struct Schema {
    root: Json,
    patterns: HashMap<String, Pattern>,
}

fn collect_patterns(value: &Json, out: &mut Vec<String>) {
    match value {
        Json::Object(fields) => {
            for (key, item) in fields {
                if key == "pattern"
                    && let Json::String(pattern) = item
                {
                    out.push(pattern.clone());
                }
                collect_patterns(item, out);
            }
        }
        Json::Array(items) => items.iter().for_each(|item| collect_patterns(item, out)),
        _ => {}
    }
}

fn type_name(value: &Json) -> &'static str {
    match value {
        Json::Null => "null",
        Json::Bool(_) => "boolean",
        Json::Number(_) => "number",
        Json::String(_) => "string",
        Json::Array(_) => "array",
        Json::Object(_) => "object",
    }
}

fn has_type(value: &Json, name: &str) -> bool {
    match name {
        "integer" => matches!(value, Json::Number(number) if number.is_finite() && number.fract() == 0.0),
        "number" => matches!(value, Json::Number(_)),
        other => type_name(value) == other,
    }
}

/// Deep JSON equality, field order ignored, as JSON Schema compares `const`, `enum` and `uniqueItems`.
fn equal(left: &Json, right: &Json) -> bool {
    match (left, right) {
        (Json::Array(left), Json::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(left, right)| equal(left, right))
        }
        (Json::Object(left), Json::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, item)| right.iter().any(|(other, value)| other == key && equal(item, value)))
        }
        (Json::Number(left), Json::Number(right)) => left == right,
        _ => left == right,
    }
}

fn text(value: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

fn number(value: Option<&Json>) -> Option<f64> {
    match value {
        Some(Json::Number(number)) => Some(*number),
        _ => None,
    }
}

impl Schema {
    /// Parses a schema and compiles its patterns.
    pub(crate) fn new(text: &str) -> Result<Schema, CanopyError> {
        let root = parse_json(text)?;
        let mut sources = Vec::new();
        collect_patterns(&root, &mut sources);
        let mut patterns = HashMap::new();
        for source in sources {
            if let std::collections::hash_map::Entry::Vacant(entry) = patterns.entry(source) {
                let pattern = compile(entry.key())?;
                entry.insert(pattern);
            }
        }
        Ok(Schema { root, patterns })
    }

    /// Checks a document against the whole schema.
    pub(crate) fn validate(&self, value: &Json) -> Result<(), Failure> {
        self.check(&self.root, value, &mut Pointer::default())
    }

    fn resolve(&self, reference: &str) -> Option<&Json> {
        let path = reference.strip_prefix("#/")?;
        path.split('/')
            .try_fold(&self.root, |node, segment| node.get(&segment.replace("~1", "/").replace("~0", "~")))
    }

    fn fail(path: &Pointer, message: impl Into<String>) -> Result<(), Failure> {
        Err(Failure { path: path.to_string(), message: message.into() })
    }

    fn check(&self, schema: &Json, value: &Json, path: &mut Pointer) -> Result<(), Failure> {
        let rules = match schema {
            Json::Bool(true) => return Ok(()),
            Json::Bool(false) => return Self::fail(path, "must NOT be present"),
            Json::Object(_) => schema,
            _ => return Self::fail(path, "invalid schema"),
        };
        match rules.get("type") {
            Some(Json::String(name)) if !has_type(value, name) => {
                return Self::fail(path, format!("must be {name}"));
            }
            Some(Json::Array(names))
                if !names.iter().any(|name| matches!(name, Json::String(name) if has_type(value, name))) =>
            {
                let names = names.iter().filter_map(|name| match name {
                    Json::String(name) => Some(name.as_str()),
                    _ => None,
                });
                return Self::fail(path, format!("must be {}", names.collect::<Vec<_>>().join(",")));
            }
            _ => {}
        }
        if let Some(Json::String(reference)) = rules.get("$ref") {
            let Some(target) = self.resolve(reference) else {
                return Self::fail(path, format!("can't resolve reference {reference}"));
            };
            self.check(target, value, path)?;
        }
        if let Some(constant) = rules.get("const")
            && !equal(constant, value)
        {
            return Self::fail(path, format!("must be equal to constant {}", text(constant)));
        }
        if let Some(Json::Array(options)) = rules.get("enum")
            && !options.iter().any(|option| equal(option, value))
        {
            return Self::fail(path, "must be equal to one of the allowed values");
        }
        if let Some(not) = rules.get("not")
            && self.check(not, value, path).is_ok()
        {
            return Self::fail(path, "must NOT be valid");
        }
        if let Some(Json::Array(options)) = rules.get("anyOf") {
            let mut first = None;
            let mut passed = false;
            for option in options {
                match self.check(option, value, path) {
                    Ok(()) => {
                        passed = true;
                        break;
                    }
                    Err(failure) => {
                        first.get_or_insert(failure);
                    }
                }
            }
            if !passed {
                return Err(first.unwrap_or(Failure {
                    path: path.to_string(),
                    message: "must match a schema in anyOf".to_owned(),
                }));
            }
        }
        if let Some(Json::Array(options)) = rules.get("oneOf") {
            let mut first = None;
            let mut passed = 0usize;
            for option in options {
                match self.check(option, value, path) {
                    Ok(()) => passed += 1,
                    Err(failure) => {
                        first.get_or_insert(failure);
                    }
                }
            }
            if passed == 0 {
                return Err(first.unwrap_or(Failure {
                    path: path.to_string(),
                    message: "must match exactly one schema in oneOf".to_owned(),
                }));
            }
            if passed > 1 {
                return Self::fail(path, "must match exactly one schema in oneOf");
            }
        }
        if let Some(Json::Array(all)) = rules.get("allOf") {
            for item in all {
                self.check(item, value, path)?;
            }
        }
        if let Some(condition) = rules.get("if") {
            let branch = if self.check(condition, value, path).is_ok() {
                rules.get("then")
            } else {
                rules.get("else")
            };
            if let Some(branch) = branch {
                self.check(branch, value, path)?;
            }
        }
        match value {
            Json::Number(actual) => self.check_number(rules, *actual, path),
            Json::String(actual) => self.check_string(rules, actual, path),
            Json::Array(items) => self.check_array(rules, items, path),
            Json::Object(fields) => self.check_object(rules, fields, path),
            Json::Null | Json::Bool(_) => Ok(()),
        }
    }

    fn check_number(&self, rules: &Json, actual: f64, path: &Pointer) -> Result<(), Failure> {
        if let Some(minimum) = number(rules.get("minimum"))
            && actual < minimum
        {
            return Self::fail(path, format!("must be >= {minimum}"));
        }
        if let Some(maximum) = number(rules.get("maximum"))
            && actual > maximum
        {
            return Self::fail(path, format!("must be <= {maximum}"));
        }
        Ok(())
    }

    fn check_string(&self, rules: &Json, actual: &str, path: &Pointer) -> Result<(), Failure> {
        let length = actual.chars().count() as f64;
        if let Some(minimum) = number(rules.get("minLength"))
            && length < minimum
        {
            return Self::fail(path, format!("must NOT have fewer than {minimum} characters"));
        }
        if let Some(maximum) = number(rules.get("maxLength"))
            && length > maximum
        {
            return Self::fail(path, format!("must NOT have more than {maximum} characters"));
        }
        if let Some(Json::String(source)) = rules.get("pattern")
            && !self.patterns.get(source).is_some_and(|pattern| pattern.is_match(actual))
        {
            return Self::fail(path, format!("must match pattern \"{source}\""));
        }
        Ok(())
    }

    fn check_array(&self, rules: &Json, items: &[Json], path: &mut Pointer) -> Result<(), Failure> {
        let count = items.len() as f64;
        if let Some(minimum) = number(rules.get("minItems"))
            && count < minimum
        {
            return Self::fail(path, format!("must NOT have fewer than {minimum} items"));
        }
        if let Some(maximum) = number(rules.get("maxItems"))
            && count > maximum
        {
            return Self::fail(path, format!("must NOT have more than {maximum} items"));
        }
        if matches!(rules.get("uniqueItems"), Some(Json::Bool(true))) {
            for (index, item) in items.iter().enumerate() {
                if let Some(other) = items[..index].iter().position(|earlier| equal(earlier, item)) {
                    return Self::fail(
                        path,
                        format!("must NOT have duplicate items (items ## {other} and {index} are identical)"),
                    );
                }
            }
        }
        if let Some(schema) = rules.get("items") {
            for (index, item) in items.iter().enumerate() {
                path.push(&index.to_string());
                let result = self.check(schema, item, path);
                path.pop();
                result?;
            }
        }
        Ok(())
    }

    fn check_object(
        &self,
        rules: &Json,
        fields: &[(String, Json)],
        path: &mut Pointer,
    ) -> Result<(), Failure> {
        let count = fields.len() as f64;
        if let Some(maximum) = number(rules.get("maxProperties"))
            && count > maximum
        {
            return Self::fail(path, format!("must NOT have more than {maximum} properties"));
        }
        if let Some(minimum) = number(rules.get("minProperties"))
            && count < minimum
        {
            return Self::fail(path, format!("must NOT have fewer than {minimum} properties"));
        }
        if let Some(Json::Array(required)) = rules.get("required") {
            for name in required {
                if let Json::String(name) = name
                    && !fields.iter().any(|(key, _)| key == name)
                {
                    path.push(name);
                    let failure = Self::fail(path, format!("must have required property '{name}'"));
                    path.pop();
                    return failure;
                }
            }
        }
        if let Some(names) = rules.get("propertyNames") {
            for (key, _) in fields {
                if let Err(failure) = self.check(names, &Json::String(key.clone()), &mut Pointer::default()) {
                    return Self::fail(
                        path,
                        format!("property name '{key}' is invalid: {}", failure.message),
                    );
                }
            }
        }
        let properties = match rules.get("properties") {
            Some(Json::Object(properties)) => properties.as_slice(),
            _ => &[],
        };
        if let Some(additional) = rules.get("additionalProperties") {
            for (key, item) in fields {
                if properties.iter().any(|(name, _)| name == key) {
                    continue;
                }
                path.push(key);
                let result = match additional {
                    Json::Bool(false) => Self::fail(path, "must NOT have additional properties"),
                    schema => self.check(schema, item, path),
                };
                path.pop();
                result?;
            }
        }
        for (name, schema) in properties {
            if let Some((_, item)) = fields.iter().find(|(key, _)| key == name) {
                path.push(name);
                let result = self.check(schema, item, path);
                path.pop();
                result?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_word_classes_stay_ascii() {
        let pattern = compile("^[\\w-]+$").unwrap_or_else(|_| unreachable!());
        assert!(pattern.is_match("a_b-9"));
        assert!(!pattern.is_match("é"));
        let digits = compile("^\\d+[smhd]$").unwrap_or_else(|_| unreachable!());
        assert!(digits.is_match("30s"));
        assert!(!digits.is_match("٣s"));
        let visible = compile("\\S").unwrap_or_else(|_| unreachable!());
        assert!(visible.is_match(" a "));
        assert!(!visible.is_match(" \t\u{3000}\u{feff}"));
        let duration = compile("^\\s*[0-9]+\\s*$").unwrap_or_else(|_| unreachable!());
        assert!(duration.is_match("\u{a0}30 "));
        assert!(!duration.is_match("3 0"));
    }

    #[test]
    fn a_leading_negative_lookahead_refuses_its_prefix() {
        let pattern = compile("^(?!system\\.)[^$\\u0000]+$").unwrap_or_else(|_| unreachable!());
        assert!(pattern.is_match("notes"));
        assert!(pattern.is_match("systems"));
        assert!(!pattern.is_match("system.notes"));
        assert!(!pattern.is_match("a$b"));
        assert!(!pattern.is_match("a\0b"));
    }

    #[test]
    fn first_failure_follows_keyword_order() {
        let schema = Schema::new(
            r#"{"type":"object","required":["a"],"additionalProperties":false,"properties":{"a":{"type":"integer","minimum":1},"b":{"type":"string"}}}"#,
        )
        .unwrap_or_else(|_| unreachable!());
        let check = |text: &str| {
            schema.validate(&parse_json(text).unwrap_or(Json::Null)).map_err(|failure| failure.path)
        };
        assert_eq!(check(r#"{"a":1}"#), Ok(()));
        assert_eq!(check(r#"{}"#), Err("/a".to_owned()));
        assert_eq!(check(r#"{"a":1,"c~/":2}"#), Err("/c~0~1".to_owned()));
        assert_eq!(check(r#"{"a":0}"#), Err("/a".to_owned()));
        assert_eq!(check(r#"{"a":1.5}"#), Err("/a".to_owned()));
        assert_eq!(check(r#"{"a":1,"b":3}"#), Err("/b".to_owned()));
        assert_eq!(check(r#"[]"#), Err(String::new()));
    }
}
