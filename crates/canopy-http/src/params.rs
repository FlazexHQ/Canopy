use canopy_data::CountMode;
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, Document, Value};

/// Query parameters with a meaning of their own; every other parameter is a shorthand filter.
const RESERVED_PARAMS: [&str; 9] =
    ["filter", "sort", "fields", "limit", "after", "skip", "count", "where", "upsert"];

const MAX_PARAM_LENGTH: usize = 64 * 1024;

fn fail<T>(message: impl Into<String>) -> Result<T, CanopyError> {
    Err(CanopyError::invalid_query(message))
}

/// Limits on paging parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageLimits {
    /// The largest `limit`.
    pub max_limit: u32,
    /// The largest `skip`.
    pub max_skip: u64,
}

/// The parts of a find request as the query parameters or a `_query` body gave them, before validation against
/// policies.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FindParams {
    /// The caller's filter: the `filter` parameter combined with the shorthand filters.
    pub filter: Document,
    /// The sort: a document, or from a body any value, which the query parser then refuses.
    pub sort: Option<Value>,
    /// The projection: a document, or from a body any value, which the query parser then refuses.
    pub fields: Option<Value>,
    /// The page size.
    pub limit: Option<u32>,
    /// The number of documents to skip.
    pub skip: Option<u64>,
    /// The cursor of the previous page.
    pub after: Option<String>,
    /// The count mode.
    pub count: Option<CountMode>,
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Parses EJSON text from a parameter into a value.
fn parse_ejson_param(name: &str, text: &str) -> Result<Value, CanopyError> {
    if utf16_len(text) > MAX_PARAM_LENGTH {
        return fail(format!("{name} is too long"));
    }
    parse(text, DecodeOptions::default()).or_else(|_| fail(format!("{name} must be valid Extended JSON")))
}

/// Whether text is a JSON number: `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`.
fn is_number(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |at: usize| bytes[at..].iter().take_while(|byte| byte.is_ascii_digit()).count();
    let mut at = usize::from(bytes.first() == Some(&b'-'));
    match bytes.get(at) {
        Some(b'0') => at += 1,
        Some(b'1'..=b'9') => at += digits(at),
        _ => return false,
    }
    if bytes.get(at) == Some(&b'.') {
        let count = digits(at + 1);
        if count == 0 {
            return false;
        }
        at += 1 + count;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let count = digits(at);
        if count == 0 {
            return false;
        }
        at += count;
    }
    at == bytes.len()
}

fn is_integer(text: &str) -> bool {
    !text.is_empty()
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'))
}

fn number(text: &str) -> f64 {
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// Types a shorthand value: a double quoted JSON string stays a string, `{...}` is an EJSON value such as
/// `{"$oid":"..."}`, `true`, `false` and `null` are literals, a decimal number is a number, and anything else
/// is a string. Quote a value to force a string, for example `eq."42"`.
fn typed_value(text: &str) -> Result<Value, CanopyError> {
    if text.starts_with('"') {
        return match parse_json(text) {
            Ok(Json::String(value)) => Ok(Value::String(value)),
            _ => fail(format!("Malformed quoted value: {text}")),
        };
    }
    if text.starts_with('{') {
        let value = parse_ejson_param("A shorthand value", text)?;
        if matches!(value, Value::Document(_)) {
            return fail("A shorthand value must be a single EJSON value such as {\"$oid\":\u{2026}}");
        }
        return Ok(value);
    }
    Ok(match text {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" => Value::Null,
        _ if is_number(text) => Value::from_js_number(number(text)),
        _ => Value::String(text.to_owned()),
    })
}

/// Splits `(a,"b,c",{"$oid":"..."})` into its items, honoring quotes and braces.
fn split_list(text: &str) -> Result<Vec<&str>, CanopyError> {
    if !text.starts_with('(') || !text.ends_with(')') || text.len() < 2 {
        return fail("A list must be written as (a,b,c)");
    }
    let inner = &text[1..text.len() - 1];
    if inner.is_empty() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    let mut depth = 0i64;
    let mut quoted = false;
    let mut start = 0;
    let mut chars = inner.char_indices();
    while let Some((index, char)) = chars.next() {
        if quoted {
            if char == '\\' {
                chars.next();
            } else if char == '"' {
                quoted = false;
            }
            continue;
        }
        match char {
            '"' => quoted = true,
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                items.push(&inner[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    if quoted || depth != 0 {
        return fail("Unbalanced quotes or braces in a list");
    }
    items.push(&inner[start..]);
    Ok(items)
}

fn regex_operand(text: &str) -> Document {
    let literal = text
        .strip_prefix('/')
        .and_then(|rest| rest.rfind('/').map(|slash| (&rest[..slash], &rest[slash + 1..])))
        .filter(|(_, options)| options.bytes().all(|byte| byte.is_ascii_lowercase()));
    let mut operand = Document::new();
    match literal {
        None => operand.insert("$regex", Value::String(text.to_owned())),
        Some((pattern, options)) => {
            operand.insert("$regex", Value::String(pattern.to_owned()));
            if !options.is_empty() {
                operand.insert("$options", Value::String(options.to_owned()));
            }
        }
    }
    operand
}

fn operator_of(name: &str) -> Option<&'static str> {
    Some(match name {
        "eq" => "$eq",
        "ne" => "$ne",
        "gt" => "$gt",
        "gte" => "$gte",
        "lt" => "$lt",
        "lte" => "$lte",
        "in" => "$in",
        "nin" => "$nin",
        "exists" => "$exists",
        "regex" => "$regex",
        "size" => "$size",
        _ => return None,
    })
}

/// Converts one shorthand parameter such as `priority=gte.2` into operator and operand.
fn shorthand_condition(path: &str, raw: &str) -> Result<Document, CanopyError> {
    let Some((name, text)) = raw.split_once('.') else {
        return fail(format!("The filter {path}={raw} needs an operator, for example {path}=eq.{raw}"));
    };
    let Some(operator) = operator_of(name) else {
        return fail(format!("Unknown shorthand operator {name} for {path}"));
    };
    let mut condition = Document::new();
    match name {
        "in" | "nin" => {
            let items = split_list(text)?.into_iter().map(typed_value).collect::<Result<Vec<_>, _>>()?;
            condition.insert(operator, Value::Array(items));
        }
        "exists" => {
            if text != "true" && text != "false" {
                return fail("exists takes true or false");
            }
            condition.insert("$exists", Value::Bool(text == "true"));
        }
        "regex" => condition = regex_operand(text),
        "size" => {
            if !is_integer(text) {
                return fail("size takes a non negative integer");
            }
            condition.insert("$size", Value::from_js_number(number(text)));
        }
        _ => condition.insert(operator, typed_value(text)?),
    }
    Ok(condition)
}

/// Builds the filter of the shorthand parameters. Several conditions on one path are combined.
fn shorthand_filter(params: &[(String, String)]) -> Result<Document, CanopyError> {
    let mut out = Document::new();
    for (path, raw) in params {
        if RESERVED_PARAMS.contains(&path.as_str()) {
            continue;
        }
        if path.is_empty() {
            return fail("A filter parameter needs a field name");
        }
        if utf16_len(raw) > MAX_PARAM_LENGTH {
            return fail(format!("The filter on {path} is too long"));
        }
        let condition = shorthand_condition(path, raw)?;
        if let Some(Value::Document(existing)) = out.get_mut(path) {
            for (key, value) in condition {
                if existing.contains_key(&key) {
                    return fail(format!("{path} has the operator {key} more than once"));
                }
                existing.insert(key, value);
            }
        } else {
            out.insert(path.clone(), Value::Document(condition));
        }
    }
    Ok(out)
}

/// Parses `sort=-createdAt,title`.
fn parse_sort_param(text: &str) -> Result<Document, CanopyError> {
    let mut sort = Document::new();
    for part in text.split(',') {
        let (path, direction) = part.strip_prefix('-').map_or((part, 1), |path| (path, -1));
        if path.is_empty() {
            return fail("A sort key may not be empty");
        }
        if sort.contains_key(path) {
            return fail(format!("The sort repeats {path}"));
        }
        sort.insert(path, Value::Int32(direction));
    }
    Ok(sort)
}

/// Parses `fields=title,done` (inclusion) or `fields=-notes` (exclusion).
fn parse_fields_param(text: &str) -> Result<Document, CanopyError> {
    let mut fields = Document::new();
    for part in text.split(',') {
        let (path, flag) = part.strip_prefix('-').map_or((part, 1), |path| (path, 0));
        if path.is_empty() {
            return fail("A field name may not be empty");
        }
        if fields.contains_key(path) {
            return fail(format!("fields repeats {path}"));
        }
        fields.insert(path, Value::Int32(flag));
    }
    Ok(fields)
}

fn integer_param(name: &str, text: &str, min: u64, max: u64) -> Result<u64, CanopyError> {
    if !is_integer(text) {
        return fail(format!("{name} must be an integer"));
    }
    let value = number(text);
    #[allow(clippy::cast_precision_loss)]
    if value < min as f64 || value > max as f64 {
        return fail(format!("{name} must be between {min} and {max}"));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(value as u64)
}

fn count_param(text: &str) -> Result<CountMode, CanopyError> {
    match text {
        "exact" => Ok(CountMode::Exact),
        "estimated" => Ok(CountMode::Estimated),
        _ => fail("count must be exact or estimated"),
    }
}

fn single<'a>(params: &'a [(String, String)], name: &str) -> Result<Option<&'a str>, CanopyError> {
    let mut values = params.iter().filter(|(key, _)| key == name).map(|(_, value)| value.as_str());
    let first = values.next();
    if values.next().is_some() {
        return fail(format!("{name} may only be given once"));
    }
    Ok(first)
}

/// Joins two filters with `$and`, leaving out empty ones.
fn combine_filters(a: Document, b: Document) -> Document {
    if a.is_empty() {
        return b;
    }
    if b.is_empty() {
        return a;
    }
    let mut out = Document::new();
    out.insert("$and", Value::Array(vec![Value::Document(a), Value::Document(b)]));
    out
}

/// Reads a find request from query parameters, in the order the TypeScript handler reads them, so a request
/// with several mistakes fails with the same one. `count` may also come from `Prefer: count=...`.
pub fn find_params_from_query(
    params: &[(String, String)],
    limits: PageLimits,
    prefer_count: Option<CountMode>,
) -> Result<FindParams, CanopyError> {
    let explicit = match single(params, "filter")? {
        None => Value::Document(Document::new()),
        Some(text) => parse_ejson_param("filter", text)?,
    };
    let Value::Document(explicit) = explicit else { return fail("filter must be a document") };
    let filter = combine_filters(explicit, shorthand_filter(params)?);
    let sort_text = single(params, "sort")?;
    let fields_text = single(params, "fields")?;
    let limit_text = single(params, "limit")?;
    let skip_text = single(params, "skip")?;
    let count_text = single(params, "count")?;
    let sort = sort_text.map(parse_sort_param).transpose()?.map(Value::Document);
    let fields = fields_text.map(parse_fields_param).transpose()?.map(Value::Document);
    let limit = limit_text
        .map(|text| integer_param("limit", text, 1, u64::from(limits.max_limit)))
        .transpose()?
        .and_then(|limit| u32::try_from(limit).ok());
    let skip = skip_text.map(|text| integer_param("skip", text, 0, limits.max_skip)).transpose()?;
    let after = single(params, "after")?.map(str::to_owned);
    let count = match count_text {
        None => prefer_count,
        Some(text) => Some(count_param(text)?),
    };
    Ok(FindParams { filter, sort, fields, limit, skip, after, count })
}

const QUERY_BODY_KEYS: [&str; 7] = ["filter", "sort", "fields", "limit", "skip", "after", "count"];

/// An integer of a body, as the TypeScript handler reads it: a JavaScript number that is a safe integer.
fn integer_value(name: &str, value: &Value, min: u64, max: u64) -> Result<u64, CanopyError> {
    let number = match value {
        Value::Int32(number) => f64::from(*number),
        Value::Double(number) => *number,
        _ => return fail(format!("{name} must be an integer")),
    };
    if !number.is_finite() || number.trunc() != number || number.abs() > 9_007_199_254_740_991.0 {
        return fail(format!("{name} must be an integer"));
    }
    #[allow(clippy::cast_precision_loss)]
    if number < min as f64 || number > max as f64 {
        return fail(format!("{name} must be between {min} and {max}"));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(number as u64)
}

/// Reads a find request from a decoded `_query` body, in the order the TypeScript handler reads it. `sort` and
/// `fields` may be documents (`{ "createdAt": -1 }`) or the parameter strings (`"-createdAt"`); `count` may also
/// come from `Prefer: count=...`, which the body overrides.
pub fn find_params_from_body(
    body: &Value,
    limits: PageLimits,
    prefer_count: Option<CountMode>,
) -> Result<FindParams, CanopyError> {
    let Value::Document(body) = body else { return fail("The query body must be a document") };
    if let Some(unknown) = body.keys().find(|key| !QUERY_BODY_KEYS.contains(key)) {
        return fail(format!("Unknown query field {unknown}"));
    }
    let filter = match body.get("filter") {
        None | Some(Value::Null | Value::Undefined) => Document::new(),
        Some(Value::Document(filter)) => filter.clone(),
        Some(_) => return fail("filter must be a document"),
    };
    let after = match body.get("after") {
        None => None,
        Some(Value::String(after)) => Some(after.clone()),
        Some(_) => return fail("after must be a string"),
    };
    let sort = match body.get("sort") {
        None => None,
        Some(Value::String(text)) => Some(Value::Document(parse_sort_param(text)?)),
        Some(other) => Some(other.clone()),
    };
    let fields = match body.get("fields") {
        None => None,
        Some(Value::String(text)) => Some(Value::Document(parse_fields_param(text)?)),
        Some(other) => Some(other.clone()),
    };
    let limit = body
        .get("limit")
        .map(|value| integer_value("limit", value, 1, u64::from(limits.max_limit)))
        .transpose()?
        .and_then(|limit| u32::try_from(limit).ok());
    let skip = body.get("skip").map(|value| integer_value("skip", value, 0, limits.max_skip)).transpose()?;
    let count = match body.get("count") {
        None => prefer_count,
        Some(Value::String(text)) => Some(count_param(text)?),
        Some(_) => return fail("count must be exact or estimated"),
    };
    Ok(FindParams { filter, sort, fields, limit, skip, after, count })
}

#[cfg(test)]
mod tests {
    use canopy_protocol::ejson::canonical_string;

    use super::*;

    const LIMITS: PageLimits = PageLimits { max_limit: 10, max_skip: 20 };

    fn pairs(query: &str) -> Vec<(String, String)> {
        url::form_urlencoded::parse(query.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
    }

    fn parsed(query: &str) -> FindParams {
        find_params_from_query(&pairs(query), LIMITS, None).unwrap()
    }

    fn refusal(query: &str) -> String {
        find_params_from_query(&pairs(query), LIMITS, None).unwrap_err().message().to_owned()
    }

    fn filter_text(query: &str) -> String {
        canonical_string(&Value::Document(parsed(query).filter)).unwrap()
    }

    #[test]
    fn shorthand_values_are_typed_by_their_text() {
        assert_eq!(filter_text("n=eq.42"), r#"{"n":{"$eq":{"$numberInt":"42"}}}"#);
        assert_eq!(filter_text("n=eq.4.5"), r#"{"n":{"$eq":{"$numberDouble":"4.5"}}}"#);
        assert_eq!(filter_text("n=eq.%2242%22"), r#"{"n":{"$eq":"42"}}"#);
        assert_eq!(filter_text("n=eq.true&m=ne.null"), r#"{"n":{"$eq":true},"m":{"$ne":null}}"#);
        assert_eq!(filter_text("n=eq.007"), r#"{"n":{"$eq":"007"}}"#);
        assert_eq!(filter_text("n=eq.1e3"), r#"{"n":{"$eq":{"$numberInt":"1000"}}}"#);
        assert_eq!(filter_text("n=eq.-0"), r#"{"n":{"$eq":{"$numberDouble":"-0.0"}}}"#);
        assert_eq!(
            filter_text("id=eq.%7B%22%24oid%22%3A%22000000000000000000000001%22%7D"),
            r#"{"id":{"$eq":{"$oid":"000000000000000000000001"}}}"#
        );
    }

    #[test]
    fn shorthand_lists_honor_quotes_and_braces() {
        assert_eq!(filter_text("s=in.(a,%22b%2Cc%22,3)"), r#"{"s":{"$in":["a","b,c",{"$numberInt":"3"}]}}"#);
        assert_eq!(filter_text("s=nin.()"), r#"{"s":{"$nin":[]}}"#);
        assert_eq!(refusal("s=in.a,b"), "A list must be written as (a,b,c)");
        assert_eq!(refusal("s=in.(a,%22b)"), "Unbalanced quotes or braces in a list");
        assert_eq!(refusal("s=in.(a,%7B)"), "Unbalanced quotes or braces in a list");
    }

    #[test]
    fn regex_and_size_and_exists_shorthands() {
        assert_eq!(filter_text("t=regex.%5Eab"), r#"{"t":{"$regex":"^ab"}}"#);
        assert_eq!(filter_text("t=regex./a/b/i"), r#"{"t":{"$regex":"a/b","$options":"i"}}"#);
        assert_eq!(filter_text("t=regex./ab/"), r#"{"t":{"$regex":"ab"}}"#);
        assert_eq!(filter_text("t=regex./ab/I"), r#"{"t":{"$regex":"/ab/I"}}"#);
        assert_eq!(filter_text("t=size.3"), r#"{"t":{"$size":{"$numberInt":"3"}}}"#);
        assert_eq!(refusal("t=size.-1"), "size takes a non negative integer");
        assert_eq!(filter_text("t=exists.false"), r#"{"t":{"$exists":false}}"#);
        assert_eq!(refusal("t=exists.maybe"), "exists takes true or false");
    }

    #[test]
    fn conditions_on_one_path_combine_and_repeating_an_operator_is_refused() {
        assert_eq!(
            filter_text("n=gt.1&n=lt.9"),
            r#"{"n":{"$gt":{"$numberInt":"1"},"$lt":{"$numberInt":"9"}}}"#
        );
        assert_eq!(refusal("n=gt.1&n=gt.2"), "n has the operator $gt more than once");
        assert_eq!(
            refusal("status=active"),
            "The filter status=active needs an operator, for example status=eq.active"
        );
        assert_eq!(refusal("status=like.a"), "Unknown shorthand operator like for status");
        assert_eq!(refusal("=eq.1"), "A filter parameter needs a field name");
        assert_eq!(refusal("t=eq.%22open"), "Malformed quoted value: \"open");
        assert_eq!(
            refusal("m=eq.%7B%22a%22%3A1%7D"),
            "A shorthand value must be a single EJSON value such as {\"$oid\":\u{2026}}"
        );
    }

    #[test]
    fn the_filter_parameter_combines_with_shorthands() {
        assert_eq!(
            filter_text("filter=%7B%22a%22%3A1%7D&b=eq.2"),
            r#"{"$and":[{"a":{"$numberInt":"1"}},{"b":{"$eq":{"$numberInt":"2"}}}]}"#
        );
        assert_eq!(filter_text("filter=%7B%22a%22%3A1%7D"), r#"{"a":{"$numberInt":"1"}}"#);
        assert_eq!(refusal("filter=%7Bbad"), "filter must be valid Extended JSON");
        assert_eq!(refusal("filter=%5B1%5D"), "filter must be a document");
        assert_eq!(refusal("filter=%7B%7D&filter=%7B%7D"), "filter may only be given once");
        assert_eq!(refusal(&format!("filter={}", "1".repeat(70_000))), "filter is too long");
    }

    #[test]
    fn sort_fields_and_paging_parameters() {
        let params = parsed("sort=-createdAt,title&fields=title,done&limit=3&skip=4&after=abc&count=exact");
        assert_eq!(
            canonical_string(&params.sort.unwrap()).unwrap(),
            r#"{"createdAt":{"$numberInt":"-1"},"title":{"$numberInt":"1"}}"#
        );
        assert_eq!(
            canonical_string(&params.fields.unwrap()).unwrap(),
            r#"{"title":{"$numberInt":"1"},"done":{"$numberInt":"1"}}"#
        );
        assert_eq!((params.limit, params.skip, params.after.as_deref()), (Some(3), Some(4), Some("abc")));
        assert_eq!(params.count, Some(CountMode::Exact));
        assert_eq!(refusal("sort=,a"), "A sort key may not be empty");
        assert_eq!(refusal("sort=a,-a"), "The sort repeats a");
        assert_eq!(refusal("fields=a,a"), "fields repeats a");
        assert_eq!(refusal("fields=-"), "A field name may not be empty");
        assert_eq!(refusal("sort=a&sort=b"), "sort may only be given once");
        assert_eq!(refusal("limit=0"), "limit must be between 1 and 10");
        assert_eq!(refusal("limit=11"), "limit must be between 1 and 10");
        assert_eq!(refusal("limit=1.5"), "limit must be an integer");
        assert_eq!(refusal("limit=01"), "limit must be an integer");
        assert_eq!(refusal("skip=21"), "skip must be between 0 and 20");
        assert_eq!(refusal("skip=-1"), "skip must be an integer");
        assert_eq!(refusal("count=all"), "count must be exact or estimated");
    }

    #[test]
    fn prefer_supplies_the_count_unless_the_parameter_says_otherwise() {
        let with =
            |query: &str| find_params_from_query(&pairs(query), LIMITS, Some(CountMode::Estimated)).unwrap();
        assert_eq!(with("").count, Some(CountMode::Estimated));
        assert_eq!(with("count=exact").count, Some(CountMode::Exact));
    }

    #[test]
    fn mistakes_are_reported_in_the_order_the_typescript_handler_finds_them() {
        assert_eq!(refusal("limit=0&sort=,&filter=%7Bbad"), "filter must be valid Extended JSON");
        assert_eq!(refusal("limit=0&sort=,"), "A sort key may not be empty");
        assert_eq!(refusal("limit=0&fields=a&fields=b"), "fields may only be given once");
    }
}
