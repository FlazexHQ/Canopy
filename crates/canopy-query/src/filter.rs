//! Validation of untrusted filters and aggregation expressions.

use canopy_matcher::{is_linear_regex, is_matcher_safe};
use canopy_protocol::ejson::is_forbidden_key;
use canopy_protocol::{CanopyError, Document, Value};

use crate::limits::{DEFAULT_LIMITS, QueryLimits};
use crate::paths::{PathOptions, validate_path};
use crate::values::{js_fields, js_first_key, js_length, js_number};

/// Where a filter comes from. Each context has its own operator allowlist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FilterContext {
    /// A caller's query.
    #[default]
    Filter,
    /// A policy clause evaluated in process and by MongoDB.
    Using,
    /// A policy clause evaluated only by MongoDB inside the write transaction.
    Check,
}

/// Options for [`parse_filter`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseFilterOptions {
    /// Where the filter comes from.
    pub context: FilterContext,
    /// The limits to apply.
    pub limits: QueryLimits,
    /// Accept policy variables (`$auth`, `$ctx`, `$now`) in value positions.
    pub variables: bool,
    /// Accept `$expr` in a caller filter, with the variables an aggregation pipeline binds (`$$name`,
    /// starting with a lower case letter). Used for the `$match` stages of sanitized aggregations.
    pub expressions: bool,
}

impl Default for ParseFilterOptions {
    fn default() -> ParseFilterOptions {
        ParseFilterOptions {
            context: FilterContext::Filter,
            limits: DEFAULT_LIMITS,
            variables: false,
            expressions: false,
        }
    }
}

/// The result of validating a filter.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFilter {
    /// The filter, unchanged.
    pub filter: Document,
    /// Every field path the filter reads, with `$elemMatch` prefixes resolved, in the order first read.
    pub paths: Vec<String>,
    /// Whether the filter can be evaluated by the in process matcher.
    pub matcher_safe: bool,
    /// Whether the filter contains policy variables.
    pub has_variables: bool,
}

const LOGICAL: [&str; 3] = ["$and", "$or", "$nor"];
const MATCHER_FIELD_OPERATORS: [&str; 17] = [
    "$eq",
    "$ne",
    "$gt",
    "$gte",
    "$lt",
    "$lte",
    "$in",
    "$nin",
    "$exists",
    "$type",
    "$all",
    "$elemMatch",
    "$size",
    "$mod",
    "$regex",
    "$options",
    "$not",
];
const FILTER_ONLY_FIELD_OPERATORS: [&str; 8] = [
    "$geoWithin",
    "$geoIntersects",
    "$near",
    "$nearSphere",
    "$bitsAllSet",
    "$bitsAnySet",
    "$bitsAllClear",
    "$bitsAnyClear",
];
const BANNED_EXPRESSIONS: [&str; 3] = ["$function", "$accumulator", "$where"];
const ALLOWED_SYSTEM_VARIABLES: [&str; 4] = ["$$NOW", "$$ROOT", "$$CURRENT", "$$REMOVE"];
const VARIABLE_KEYS: [&str; 3] = ["$auth", "$ctx", "$now"];

/// Returns true when `value` is a policy variable such as `{ $auth: "sub" }`.
pub fn is_variable(value: &Value) -> bool {
    match value {
        Value::Document(document) => js_first_key(document).is_some_and(|key| VARIABLE_KEYS.contains(&key)),
        _ => false,
    }
}

fn is_user_variable(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("$$") else { return false };
    let mut chars = rest.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_regex_options(options: &str) -> bool {
    options.chars().all(|c| matches!(c, 'i' | 'm' | 's' | 'x' | 'u'))
}

struct State {
    context: FilterContext,
    limits: QueryLimits,
    variables: bool,
    expressions: bool,
    paths: Vec<String>,
    nodes: usize,
    has_variables: bool,
}

fn fail<T>(message: impl Into<String>) -> Result<T, CanopyError> {
    Err(CanopyError::invalid_query(message))
}

impl State {
    fn new(context: FilterContext, limits: QueryLimits, variables: bool, expressions: bool) -> State {
        State { context, limits, variables, expressions, paths: Vec::new(), nodes: 0, has_variables: false }
    }

    fn count(&mut self, amount: usize) -> Result<(), CanopyError> {
        self.nodes += amount;
        if self.nodes > self.limits.max_nodes {
            return fail(format!("A query may not have more than {} values", self.limits.max_nodes));
        }
        Ok(())
    }

    fn check_depth(&self, depth: usize) -> Result<(), CanopyError> {
        if depth > self.limits.max_depth {
            return fail(format!("A query may not nest deeper than {} levels", self.limits.max_depth));
        }
        Ok(())
    }

    fn add_path(&mut self, path: String) {
        if !self.paths.contains(&path) {
            self.paths.push(path);
        }
    }

    fn filter_document(
        &mut self,
        document: &Document,
        depth: usize,
        prefix: &str,
    ) -> Result<(), CanopyError> {
        self.check_depth(depth)?;
        let fields = js_fields(document);
        self.count(fields.len())?;
        for (key, value) in fields {
            if key.starts_with('$') {
                self.top_operator(key, value, depth, prefix)?;
                continue;
            }
            validate_path(key, PathOptions { positional: false, max_length: self.limits.max_path_length })?;
            let path = if prefix.is_empty() { key.to_owned() } else { format!("{prefix}.{key}") };
            self.add_path(path.clone());
            self.condition(value, &path, depth + 1)?;
        }
        Ok(())
    }

    fn top_operator(
        &mut self,
        key: &str,
        value: &Value,
        depth: usize,
        prefix: &str,
    ) -> Result<(), CanopyError> {
        if LOGICAL.contains(&key) {
            let Value::Array(branches) = value else {
                return fail(format!("{key} must be a nonempty array"));
            };
            if branches.is_empty() {
                return fail(format!("{key} must be a nonempty array"));
            }
            self.count(branches.len())?;
            for branch in branches {
                let Value::Document(branch) = branch else {
                    return fail(format!("{key} entries must be documents"));
                };
                self.filter_document(branch, depth + 1, prefix)?;
            }
            return Ok(());
        }
        match key {
            "$expr" => {
                if self.context != FilterContext::Check && !self.expressions {
                    return fail("$expr is only allowed in check clauses");
                }
                self.expression(value, depth + 1)
            }
            "$jsonSchema" => {
                if self.context != FilterContext::Check {
                    return fail("$jsonSchema is only allowed in check clauses");
                }
                if !matches!(value, Value::Document(_)) {
                    return fail("$jsonSchema must be a document");
                }
                self.literal(value, depth + 1, true)
            }
            "$text" => {
                if self.context != FilterContext::Filter || !prefix.is_empty() || depth != 1 {
                    return fail("$text is only allowed at the top level of a query");
                }
                if !matches!(value, Value::Document(_)) {
                    return fail("$text must be a document");
                }
                self.literal(value, depth + 1, true)
            }
            "$comment" => {
                if self.context != FilterContext::Filter {
                    return fail("$comment is not allowed in policies");
                }
                if !matches!(value, Value::String(_)) {
                    return fail("$comment must be a string");
                }
                Ok(())
            }
            _ => fail(format!("The operator {key} is not allowed")),
        }
    }

    fn condition(&mut self, value: &Value, path: &str, depth: usize) -> Result<(), CanopyError> {
        self.check_depth(depth)?;
        if let Value::Regex(regex) = value {
            return self.regex_parts(&regex.pattern, &regex.options);
        }
        if let Some(ops) = operator_object(value) {
            return self.operators(ops, path, depth);
        }
        self.value(value, depth)
    }

    fn operators(&mut self, ops: &Document, path: &str, depth: usize) -> Result<(), CanopyError> {
        let fields = js_fields(ops);
        self.count(fields.len())?;
        for &(op, operand) in &fields {
            if !op.starts_with('$') {
                return fail(format!(
                    "Unknown operator {op} at {path}: operators and fields cannot be mixed"
                ));
            }
            if FILTER_ONLY_FIELD_OPERATORS.contains(&op) {
                if self.context != FilterContext::Filter {
                    return fail(format!("{op} is not allowed in policies"));
                }
                self.literal(operand, depth + 1, true)?;
                continue;
            }
            if !MATCHER_FIELD_OPERATORS.contains(&op) {
                return fail(format!("The operator {op} is not allowed"));
            }
            match op {
                "$eq" | "$ne" | "$gt" | "$gte" | "$lt" | "$lte" => self.value(operand, depth + 1)?,
                "$in" | "$nin" | "$all" => self.list(op, operand, path, depth + 1)?,
                "$exists" => {
                    if !matches!(operand, Value::Bool(_)) && js_number(operand).is_none() {
                        return fail("$exists needs a boolean");
                    }
                }
                "$type" => match operand {
                    Value::Array(items) => {
                        self.count(items.len())?;
                        if !items
                            .iter()
                            .all(|item| matches!(item, Value::String(_)) || js_number(item).is_some())
                        {
                            return fail("$type needs type names or codes");
                        }
                    }
                    Value::String(_) => {}
                    other if js_number(other).is_some() => {}
                    _ => return fail("$type needs a type name or code"),
                },
                "$size" => {
                    if js_number(operand).is_none() {
                        return fail("$size needs a number");
                    }
                }
                "$mod" => {
                    let valid = matches!(operand, Value::Array(items) if items.len() == 2 && items.iter().all(|item| js_number(item).is_some()));
                    if !valid {
                        return fail("$mod needs [divisor, remainder]");
                    }
                }
                "$regex" => {
                    let (pattern, regex_options) = match operand {
                        Value::String(pattern) => (pattern.as_str(), ""),
                        Value::Regex(regex) => (regex.pattern.as_str(), regex.options.as_str()),
                        _ => return fail("$regex needs a string or a regular expression"),
                    };
                    let options = match ops.get("$options") {
                        Some(Value::String(options)) => options.as_str(),
                        _ => regex_options,
                    };
                    self.regex_parts(pattern, options)?;
                }
                "$options" => {
                    if !matches!(operand, Value::String(options) if is_regex_options(options)) {
                        return fail("$options must be a string of imsxu");
                    }
                    if !ops.contains_key("$regex") {
                        return fail("$options needs a $regex");
                    }
                }
                "$elemMatch" => self.elem_match(operand, path, depth + 1)?,
                "$not" => {
                    if let Value::Regex(regex) = operand {
                        self.regex_parts(&regex.pattern, &regex.options)?;
                    } else if let Some(inner) = operator_object(operand) {
                        self.operators(inner, path, depth + 1)?;
                    } else {
                        return fail("$not needs a regular expression or a document of operators");
                    }
                }
                _ => return fail(format!("The operator {op} is not allowed")),
            }
        }
        Ok(())
    }

    fn list(&mut self, op: &str, operand: &Value, path: &str, depth: usize) -> Result<(), CanopyError> {
        if is_variable(operand) {
            return self.variable(operand);
        }
        let Value::Array(items) = operand else { return fail(format!("{op} needs an array")) };
        if items.len() > self.limits.max_in_list {
            return fail(format!("{op} may not have more than {} values", self.limits.max_in_list));
        }
        self.count(items.len())?;
        for item in items {
            match item {
                Value::Document(inner) if op == "$all" && js_first_key(inner) == Some("$elemMatch") => {
                    let operand = inner.get("$elemMatch").unwrap_or(&Value::Null);
                    self.elem_match(operand, path, depth + 1)?;
                }
                Value::Regex(regex) => {
                    if op == "$all" {
                        return fail("$all does not accept regular expressions here");
                    }
                    self.regex_parts(&regex.pattern, &regex.options)?;
                }
                _ => self.value(item, depth + 1)?,
            }
        }
        Ok(())
    }

    fn elem_match(&mut self, operand: &Value, path: &str, depth: usize) -> Result<(), CanopyError> {
        let Value::Document(document) = operand else { return fail("$elemMatch needs a document") };
        if js_first_key(document).is_some_and(|key| key.starts_with('$') && !LOGICAL.contains(&key)) {
            return self.operators(document, path, depth);
        }
        self.filter_document(document, depth, path)
    }

    fn regex_parts(&self, pattern: &str, options: &str) -> Result<(), CanopyError> {
        if js_length(pattern) > self.limits.max_regex_length {
            return fail(format!(
                "A regular expression may not be longer than {} characters",
                self.limits.max_regex_length
            ));
        }
        if !is_regex_options(options) {
            return fail(format!("Unsupported regular expression options: {options}"));
        }
        if self.context == FilterContext::Using && !is_linear_regex(pattern, options) {
            return fail(
                "Regular expressions in using clauses must be compatible with a linear time engine (no backreferences or lookaround)",
            );
        }
        Ok(())
    }

    fn value(&mut self, value: &Value, depth: usize) -> Result<(), CanopyError> {
        if is_variable(value) {
            return self.variable(value);
        }
        self.literal(value, depth, false)
    }

    fn variable(&mut self, value: &Value) -> Result<(), CanopyError> {
        let Value::Document(document) = value else { return Ok(()) };
        if !self.variables {
            let name = js_first_key(document).unwrap_or_default();
            return fail(format!("Variables such as {name} are only allowed in policies"));
        }
        self.has_variables = true;
        self.count(document.len())
    }

    fn literal(&mut self, value: &Value, depth: usize, allow_dollar_keys: bool) -> Result<(), CanopyError> {
        self.check_depth(depth)?;
        match value {
            Value::Array(items) => {
                self.count(items.len())?;
                for item in items {
                    self.literal(item, depth + 1, allow_dollar_keys)?;
                }
                Ok(())
            }
            Value::Document(document) => {
                let fields = js_fields(document);
                self.count(fields.len())?;
                for (key, inner) in fields {
                    if is_forbidden_key(key) {
                        return fail(format!("The key \"{key}\" is not allowed"));
                    }
                    if key.starts_with('$') && !allow_dollar_keys {
                        return fail(format!("The key {key} is not allowed in a value"));
                    }
                    self.literal(inner, depth + 1, allow_dollar_keys)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn expression(&mut self, value: &Value, depth: usize) -> Result<(), CanopyError> {
        self.check_depth(depth)?;
        match value {
            Value::String(text) => {
                if text.starts_with("$$") {
                    let name = text.split('.').next().unwrap_or(text);
                    if !ALLOWED_SYSTEM_VARIABLES.contains(&name)
                        && !(self.expressions && is_user_variable(name))
                    {
                        return fail(format!("The system variable {name} is not allowed"));
                    }
                }
                Ok(())
            }
            Value::Array(items) => {
                self.count(items.len())?;
                for item in items {
                    self.expression(item, depth + 1)?;
                }
                Ok(())
            }
            _ if is_variable(value) => self.variable(value),
            Value::Document(document) => {
                let fields = js_fields(document);
                self.count(fields.len())?;
                for (key, inner) in fields {
                    if is_forbidden_key(key) {
                        return fail(format!("The key \"{key}\" is not allowed"));
                    }
                    if BANNED_EXPRESSIONS.contains(&key) {
                        return fail(format!("The expression {key} is never allowed"));
                    }
                    self.expression(inner, depth + 1)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

fn operator_object(value: &Value) -> Option<&Document> {
    match value {
        Value::Document(document) if !is_variable(value) => {
            js_first_key(document).filter(|key| key.starts_with('$')).map(|_| document)
        }
        _ => None,
    }
}

/// Validates an untrusted filter against the allowlist of its context and the query limits, and reports the
/// paths it reads. Fails with an `InvalidQueryError` whose message a caller can act on.
pub fn parse_filter(input: &Value, options: &ParseFilterOptions) -> Result<ParsedFilter, CanopyError> {
    let mut state = State::new(options.context, options.limits, options.variables, options.expressions);
    let Value::Document(document) = input else { return fail("A filter must be a document") };
    state.filter_document(document, 1, "")?;
    let matcher_safe = match options.context {
        FilterContext::Filter => is_matcher_safe(input)?,
        FilterContext::Using => true,
        FilterContext::Check => false,
    };
    Ok(ParsedFilter {
        filter: document.clone(),
        paths: state.paths,
        matcher_safe,
        has_variables: state.has_variables,
    })
}

/// Validates an aggregation expression from an untrusted caller: `$function`, `$accumulator` and `$where`
/// are refused at any depth, and so are system variables other than `$$NOW`, `$$ROOT`, `$$CURRENT` and
/// `$$REMOVE`. Variables bound by the pipeline (`$$name`) are accepted.
pub fn parse_expression(input: &Value, limits: &QueryLimits) -> Result<(), CanopyError> {
    State::new(FilterContext::Filter, *limits, false, true).expression(input, 1)
}
