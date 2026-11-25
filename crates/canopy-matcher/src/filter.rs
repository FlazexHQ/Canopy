//! MongoDB query filters compiled for in process evaluation.

use std::cmp::Ordering;
use std::sync::Arc;

use canopy_protocol::json::js_number_string;
use canopy_protocol::{CanopyError, DocRef, Document, RawDocument, Regex, Value, ValueRef};

use crate::compare::{Bracket, BsonType, bracket, bracket_of, bson_type, compare, compare_options};
use crate::equality::{KeySet, equality_key};
use crate::errors::{is_unsupported, unsupported_query};
use crate::numeric::{Numeric, compare_numeric, is_nan, read_numeric, to_double};
use crate::path::{Item, Outcome, Segment, present, test_path};
use crate::regex::{LinearRegex, compile_regex};

type Leaf = Arc<dyn Fn(Option<ValueRef<'_>>) -> Outcome + Send + Sync>;
type DocTest = Arc<dyn for<'a> Fn(Item<'a>) -> Outcome + Send + Sync>;

/// A filter compiled for in process evaluation.
#[derive(Clone)]
pub struct CompiledFilter {
    test: DocTest,
}

impl std::fmt::Debug for CompiledFilter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CompiledFilter")
    }
}

impl CompiledFilter {
    /// Returns true when the document matches. An error (a regular expression input too large to match in
    /// process) means the decision is unknown; callers must treat it as a refusal, never as "no match" under
    /// a negation.
    pub fn matches(&self, document: &Document) -> Outcome {
        (self.test)(Item::Document(DocRef::Owned(document)))
    }

    /// Like [`CompiledFilter::matches`] for a document in raw BSON, read in place without decoding it.
    pub fn matches_raw(&self, document: RawDocument<'_>) -> Outcome {
        (self.test)(Item::Document(DocRef::Raw(document)))
    }

    /// Like [`CompiledFilter::matches`] for a value that holds the document.
    pub fn matches_value(&self, document: &Value) -> Outcome {
        (self.test)(Item::Value(document.view()))
    }
}

const UNSUPPORTED_TOP: [&str; 6] = ["$expr", "$where", "$text", "$jsonSchema", "$comment", "$sampleRate"];
const UNSUPPORTED_FIELD: [&str; 10] = [
    "$geoWithin",
    "$geoIntersects",
    "$near",
    "$nearSphere",
    "$within",
    "$bitsAllSet",
    "$bitsAnySet",
    "$bitsAllClear",
    "$bitsAnyClear",
    "$jsonSchema",
];

fn type_alias(name: &str) -> Option<&'static [BsonType]> {
    use BsonType as T;
    Some(match name {
        "double" => &[T::Double],
        "string" => &[T::String],
        "object" => &[T::Object],
        "array" => &[T::Array],
        "binData" => &[T::BinData],
        "undefined" => &[T::Undefined],
        "objectId" => &[T::ObjectId],
        "bool" => &[T::Bool],
        "date" => &[T::Date],
        "null" => &[T::Null],
        "regex" => &[T::Regex],
        "javascript" => &[T::JavaScript],
        "symbol" => &[T::Symbol],
        "int" => &[T::Int],
        "timestamp" => &[T::Timestamp],
        "long" => &[T::Long],
        "decimal" => &[T::Decimal],
        "minKey" => &[T::MinKey],
        "maxKey" => &[T::MaxKey],
        "number" => &[T::Double, T::Int, T::Long, T::Decimal],
        _ => return None,
    })
}

fn type_code(code: f64) -> Option<BsonType> {
    use BsonType as T;
    if code.fract() != 0.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(match code as i64 {
        1 => T::Double,
        2 => T::String,
        3 => T::Object,
        4 => T::Array,
        5 => T::BinData,
        6 => T::Undefined,
        7 => T::ObjectId,
        8 => T::Bool,
        9 => T::Date,
        10 => T::Null,
        11 => T::Regex,
        13 => T::JavaScript,
        14 => T::Symbol,
        16 => T::Int,
        17 => T::Timestamp,
        18 => T::Long,
        19 => T::Decimal,
        -1 => T::MinKey,
        127 => T::MaxKey,
        _ => return None,
    })
}

fn invalid(message: impl Into<String>) -> CanopyError {
    CanopyError::invalid_query(message)
}

fn is_logical(key: &str) -> bool {
    matches!(key, "$and" | "$or" | "$nor")
}

fn is_operator_object(value: &Value) -> bool {
    value.as_document().and_then(Document::first_key).is_some_and(|key| key.starts_with('$'))
}

fn regex_of(value: &Value) -> Option<&Regex> {
    match value {
        Value::Regex(regex) => Some(regex),
        _ => None,
    }
}

/// Compiles a MongoDB query filter. Supports the matcher safe operators: comparisons, `$in` and `$nin`,
/// `$exists`, `$type`, logical operators, `$all`, `$elemMatch`, `$size`, `$mod`, `$not` and linear time
/// `$regex`. Fails with an `UnsupportedQueryError` for valid constructs the matcher does not evaluate and with
/// an `InvalidQueryError` for filters MongoDB would refuse.
pub fn compile_filter(filter: &Value) -> Result<CompiledFilter, CanopyError> {
    let Value::Document(filter) = filter else { return Err(invalid("A filter must be a document")) };
    Ok(CompiledFilter { test: compile_document(filter)? })
}

/// Returns true when every operator in `filter` can be evaluated in process. Filters MongoDB would refuse
/// are reported as errors.
pub fn is_matcher_safe(filter: &Value) -> Result<bool, CanopyError> {
    match compile_filter(filter) {
        Ok(_) => Ok(true),
        Err(error) if is_unsupported(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

fn all_of(tests: Vec<DocTest>) -> DocTest {
    match tests.len() {
        0 => Arc::new(|_| Ok(true)),
        1 => tests.into_iter().next().unwrap_or_else(|| Arc::new(|_| Ok(true))),
        _ => Arc::new(move |item| {
            for test in &tests {
                if !test(item)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }),
    }
}

fn any_of(tests: Vec<DocTest>) -> DocTest {
    Arc::new(move |item| {
        for test in &tests {
            if test(item)? {
                return Ok(true);
            }
        }
        Ok(false)
    })
}

fn negate(test: DocTest) -> DocTest {
    Arc::new(move |item| test(item).map(|matched| !matched))
}

fn negate_leaf(leaf: Leaf) -> Leaf {
    Arc::new(move |value| leaf(value).map(|matched| !matched))
}

fn expand(parts: &Arc<Vec<Segment>>, leaf: Leaf) -> DocTest {
    let parts = Arc::clone(parts);
    Arc::new(move |item| test_path(item, &parts, true, &*leaf))
}

fn reach(parts: &Arc<Vec<Segment>>, leaf: Leaf) -> DocTest {
    let parts = Arc::clone(parts);
    Arc::new(move |item| test_path(item, &parts, false, &*leaf))
}

fn string_matches(expected: &str, value: Option<ValueRef<'_>>) -> Outcome {
    Ok(matches!(value, Some(ValueRef::String(text) | ValueRef::Symbol(text)) if text == expected))
}

fn compile_equality(parts: &Arc<Vec<Segment>>, operand: &Value) -> DocTest {
    if let Value::String(expected) | Value::Symbol(expected) = operand {
        let expected = expected.clone();
        let parts = Arc::clone(parts);
        return Arc::new(move |item| {
            test_path(item, &parts, true, &|value| string_matches(&expected, value))
        });
    }
    expand(parts, eq_leaf(operand))
}

fn compile_document(filter: &Document) -> Result<DocTest, CanopyError> {
    let mut tests = Vec::with_capacity(filter.len());
    for (key, value) in filter.iter() {
        if key.starts_with('$') {
            tests.push(compile_top_operator(key, value)?);
        } else {
            if key.is_empty() {
                return Err(invalid("A field path may not be empty"));
            }
            tests.push(compile_field_condition(key, value)?);
        }
    }
    Ok(all_of(tests))
}

fn compile_top_operator(key: &str, value: &Value) -> Result<DocTest, CanopyError> {
    if is_logical(key) {
        let branches = match value {
            Value::Array(items) if !items.is_empty() => items,
            _ => return Err(invalid([key, " must be a nonempty array"].concat())),
        };
        let mut compiled = Vec::with_capacity(branches.len());
        for branch in branches {
            let Value::Document(branch) = branch else {
                return Err(invalid([key, " argument entries must be objects"].concat()));
            };
            compiled.push(compile_document(branch)?);
        }
        return Ok(match key {
            "$and" => all_of(compiled),
            "$or" => any_of(compiled),
            _ => negate(any_of(compiled)),
        });
    }
    if UNSUPPORTED_TOP.contains(&key) {
        return Err(unsupported_query([key, " is not evaluated in process"].concat()));
    }
    Err(invalid(["unknown top level operator: ", key].concat()))
}

fn compile_field_condition(path: &str, value: &Value) -> Result<DocTest, CanopyError> {
    let parts: Vec<_> = path.split('.').map(Segment::new).collect();
    if parts.iter().any(|part| part.name.is_empty()) {
        return Err(invalid(["Invalid field path: ", path].concat()));
    }
    let parts = Arc::new(parts);
    if let Some(regex) = regex_of(value) {
        return Ok(expand(&parts, regex_leaf(regex)?));
    }
    if is_operator_object(value) {
        let Value::Document(ops) = value else { return Err(invalid("expected operators")) };
        return compile_operators(&parts, ops);
    }
    Ok(compile_equality(&parts, value))
}

fn compile_operators(parts: &Arc<Vec<Segment>>, ops: &Document) -> Result<DocTest, CanopyError> {
    let has_regex = ops.contains_key("$regex");
    if ops.contains_key("$options") && !has_regex {
        return Err(invalid("$options needs a $regex"));
    }
    let mut tests = Vec::with_capacity(ops.len());
    for (key, operand) in ops.iter() {
        if !key.starts_with('$') {
            return Err(invalid(["unknown operator: ", key].concat()));
        }
        match key {
            "$options" => {}
            "$regex" => {
                let regex = regex_from_operator(operand, ops.get("$options"))?;
                tests.push(expand(parts, regex_leaf(&regex)?));
            }
            _ => tests.push(compile_operator(parts, key, operand)?),
        }
    }
    Ok(all_of(tests))
}

fn compile_operator(parts: &Arc<Vec<Segment>>, op: &str, operand: &Value) -> Result<DocTest, CanopyError> {
    Ok(match op {
        "$eq" => compile_equality(parts, operand),
        "$ne" => {
            if regex_of(operand).is_some() {
                return Err(invalid("Can't have regex as arg to $ne."));
            }
            negate(compile_equality(parts, operand))
        }
        "$gt" | "$gte" | "$lt" | "$lte" => expand(parts, comparison_leaf(op, operand)?),
        "$in" => expand(parts, in_leaf(operand, op)?),
        "$nin" => negate(expand(parts, in_leaf(operand, op)?)),
        "$exists" => {
            let exists = reach(parts, Arc::new(|value| Ok(value.is_some())));
            if truthy(operand) { exists } else { negate(exists) }
        }
        "$type" => expand(parts, type_leaf(operand)?),
        "$size" => {
            let size = size_operand(operand)?;
            reach(
                parts,
                Arc::new(move |value| {
                    Ok(matches!(value, Some(ValueRef::Array(items)) if items.len() as f64 == size))
                }),
            )
        }
        "$mod" => expand(parts, mod_leaf(operand)?),
        "$all" => compile_all(parts, operand)?,
        "$elemMatch" => compile_elem_match(parts, operand)?,
        "$not" => compile_not(parts, operand)?,
        _ if UNSUPPORTED_FIELD.contains(&op) => {
            return Err(unsupported_query([op, " is not evaluated in process"].concat()));
        }
        _ => return Err(invalid(["unknown operator: ", op].concat())),
    })
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::Null | Value::Undefined => false,
        _ => read_numeric(value.view()).is_none_or(|numeric| to_double(numeric) != 0.0),
    }
}

fn is_nullish(value: Option<ValueRef<'_>>) -> bool {
    matches!(value, None | Some(ValueRef::Null | ValueRef::Undefined))
}

fn is_nan_value(value: ValueRef<'_>) -> bool {
    read_numeric(value).is_some_and(is_nan)
}

fn eq_leaf(operand: &Value) -> Leaf {
    match operand {
        Value::Null => return Arc::new(|value| Ok(is_nullish(value))),
        Value::String(text) | Value::Symbol(text) => {
            let expected = text.clone();
            return Arc::new(move |value| string_matches(&expected, value));
        }
        _ => {}
    }
    if is_nan_value(operand.view()) {
        return Arc::new(|value| Ok(value.is_some_and(is_nan_value)));
    }
    let operand = operand.clone();
    let expected = bracket_of(&operand);
    if expected != Bracket::Number && equality_key(operand.view()).is_some() {
        return Arc::new(move |value| Ok(value.and_then(equality_key) == equality_key(operand.view())));
    }
    Arc::new(move |value| {
        Ok(value.is_some_and(|value| {
            bracket(value) == expected && compare(value, operand.view()) == Ordering::Equal
        }))
    })
}

fn comparison_leaf(op: &str, operand: &Value) -> Result<Leaf, CanopyError> {
    match op {
        "$gt" => compile_comparison::<false>(operand, Ordering::is_gt),
        "$gte" => compile_comparison::<true>(operand, Ordering::is_ge),
        "$lt" => compile_comparison::<false>(operand, Ordering::is_lt),
        _ => compile_comparison::<true>(operand, Ordering::is_le),
    }
}

fn compile_comparison<const INCLUSIVE: bool>(
    operand: &Value,
    accept: impl Fn(Ordering) -> bool + Send + Sync + 'static,
) -> Result<Leaf, CanopyError> {
    if regex_of(operand).is_some() {
        return Err(invalid("Can't have RegEx as arg to non-equality predicate"));
    }
    if matches!(operand, Value::Null) {
        return Ok(if INCLUSIVE { Arc::new(|value| Ok(is_nullish(value))) } else { Arc::new(|_| Ok(false)) });
    }
    let operand = operand.clone();
    let expected = bracket_of(&operand);
    if matches!(expected, Bracket::MinKey | Bracket::MaxKey) {
        return Ok(Arc::new(move |value| {
            Ok(accept(compare(value.unwrap_or(ValueRef::Null), operand.view())))
        }));
    }
    if expected == Bracket::Number {
        let operand_nan = is_nan_value(operand.view());
        return Ok(Arc::new(move |value| {
            let (Some(value), Some(operand)) = (value.and_then(read_numeric), read_numeric(operand.view()))
            else {
                return Ok(false);
            };
            let value_nan = is_nan(value);
            if value_nan || operand_nan {
                return Ok(INCLUSIVE && value_nan && operand_nan);
            }
            Ok(accept(compare_numeric(value, operand)))
        }));
    }
    Ok(Arc::new(move |value| {
        Ok(value.is_some_and(|value| bracket(value) == expected && accept(compare(value, operand.view()))))
    }))
}

fn in_leaf(operand: &Value, op: &str) -> Result<Leaf, CanopyError> {
    let Value::Array(items) = operand else { return Err(invalid([op, " needs an array"].concat())) };
    let mut keyed = KeySet::default();
    let mut keyed_numbers: Vec<Leaf> = Vec::new();
    let mut regexes: Vec<Leaf> = Vec::new();
    let mut others: Vec<Leaf> = Vec::new();
    let mut matches_null = false;
    for item in items {
        if is_operator_object(item) {
            return Err(invalid(["cannot nest $ under ", op].concat()));
        }
        if let Some(regex) = regex_of(item) {
            regexes.push(regex_leaf(regex)?);
            continue;
        }
        if matches!(item, Value::Null) {
            matches_null = true;
            continue;
        }
        match equality_key(item.view()) {
            None => others.push(eq_leaf(item)),
            Some(key) => {
                keyed.insert(key);
                if bracket_of(item) == Bracket::Number {
                    keyed_numbers.push(eq_leaf(item));
                }
            }
        }
    }
    Ok(Arc::new(move |value| {
        if matches_null && is_nullish(value) {
            return Ok(true);
        }
        let Some(present) = value else { return Ok(false) };
        if !keyed.is_empty() {
            match equality_key(present) {
                Some(key) => {
                    if keyed.contains(key) {
                        return Ok(true);
                    }
                }
                None if bracket(present) == Bracket::Number => {
                    for test in &keyed_numbers {
                        if test(value)? {
                            return Ok(true);
                        }
                    }
                }
                None => {}
            }
        }
        for test in others.iter().chain(regexes.iter()) {
            if test(value)? {
                return Ok(true);
            }
        }
        Ok(false)
    }))
}

fn type_leaf(operand: &Value) -> Result<Leaf, CanopyError> {
    let specs: Vec<&Value> = match operand {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    if specs.is_empty() {
        return Err(invalid("$type must match at least one type"));
    }
    let mut wanted: Vec<BsonType> = Vec::new();
    for spec in specs {
        if let Value::String(name) = spec {
            let types =
                type_alias(name).ok_or_else(|| invalid(["Unknown type name alias: ", name].concat()))?;
            wanted.extend_from_slice(types);
            continue;
        }
        let numeric = read_numeric(spec.view())
            .ok_or_else(|| invalid("type must be represented as a number or a string"))?;
        let code = to_double(numeric);

        wanted.push(
            type_code(code).ok_or_else(|| {
                invalid(["Invalid numerical type code: ", &js_number_string(code)].concat())
            })?,
        );
    }
    Ok(Arc::new(move |value| Ok(value.is_some_and(|value| wanted.contains(&bson_type(value))))))
}

fn size_operand(operand: &Value) -> Result<f64, CanopyError> {
    let numeric = read_numeric(operand.view()).ok_or_else(|| invalid("$size needs a number"))?;
    let size = to_double(numeric);
    if !size.is_finite() || size.fract() != 0.0 {
        return Err(invalid("$size must be a whole number"));
    }
    if size < 0.0 {
        return Err(invalid("$size may not be negative"));
    }
    Ok(size)
}

fn trunc_to_i64(value: f64) -> i128 {
    let truncated = value.trunc();
    if truncated <= -9_223_372_036_854_775_808.0 {
        i128::from(i64::MIN)
    } else if truncated >= 9_223_372_036_854_775_807.0 {
        i128::from(i64::MAX)
    } else {
        #[allow(clippy::cast_possible_truncation)]
        i128::from(truncated as i64)
    }
}

fn mod_leaf(operand: &Value) -> Result<Leaf, CanopyError> {
    let malformed = || invalid("malformed mod, needs to be an array of [divisor, remainder]");
    let Value::Array(items) = operand else { return Err(malformed()) };
    let [divisor, remainder] = items.as_slice() else { return Err(malformed()) };
    let (Some(divisor), Some(remainder)) = (read_numeric(divisor.view()), read_numeric(remainder.view()))
    else {
        return Err(invalid("malformed mod, divisor and remainder must be numbers"));
    };
    let (divisor, remainder) = (to_double(divisor), to_double(remainder));
    if !divisor.is_finite() || !remainder.is_finite() {
        return Err(invalid("malformed mod, divisor and remainder must be finite"));
    }
    let (divisor, remainder) = (trunc_to_i64(divisor), trunc_to_i64(remainder));
    if divisor == 0 {
        return Err(invalid("divisor cannot be 0"));
    }
    Ok(Arc::new(move |value| {
        let Some(numeric) = value.and_then(read_numeric) else { return Ok(false) };
        let dividend = match numeric {
            Numeric::Long(n) => i128::from(n),
            other => {
                let double = to_double(other);
                if !double.is_finite() {
                    return Ok(false);
                }
                trunc_to_i64(double)
            }
        };
        Ok(dividend % divisor == remainder)
    }))
}

fn regex_from_operator(pattern: &Value, options: Option<&Value>) -> Result<Regex, CanopyError> {
    let options = match options {
        None => None,
        Some(Value::String(text)) => Some(text.as_str()),
        Some(_) => return Err(invalid("$options has to be a string")),
    };
    match pattern {
        Value::String(text) => Ok(Regex::new(text.clone(), options.unwrap_or(""))),
        Value::Regex(regex) => {
            if options.is_some() && !regex.options.is_empty() {
                return Err(invalid("options set in both $regex and $options"));
            }
            Ok(Regex::new(regex.pattern.clone(), options.unwrap_or(&regex.options)))
        }
        _ => Err(invalid("$regex has to be a string")),
    }
}

fn regex_leaf(regex: &Regex) -> Result<Leaf, CanopyError> {
    let compiled: Arc<LinearRegex> = Arc::new(compile_regex(&regex.pattern, &regex.options)?);
    let expected = regex.clone();
    Ok(Arc::new(move |candidate| match candidate {
        Some(ValueRef::String(text) | ValueRef::Symbol(text)) => compiled.test(text),
        Some(ValueRef::Regex { pattern, options }) => {
            Ok(pattern == expected.pattern && compare_options(options, &expected.options) == Ordering::Equal)
        }
        _ => Ok(false),
    }))
}

fn compile_all(parts: &Arc<Vec<Segment>>, operand: &Value) -> Result<DocTest, CanopyError> {
    let Value::Array(items) = operand else { return Err(invalid("$all needs an array")) };
    if items.is_empty() {
        return Ok(Arc::new(|_| Ok(false)));
    }
    let elem_matches = items.iter().filter(|item| first_key_is(item, "$elemMatch")).count();
    if elem_matches > 0 && elem_matches != items.len() {
        return Err(invalid("$all/$elemMatch has to be consistent"));
    }
    let mut tests = Vec::with_capacity(items.len());
    for item in items {
        if elem_matches > 0 {
            let inner =
                item.as_document().and_then(|document| document.get("$elemMatch")).unwrap_or(&Value::Null);
            tests.push(compile_elem_match(parts, inner)?);
            continue;
        }
        if is_operator_object(item) {
            return Err(invalid("no $ expressions in $all"));
        }
        let leaf = match regex_of(item) {
            Some(regex) => regex_leaf(regex)?,
            None => eq_leaf(item),
        };
        tests.push(expand(parts, leaf));
    }
    Ok(all_of(tests))
}

fn first_key_is(value: &Value, key: &str) -> bool {
    value.as_document().and_then(Document::first_key) == Some(key)
}

fn is_value_operator(key: &str) -> bool {
    key.starts_with('$') && !is_logical(key) && key != "$expr"
}

fn compile_elem_match(parts: &Arc<Vec<Segment>>, operand: &Value) -> Result<DocTest, CanopyError> {
    let Value::Document(operand) = operand else { return Err(invalid("$elemMatch needs an Object")) };
    let value_form = operand.first_key().is_some_and(is_value_operator);
    let element: Leaf = if value_form {
        let mut leaves = Vec::with_capacity(operand.len());
        for (key, inner) in operand.iter() {
            match key {
                "$options" => {}
                "$regex" => leaves.push(regex_leaf(&regex_from_operator(inner, operand.get("$options"))?)?),
                _ => leaves.push(value_operator_leaf(key, inner)?),
            }
        }
        Arc::new(move |value| {
            for leaf in &leaves {
                if !leaf(value)? {
                    return Ok(false);
                }
            }
            Ok(true)
        })
    } else {
        let test = compile_document(operand)?;
        Arc::new(move |value| match value {
            Some(ValueRef::Document(document)) => test(Item::Document(document)),
            Some(ValueRef::Array(items)) => test(Item::Positions(items)),
            _ => Ok(false),
        })
    };
    Ok(reach(
        parts,
        Arc::new(move |value| {
            let Some(ValueRef::Array(items)) = value else { return Ok(false) };
            for item in items.iter() {
                if element(present(item))? {
                    return Ok(true);
                }
            }
            Ok(false)
        }),
    ))
}

fn value_operator_leaf(op: &str, operand: &Value) -> Result<Leaf, CanopyError> {
    Ok(match op {
        "$eq" => eq_leaf(operand),
        "$ne" => {
            if regex_of(operand).is_some() {
                return Err(invalid("Can't have regex as arg to $ne."));
            }
            negate_leaf(eq_leaf(operand))
        }
        "$gt" | "$gte" | "$lt" | "$lte" => comparison_leaf(op, operand)?,
        "$in" => in_leaf(operand, op)?,
        "$nin" => negate_leaf(in_leaf(operand, op)?),
        "$exists" => {
            let wanted = truthy(operand);
            Arc::new(move |value| Ok(value.is_some() == wanted))
        }
        "$type" => type_leaf(operand)?,
        "$size" => {
            let size = size_operand(operand)?;
            Arc::new(move |value| {
                Ok(matches!(value, Some(ValueRef::Array(items)) if items.len() as f64 == size))
            })
        }
        "$mod" => mod_leaf(operand)?,
        "$elemMatch" => doc_test_as_leaf(compile_elem_match(&Arc::new(Vec::new()), operand)?),
        "$all" => single_all_leaf(operand)?,
        "$not" => single_not_leaf(operand)?,
        _ if UNSUPPORTED_FIELD.contains(&op) => {
            return Err(unsupported_query([op, " is not evaluated in process"].concat()));
        }
        _ => return Err(invalid(["unknown operator: ", op].concat())),
    })
}

fn doc_test_as_leaf(test: DocTest) -> Leaf {
    Arc::new(move |value| match value {
        Some(value) => test(Item::Value(value)),
        None => test(Item::Value(ValueRef::Undefined)),
    })
}

fn all_leaves(leaves: Vec<Leaf>) -> Leaf {
    Arc::new(move |value| {
        for leaf in &leaves {
            if !leaf(value)? {
                return Ok(false);
            }
        }
        Ok(true)
    })
}

fn single_all_leaf(operand: &Value) -> Result<Leaf, CanopyError> {
    let Value::Array(items) = operand else { return Err(invalid("$all needs an array")) };
    if items.is_empty() {
        return Ok(Arc::new(|_| Ok(false)));
    }
    let mut leaves = Vec::with_capacity(items.len());
    for item in items {
        if first_key_is(item, "$elemMatch") {
            let inner =
                item.as_document().and_then(|document| document.get("$elemMatch")).unwrap_or(&Value::Null);
            leaves.push(doc_test_as_leaf(compile_elem_match(&Arc::new(Vec::new()), inner)?));
            continue;
        }
        if is_operator_object(item) {
            return Err(invalid("no $ expressions in $all"));
        }
        leaves.push(match regex_of(item) {
            Some(regex) => regex_leaf(regex)?,
            None => eq_leaf(item),
        });
    }
    Ok(all_leaves(leaves))
}

fn operator_keys(operand: &Value) -> Result<&Document, CanopyError> {
    match operand {
        Value::Document(document) if !document.is_empty() => {
            if !document.keys().all(|key| key.starts_with('$')) {
                return Err(invalid("$not needs a regex or a document of operators"));
            }
            Ok(document)
        }
        _ => Err(invalid("$not needs a regex or a document")),
    }
}

fn single_not_leaf(operand: &Value) -> Result<Leaf, CanopyError> {
    if let Some(regex) = regex_of(operand) {
        return Ok(negate_leaf(regex_leaf(regex)?));
    }
    let document = operator_keys(operand)?;
    let mut leaves = Vec::with_capacity(document.len());
    for (key, inner) in document.iter() {
        match key {
            "$options" => {}
            "$regex" => leaves.push(regex_leaf(&regex_from_operator(inner, document.get("$options"))?)?),
            _ => leaves.push(value_operator_leaf(key, inner)?),
        }
    }
    Ok(negate_leaf(all_leaves(leaves)))
}

fn compile_not(parts: &Arc<Vec<Segment>>, operand: &Value) -> Result<DocTest, CanopyError> {
    if let Some(regex) = regex_of(operand) {
        return Ok(negate(expand(parts, regex_leaf(regex)?)));
    }
    let Value::Document(document) = operand else { return Err(invalid("$not needs a regex or a document")) };
    if document.is_empty() {
        return Err(invalid("$not cannot be empty"));
    }
    if !document.keys().all(|key| key.starts_with('$')) {
        return Err(invalid("$not needs a regex or a document of operators"));
    }
    if !document.contains_key("$regex") && document.contains_key("$options") {
        return Err(invalid("$options needs a $regex"));
    }
    Ok(negate(compile_operators(parts, document)?))
}
