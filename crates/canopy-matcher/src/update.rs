//! MongoDB update operators and replacement documents applied in process, with MongoDB 5.0 and later
//! semantics.

use std::cmp::Ordering;

use canopy_protocol::{CanopyError, Document, Value};

use crate::compare::{bson_type, compare_values, values_equal};
use crate::errors::{unsupported_query, update_error};
use crate::filter::{CompiledFilter, compile_filter};
use crate::numeric::{Numeric, read_numeric, to_double};
use crate::path::{is_array_index, split_path};
use crate::sort::compile_sort;

/// Options for [`apply_update`].
#[derive(Debug, Clone, Default)]
pub struct UpdateOptions {
    /// Whether the update creates a new document through an upsert. Enables `$setOnInsert`.
    pub is_insert: bool,
    /// Filters for `$[identifier]` positional updates.
    pub array_filters: Vec<Value>,
    /// The clock used by `$currentDate`, in milliseconds since the Unix epoch. Defaults to the current time
    /// where the platform has a clock.
    pub now: Option<i64>,
}

/// The update operators the in process updater supports.
pub const UPDATE_OPERATORS: [&str; 15] = [
    "$set",
    "$unset",
    "$inc",
    "$mul",
    "$min",
    "$max",
    "$currentDate",
    "$rename",
    "$setOnInsert",
    "$push",
    "$addToSet",
    "$pop",
    "$pull",
    "$pullAll",
    "$bit",
];

/// The most elements an update may append to pad an array up to a position, as MongoDB allows.
const MAX_PADDING: usize = 1_500_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Set,
    Unset,
    Inc,
    Mul,
    Min,
    Max,
    CurrentDate,
    SetOnInsert,
    Push,
    AddToSet,
    Pop,
    Pull,
    PullAll,
    Bit,
    RenameTo,
    RenameMissing,
}

impl Op {
    fn parse(name: &str) -> Option<Op> {
        Some(match name {
            "$set" => Op::Set,
            "$unset" => Op::Unset,
            "$inc" => Op::Inc,
            "$mul" => Op::Mul,
            "$min" => Op::Min,
            "$max" => Op::Max,
            "$currentDate" => Op::CurrentDate,
            "$setOnInsert" => Op::SetOnInsert,
            "$push" => Op::Push,
            "$addToSet" => Op::AddToSet,
            "$pop" => Op::Pop,
            "$pull" => Op::Pull,
            "$pullAll" => Op::PullAll,
            "$bit" => Op::Bit,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Op::Set => "$set",
            Op::Unset => "$unset",
            Op::Inc => "$inc",
            Op::Mul => "$mul",
            Op::Min => "$min",
            Op::Max => "$max",
            Op::CurrentDate => "$currentDate",
            Op::SetOnInsert => "$setOnInsert",
            Op::Push => "$push",
            Op::AddToSet => "$addToSet",
            Op::Pop => "$pop",
            Op::Pull => "$pull",
            Op::PullAll => "$pullAll",
            Op::Bit => "$bit",
            Op::RenameTo | Op::RenameMissing => "$rename",
        }
    }

    fn creates(self) -> bool {
        matches!(
            self,
            Op::RenameTo
                | Op::Set
                | Op::Inc
                | Op::Mul
                | Op::Min
                | Op::Max
                | Op::CurrentDate
                | Op::SetOnInsert
                | Op::Push
                | Op::AddToSet
                | Op::Bit
        )
    }
}

#[derive(Debug)]
struct Leaf {
    op: Op,
    operand: Value,
    path: String,
}

#[derive(Debug, Default)]
struct Node {
    children: Vec<(String, Node)>,
    leaf: Option<Leaf>,
    creates: bool,
    strict: bool,
}

type Identifiers = Vec<(String, CompiledFilter)>;

fn fail<T>(message: impl Into<String>) -> Result<T, CanopyError> {
    Err(update_error(message))
}

fn type_name(value: &Value) -> &'static str {
    bson_type(value.view()).alias()
}

/// Returns true when `update` is an operator update rather than a replacement document.
pub fn is_operator_update(update: &Document) -> bool {
    !update.is_empty() && update.keys().all(|key| key.starts_with('$'))
}

/// Applies a MongoDB update (operators or a replacement document) to a copy of `document`, following MongoDB
/// 5.0 and later semantics, including lexicographic processing of new fields. Fails with an `UpdateError`
/// where MongoDB would reject the update, and with an `UnsupportedQueryError` for updates the updater does not
/// evaluate (pipelines, the `$` positional operator, Decimal128 arithmetic).
pub fn apply_update(
    document: &Document,
    update: &Value,
    options: &UpdateOptions,
) -> Result<Document, CanopyError> {
    let update = match update {
        Value::Array(_) => return Err(unsupported_query("Pipeline updates are not evaluated in process")),
        Value::Document(update) => update,
        _ => return fail("An update must be a document"),
    };
    if update.keys().any(|key| key.starts_with('$')) {
        if !update.keys().all(|key| key.starts_with('$')) {
            return fail("An update cannot mix operators and fields");
        }
        return apply_operators(document, update, options);
    }
    apply_replacement(document, update)
}

fn apply_replacement(document: &Document, replacement: &Document) -> Result<Document, CanopyError> {
    validate_document_storage(replacement, "")?;
    let id = document.get("_id");
    if let (Some(new_id), Some(id)) = (replacement.get("_id"), id) {
        if !values_equal(new_id, id) {
            return fail(
                "After applying the update, the (immutable) field '_id' was found to have been altered",
            );
        }
    }
    let mut out = Document::with_capacity(replacement.len() + 1);
    if let Some(id) = id {
        out.insert("_id", id.clone());
    }
    for (key, value) in replacement.iter() {
        if key == "_id" && id.is_some() {
            continue;
        }
        out.insert(key, value.clone());
    }
    Ok(out)
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() { key.to_owned() } else { format!("{path}.{key}") }
}

fn validate_storage(value: &Value, path: &str) -> Result<(), CanopyError> {
    match value {
        Value::Array(items) => {
            for (index, element) in items.iter().enumerate() {
                validate_storage(element, &format!("{path}.{index}"))?;
            }
            Ok(())
        }
        Value::Document(document) => validate_document_storage(document, path),
        _ => Ok(()),
    }
}

fn validate_document_storage(document: &Document, path: &str) -> Result<(), CanopyError> {
    for (key, value) in document.iter() {
        let at = join(path, key);
        if key.starts_with('$') {
            return fail(format!("The dollar ($) prefixed field '{key}' in '{at}' is not allowed"));
        }
        validate_storage(value, &at)?;
    }
    Ok(())
}

fn apply_operators(
    document: &Document,
    update: &Document,
    options: &UpdateOptions,
) -> Result<Document, CanopyError> {
    let mut root = Node::default();
    let identifiers = parse_array_filters(&options.array_filters)?;
    let mut used: Vec<String> = Vec::new();
    for (name, operand) in update.iter() {
        let is_rename = name == "$rename";
        let op = Op::parse(name);
        if op.is_none() && !is_rename {
            return fail(format!("Unknown modifier: {name}"));
        }
        let Value::Document(fields) = operand else {
            return fail(format!(
                "Modifiers operate on fields but we found type {} instead",
                type_name(operand)
            ));
        };
        for (path, value) in fields.iter() {
            match op {
                Some(op) => {
                    validate_operand(op, path, value)?;
                    let leaf = Leaf { op, operand: value.clone(), path: path.to_owned() };
                    add_leaf(&mut root, path, leaf, &identifiers, &mut used)?;
                }
                None => add_rename(&mut root, document, path, value)?,
            }
        }
    }
    if let Some((identifier, _)) = identifiers.iter().find(|(identifier, _)| !used.contains(identifier)) {
        return fail(format!("The array filter for identifier '{identifier}' was not used in the update"));
    }
    let mut out = document.clone();
    let settings = Settings { options, identifiers: &identifiers };
    apply_children(Container::Document(&mut out), &root, "", &settings)?;
    if let Some(id) = document.get("_id") {
        if !out.get("_id").is_some_and(|after| values_equal(after, id)) {
            return fail("Performing an update on the path '_id' would modify the immutable field '_id'");
        }
    }
    Ok(out)
}

fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_alphanumeric())
}

fn parse_array_filters(filters: &[Value]) -> Result<Identifiers, CanopyError> {
    let mut out: Identifiers = Vec::new();
    for filter in filters {
        let Value::Document(fields) = filter else {
            return fail("Each array filter must be a document");
        };
        let mut identifier: Option<String> = None;
        for key in fields.keys() {
            let id = key.split('.').next().unwrap_or_default();
            if !is_identifier(id) {
                return fail(format!(
                    "The top level field name must be an alphanumeric string beginning with a lowercase letter: {id}"
                ));
            }
            if identifier.as_deref().is_some_and(|existing| existing != id) {
                return fail("Each array filter must use a single top level field name");
            }
            identifier = Some(id.to_owned());
        }
        let Some(identifier) = identifier else {
            return fail("Cannot use an expression without a top level field name");
        };
        if out.iter().any(|(existing, _)| *existing == identifier) {
            return fail(format!(
                "Found multiple array filters with the same top level field name {identifier}"
            ));
        }
        out.push((identifier, compile_filter(filter)?));
    }
    Ok(out)
}

fn is_integral(value: &Value) -> bool {
    read_numeric(value.view()).is_some_and(|number| {
        let n = to_double(number);
        n.is_finite() && n.fract() == 0.0
    })
}

fn is_integer_type(value: &Value) -> bool {
    matches!(value, Value::Int32(_) | Value::Int64(_))
}

fn validate_operand(op: Op, path: &str, value: &Value) -> Result<(), CanopyError> {
    match op {
        Op::Inc | Op::Mul => match read_numeric(value.view()) {
            None => {
                let verb = if op == Op::Inc { "increment" } else { "multiply" };
                fail(format!("Cannot {verb} with non-numeric argument: {{{path}: ...}}"))
            }
            Some(Numeric::Decimal(_)) => {
                Err(unsupported_query("Decimal128 arithmetic is not evaluated in process"))
            }
            Some(_) => Ok(()),
        },
        Op::Pop => {
            let n = read_numeric(value.view()).map_or(f64::NAN, to_double);
            if n == 1.0 || n == -1.0 { Ok(()) } else { fail("$pop expects 1 or -1") }
        }
        Op::CurrentDate => {
            let valid = match value {
                Value::Bool(_) => true,
                Value::Document(spec) => {
                    spec.len() == 1
                        && matches!(spec.get("$type"), Some(Value::String(kind)) if kind == "date" || kind == "timestamp")
                }
                _ => false,
            };
            if valid { Ok(()) } else { fail(format!("{path} is not valid for $currentDate")) }
        }
        Op::PullAll => match value {
            Value::Array(_) => Ok(()),
            other => {
                fail(format!("$pullAll requires an array argument but was given a {}", type_name(other)))
            }
        },
        Op::Bit => {
            let Value::Document(spec) = value else {
                return fail("$bit needs a document of and, or, xor");
            };
            if spec.is_empty() {
                return fail("$bit needs a document of and, or, xor");
            }
            for (key, operand) in spec.iter() {
                if !matches!(key, "and" | "or" | "xor") {
                    return fail(format!("The $bit modifier only supports and, or and xor, not {key}"));
                }
                if !is_integer_type(operand) {
                    return fail("The $bit modifier field must be an integer value");
                }
            }
            Ok(())
        }
        Op::Set | Op::SetOnInsert | Op::Min | Op::Max => validate_storage(value, path),
        Op::Push | Op::AddToSet => match value {
            Value::Document(spec) if spec.contains_key("$each") => validate_each(op, spec),
            _ => validate_storage(value, path),
        },
        Op::Unset | Op::Pull | Op::RenameTo | Op::RenameMissing => Ok(()),
    }
}

fn validate_each(op: Op, spec: &Document) -> Result<(), CanopyError> {
    let Some(Value::Array(each)) = spec.get("$each") else {
        return fail(format!("The argument to $each in {} must be an array", op.name()));
    };
    for key in spec.keys() {
        if key == "$each" {
            continue;
        }
        if op == Op::AddToSet {
            return fail(format!("Found unexpected fields after $each in $addToSet: {key}"));
        }
        if !matches!(key, "$position" | "$slice" | "$sort") {
            return fail(format!("Unrecognized clause in $push: {key}"));
        }
    }
    for item in each {
        validate_storage(item, "")?;
    }
    if spec.get("$position").is_some_and(|position| !is_integral(position)) {
        return fail("The value for $position must be an integer");
    }
    if spec.get("$slice").is_some_and(|slice| !is_integral(slice)) {
        return fail("The value for $slice must be an integer");
    }
    if let Some(sort) = spec.get("$sort") {
        if let Some(number) = read_numeric(sort.view()) {
            let n = to_double(number);
            if n != 1.0 && n != -1.0 {
                return fail("The $sort element value must be either 1 or -1");
            }
        } else {
            match sort {
                Value::Document(fields) if !fields.is_empty() => {
                    compile_sort(sort)?;
                }
                _ => {
                    return fail(
                        "The $sort is invalid: use 1/-1 to sort the whole element, or {field:1/-1} to sort embedded fields",
                    );
                }
            }
        }
    }
    Ok(())
}

fn path_parts(path: &str) -> Result<Vec<String>, CanopyError> {
    if path.is_empty() {
        return fail("An empty update path is not valid");
    }
    let parts = split_path(path);
    if parts.iter().any(String::is_empty) {
        return fail(format!("The update path '{path}' contains an empty field name, which is not allowed"));
    }
    Ok(parts)
}

fn positional_identifier(part: &str) -> Option<&str> {
    let inner = part.strip_prefix("$[")?.strip_suffix(']')?;
    if inner.is_empty() || is_identifier(inner) { Some(inner) } else { None }
}

fn add_leaf(
    root: &mut Node,
    path: &str,
    leaf: Leaf,
    identifiers: &Identifiers,
    used: &mut Vec<String>,
) -> Result<(), CanopyError> {
    let parts = path_parts(path)?;
    let creates = leaf.op.creates();
    let strict = !creates && leaf.op != Op::Unset && leaf.op != Op::RenameMissing;
    let mut leaf = Some(leaf);
    let mut node = root;
    let last = parts.len() - 1;
    for (index, part) in parts.iter().enumerate() {
        if part.starts_with('$') {
            if part == "$" {
                return Err(unsupported_query("The positional $ operator is not evaluated in process"));
            }
            let Some(identifier) = positional_identifier(part) else {
                return fail(format!("The dollar ($) prefixed field '{part}' in '{path}' is not allowed"));
            };
            if !identifier.is_empty() {
                if !identifiers.iter().any(|(name, _)| name == identifier) {
                    return fail(format!(
                        "No array filter found for identifier '{identifier}' in path '{path}'"
                    ));
                }
                if !used.iter().any(|name| name == identifier) {
                    used.push(identifier.to_owned());
                }
            }
        }
        if let Some(existing) = &node.leaf {
            return fail(format!(
                "Updating the path '{path}' would create a conflict at '{}'",
                existing.path
            ));
        }
        node.creates |= creates;
        node.strict |= strict;
        let positional = part.starts_with("$[");
        for (sibling, _) in &node.children {
            let sibling_positional = sibling.starts_with("$[");
            if sibling != part && (positional || sibling_positional) && !(positional && sibling_positional) {
                return fail(format!(
                    "Updating the path '{path}' would create a conflict at '{}'",
                    parts[..index].join(".")
                ));
            }
        }
        let position = match node.children.iter().position(|(name, _)| name == part) {
            Some(position) => position,
            None => {
                node.children.push((part.clone(), Node::default()));
                node.children.len() - 1
            }
        };
        node = &mut node.children[position].1;
        if index == last {
            if node.leaf.is_some() || !node.children.is_empty() {
                return fail(format!("Updating the path '{path}' would create a conflict at '{path}'"));
            }
            node.leaf = leaf.take();
            node.creates |= creates;
            node.strict |= strict;
        }
    }
    Ok(())
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Undefined => "undefined".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Int32(n) => n.to_string(),
        Value::Int64(n) => n.to_string(),
        Value::Double(n) => canopy_protocol::json::js_number_string(*n),
        Value::Decimal128(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null | Value::Undefined => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => "[object Object]".to_owned(),
    }
}

fn add_rename(root: &mut Node, document: &Document, from: &str, to: &Value) -> Result<(), CanopyError> {
    let Value::String(to) = to else {
        return fail(format!("The 'to' field for $rename must be a string: {from}: {}", js_string(to)));
    };
    if from == to {
        return fail(format!("The source and target field for $rename must differ: {from}: \"{to}\""));
    }
    if to.starts_with(&format!("{from}.")) || from.starts_with(&format!("{to}.")) {
        return fail(format!(
            "The source and target field for $rename must not be on the same path: {from}: \"{to}\""
        ));
    }
    let from_parts = path_parts(from)?;
    let to_parts = path_parts(to)?;
    if from_parts.iter().chain(&to_parts).any(|part| part.starts_with('$')) {
        return fail("The source and target field for $rename must not contain positional operators");
    }
    let source = read_for_rename(document, &from_parts, "source")?;
    if source.is_some() {
        read_for_rename(document, &to_parts, "destination")?;
    }
    let empty = Vec::new();
    let mut used = Vec::new();
    let unset = Leaf { op: Op::Unset, operand: Value::String(String::new()), path: from.to_owned() };
    add_leaf(root, from, unset, &empty, &mut used)?;
    let leaf = match source {
        Some(value) => Leaf { op: Op::RenameTo, operand: value, path: to.clone() },
        None => Leaf { op: Op::RenameMissing, operand: Value::Null, path: to.clone() },
    };
    add_leaf(root, to, leaf, &empty, &mut used)
}

fn read_for_rename(document: &Document, parts: &[String], role: &str) -> Result<Option<Value>, CanopyError> {
    let mut current = document;
    for (index, part) in parts.iter().enumerate() {
        let Some(value) = current.get(part) else { return Ok(None) };
        if index + 1 == parts.len() {
            return Ok(Some(value.clone()));
        }
        match value {
            Value::Document(inner) => current = inner,
            Value::Array(_) => {
                return fail(format!(
                    "The {role} field cannot be an array element, '{}' is an array",
                    parts[..=index].join(".")
                ));
            }
            _ if role == "destination" => return Ok(None),
            _ => {
                return fail(format!(
                    "cannot use the part ({part} of {}) to traverse the element",
                    parts.join(".")
                ));
            }
        }
    }
    Ok(None)
}

fn compare_field_names(a: &str, b: &str) -> Ordering {
    if is_array_index(a) && is_array_index(b) {
        return a.len().cmp(&b.len()).then_with(|| a.cmp(b));
    }
    a.cmp(b)
}

fn parent_of(path: &str) -> &str {
    match path.rfind('.') {
        Some(end) if end > 0 => &path[..end],
        _ => path,
    }
}

struct Settings<'s> {
    options: &'s UpdateOptions,
    identifiers: &'s Identifiers,
}

enum Container<'c> {
    Document(&'c mut Document),
    Array(&'c mut Vec<Value>),
}

impl Container<'_> {
    fn read(&self, key: &str) -> Option<&Value> {
        match self {
            Container::Document(document) => document.get(key),
            Container::Array(items) => {
                if !is_array_index(key) {
                    return None;
                }
                key.parse::<usize>().ok().and_then(|index| items.get(index))
            }
        }
    }

    fn slot(&mut self, key: &str) -> Option<&mut Value> {
        match self {
            Container::Document(document) => document.get_mut(key),
            Container::Array(items) => key.parse::<usize>().ok().and_then(|index| items.get_mut(index)),
        }
    }

    fn write(&mut self, key: &str, value: Value, path: &str) -> Result<(), CanopyError> {
        match self {
            Container::Document(document) => {
                document.insert(key, value);
                Ok(())
            }
            Container::Array(items) => {
                let Some(index) = key.parse::<usize>().ok().filter(|_| is_array_index(key)) else {
                    return fail(format!(
                        "Cannot create field '{key}' in element {{{}: [...]}}",
                        parent_of(path)
                    ));
                };
                if index > items.len() + MAX_PADDING {
                    return fail(format!("can't backfill more than {MAX_PADDING} elements"));
                }
                if index < items.len() {
                    items[index] = value;
                } else {
                    items.resize(index, Value::Null);
                    items.push(value);
                }
                Ok(())
            }
        }
    }
}

fn apply_children(
    mut container: Container<'_>,
    node: &Node,
    prefix: &str,
    settings: &Settings<'_>,
) -> Result<(), CanopyError> {
    let mut ordered: Vec<&(String, Node)> = node.children.iter().collect();
    ordered.sort_by(|(a, _), (b, _)| compare_field_names(a, b));
    let mut touched: Vec<usize> = Vec::new();
    for (key, child) in ordered {
        if key.starts_with("$[") {
            let Container::Array(items) = &container else {
                return fail(format!("Cannot apply array updates to non-array element {prefix}"));
            };
            let identifier = positional_identifier(key).unwrap_or_default();
            let test = settings.identifiers.iter().find(|(name, _)| name == identifier).map(|(_, test)| test);
            let mut targets = Vec::new();
            for (index, element) in items.iter().enumerate() {
                let selected = match test {
                    None => true,
                    Some(test) => {
                        let mut probe = Document::with_capacity(1);
                        probe.insert(identifier, element.clone());
                        test.matches(&probe)?
                    }
                };
                if selected {
                    targets.push(index);
                }
            }
            for index in targets {
                if touched.contains(&index) {
                    return fail(format!("Update created a conflict at '{prefix}.{index}'"));
                }
                touched.push(index);
                apply_at(&mut container, &index.to_string(), child, &format!("{prefix}.{index}"), settings)?;
            }
            continue;
        }
        apply_at(&mut container, key, child, &join(prefix, key), settings)?;
    }
    Ok(())
}

fn apply_at(
    container: &mut Container<'_>,
    key: &str,
    node: &Node,
    path: &str,
    settings: &Settings<'_>,
) -> Result<(), CanopyError> {
    if matches!(container, Container::Array(_)) && !is_array_index(key) {
        if node.creates {
            return fail(format!("Cannot create field '{key}' in element {{{}: [...]}}", parent_of(path)));
        }
        if node.strict {
            return fail(format!(
                "Cannot use the part ({key}) of ({path}) to traverse the element ({{{}: [...]}})",
                parent_of(path)
            ));
        }
        return Ok(());
    }
    if let Some(leaf) = &node.leaf {
        return apply_leaf(container, key, leaf, path, settings.options);
    }
    let has_positional = node.children.iter().any(|(name, _)| name.starts_with("$["));
    let Some(current) = container.slot(key) else {
        if has_positional {
            return fail(format!(
                "The path '{path}' must exist in the document in order to apply array updates."
            ));
        }
        if !node.creates {
            return Ok(());
        }
        container.write(key, Value::Document(Document::new()), path)?;
        return match container.slot(key) {
            Some(Value::Document(created)) => {
                apply_children(Container::Document(created), node, path, settings)
            }
            _ => Ok(()),
        };
    };
    match current {
        Value::Document(inner) => apply_children(Container::Document(inner), node, path, settings),
        Value::Array(inner) => apply_children(Container::Array(inner), node, path, settings),
        scalar => {
            let first = node.children.first().map(|(name, _)| name.as_str()).unwrap_or_default();
            let kind = type_name(scalar);
            if has_positional {
                return fail(format!("Cannot apply array updates to non-array element {path}: {kind}"));
            }
            if node.creates {
                return fail(format!("Cannot create field '{first}' in element {{{key}: {kind}}}"));
            }
            if node.strict {
                return fail(format!(
                    "Cannot use the part ({first}) of ({path}.{first}) to traverse the element ({{{key}: {kind}}})"
                ));
            }
            Ok(())
        }
    }
}

fn now_ms(options: &UpdateOptions) -> Result<i64, CanopyError> {
    if let Some(now) = options.now {
        return Ok(now);
    }
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    {
        let elapsed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| update_error("The system clock is before the Unix epoch"))?;
        Ok(i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
    }
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    {
        Err(unsupported_query("$currentDate needs a clock: pass UpdateOptions::now"))
    }
}

fn apply_leaf(
    container: &mut Container<'_>,
    key: &str,
    leaf: &Leaf,
    path: &str,
    options: &UpdateOptions,
) -> Result<(), CanopyError> {
    let operand = &leaf.operand;
    let current = container.read(key).cloned();
    let value = match leaf.op {
        Op::Set | Op::RenameTo => operand.clone(),
        Op::SetOnInsert if options.is_insert => operand.clone(),
        Op::SetOnInsert | Op::RenameMissing => return Ok(()),
        Op::Unset => {
            match container {
                Container::Document(document) => {
                    document.remove(key);
                }
                Container::Array(_) => {
                    if let Some(slot) = container.slot(key) {
                        *slot = Value::Null;
                    }
                }
            }
            return Ok(());
        }
        Op::Inc | Op::Mul => match current {
            None if leaf.op == Op::Inc => operand.clone(),
            None => zero_like(operand),
            Some(current) => {
                if read_numeric(current.view()).is_none() {
                    return fail(format!(
                        "Cannot apply {} to a value of non-numeric type. {{{key}: {}}}",
                        leaf.op.name(),
                        type_name(&current)
                    ));
                }
                arithmetic(leaf.op, &current, operand)?
            }
        },
        Op::Min | Op::Max => match current {
            None => operand.clone(),
            Some(current) => {
                let order = compare_values(operand, &current);
                let replace =
                    if leaf.op == Op::Min { order == Ordering::Less } else { order == Ordering::Greater };
                if !replace {
                    return Ok(());
                }
                operand.clone()
            }
        },
        Op::CurrentDate => {
            let now = now_ms(options)?;
            let timestamp = matches!(operand, Value::Document(spec) if matches!(spec.get("$type"), Some(Value::String(kind)) if kind == "timestamp"));
            if timestamp {
                Value::Timestamp { t: u32::try_from(now.div_euclid(1000)).unwrap_or(0), i: 1 }
            } else {
                Value::DateTime(now)
            }
        }
        Op::Push | Op::AddToSet => {
            let items = match current {
                None => Vec::new(),
                Some(Value::Array(items)) => items,
                Some(other) => {
                    return fail(format!(
                        "The field '{key}' must be an array but is of type {} in document",
                        type_name(&other)
                    ));
                }
            };
            if leaf.op == Op::Push { push(items, operand) } else { add_to_set(items, operand) }
        }
        Op::Pop => match current {
            None => return Ok(()),
            Some(Value::Array(mut items)) => {
                if items.is_empty() {
                    return Ok(());
                }
                if read_numeric(operand.view()).map_or(1.0, to_double) == 1.0 {
                    items.pop();
                } else {
                    items.remove(0);
                }
                Value::Array(items)
            }
            Some(other) => {
                return fail(format!(
                    "Path '{path}' contains an element of non-array type '{}'",
                    type_name(&other)
                ));
            }
        },
        Op::Pull | Op::PullAll => match current {
            None => return Ok(()),
            Some(Value::Array(items)) => {
                let remove =
                    if leaf.op == Op::PullAll { pull_all_test(operand) } else { pull_test(operand)? };
                let mut kept = Vec::with_capacity(items.len());
                for element in items {
                    if !remove.removes(&element)? {
                        kept.push(element);
                    }
                }
                Value::Array(kept)
            }
            Some(_) => return fail("Cannot apply $pull to a non-array value"),
        },
        Op::Bit => {
            let current = current.unwrap_or(Value::Int32(0));
            if !is_integer_type(&current) {
                return fail(format!(
                    "Cannot apply $bit to a value of non-integral type. {{{key}: {}}}",
                    type_name(&current)
                ));
            }
            let Value::Document(spec) = operand else { return fail("$bit needs a document of and, or, xor") };
            bitwise(&current, spec)
        }
    };
    container.write(key, value, path)
}

fn zero_like(operand: &Value) -> Value {
    match operand {
        Value::Int64(_) => Value::Int64(0),
        Value::Double(n) => Value::Double(n * 0.0),
        _ => Value::Int32(0),
    }
}

fn as_i64(value: &Value) -> i64 {
    match value {
        Value::Int32(n) => i64::from(*n),
        Value::Int64(n) => *n,
        _ => 0,
    }
}

fn arithmetic(op: Op, current: &Value, operand: &Value) -> Result<Value, CanopyError> {
    let (Some(a), Some(b)) = (read_numeric(current.view()), read_numeric(operand.view())) else {
        return fail(format!("Cannot apply {}", op.name()));
    };
    if matches!(a, Numeric::Decimal(_)) || matches!(b, Numeric::Decimal(_)) {
        return Err(unsupported_query("Decimal128 arithmetic is not evaluated in process"));
    }
    if matches!(a, Numeric::Double(_)) || matches!(b, Numeric::Double(_)) {
        let (x, y) = (to_double(a), to_double(b));
        return Ok(Value::Double(if op == Op::Inc { x + y } else { x * y }));
    }
    let (x, y) = (as_i64(current), as_i64(operand));
    if let (Numeric::Int(_), Numeric::Int(_)) = (a, b) {
        let exact = if op == Op::Inc { x + y } else { x * y };
        return Ok(match i32::try_from(exact) {
            Ok(small) => Value::Int32(small),
            Err(_) => Value::Int64(exact),
        });
    }
    let result = if op == Op::Inc { x.checked_add(y) } else { x.checked_mul(y) };
    match result {
        Some(result) => Ok(Value::Int64(result)),
        None => fail(format!("Failed to apply {} operations to current value: integer overflow", op.name())),
    }
}

fn bitwise(current: &Value, spec: &Document) -> Value {
    let mut value = as_i64(current);
    let mut long = matches!(current, Value::Int64(_));
    for (key, operand) in spec.iter() {
        long |= matches!(operand, Value::Int64(_));
        let other = as_i64(operand);
        value = match key {
            "and" => value & other,
            "or" => value | other,
            _ => value ^ other,
        };
    }
    #[allow(clippy::cast_possible_truncation)]
    if long { Value::Int64(value) } else { Value::Int32(value as i32) }
}

fn integer_of(value: Option<&Value>) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    value.and_then(|value| read_numeric(value.view())).map_or(0, |number| to_double(number) as i64)
}

fn push(mut items: Vec<Value>, operand: &Value) -> Value {
    let spec = match operand {
        Value::Document(spec) if spec.contains_key("$each") => spec,
        _ => {
            items.push(operand.clone());
            return Value::Array(items);
        }
    };
    let each = match spec.get("$each") {
        Some(Value::Array(each)) => each.clone(),
        _ => Vec::new(),
    };
    match spec.get("$position") {
        None => items.extend(each),
        Some(position) => {
            let length = i64::try_from(items.len()).unwrap_or(i64::MAX);
            let mut at = integer_of(Some(position));
            if at < 0 {
                at = (length + at).max(0);
            }
            let at = usize::try_from(at.min(length)).unwrap_or(items.len());
            items.splice(at..at, each);
        }
    }
    if let Some(sort) = spec.get("$sort") {
        match read_numeric(sort.view()) {
            Some(number) => {
                let descending = to_double(number) < 0.0;
                items.sort_by(|a, b| {
                    let order = compare_values(a, b);
                    if descending { order.reverse() } else { order }
                });
            }
            None => {
                if let Value::Document(fields) = sort {
                    sort_elements(&mut items, fields);
                }
            }
        }
    }
    if let Some(slice) = spec.get("$slice") {
        let slice = integer_of(Some(slice));
        let length = items.len();
        if slice >= 0 {
            items.truncate(usize::try_from(slice).unwrap_or(usize::MAX).min(length));
        } else {
            let keep = usize::try_from(slice.unsigned_abs()).unwrap_or(usize::MAX).min(length);
            items.drain(..length - keep);
        }
    }
    Value::Array(items)
}

fn sort_elements(items: &mut [Value], spec: &Document) {
    let keys: Vec<(Vec<String>, bool)> = spec
        .iter()
        .map(|(path, direction)| {
            (split_path(path), read_numeric(direction.view()).is_some_and(|number| to_double(number) < 0.0))
        })
        .collect();
    fn read<'v>(value: &'v Value, parts: &[String]) -> &'v Value {
        let mut current = value;
        for part in parts {
            current = match current {
                Value::Document(document) => match document.get(part) {
                    Some(next) => next,
                    None => return &Value::Null,
                },
                _ => return &Value::Null,
            };
        }
        current
    }
    items.sort_by(|a, b| {
        for (parts, descending) in &keys {
            let order = compare_values(read(a, parts), read(b, parts));
            if order != Ordering::Equal {
                return if *descending { order.reverse() } else { order };
            }
        }
        Ordering::Equal
    });
}

fn add_to_set(mut items: Vec<Value>, operand: &Value) -> Value {
    let candidates: Vec<Value> = match operand {
        Value::Document(spec) if spec.contains_key("$each") => match spec.get("$each") {
            Some(Value::Array(each)) => each.clone(),
            _ => Vec::new(),
        },
        _ => vec![operand.clone()],
    };
    for item in candidates {
        if !items.iter().any(|existing| values_equal(existing, &item)) {
            items.push(item);
        }
    }
    Value::Array(items)
}

enum Removal {
    Equal(Vec<Value>),
    Wrapped(CompiledFilter),
    WrappedScalar(CompiledFilter),
    Document(CompiledFilter),
}

impl Removal {
    fn removes(&self, element: &Value) -> Result<bool, CanopyError> {
        let wrap = |element: &Value| {
            let mut probe = Document::with_capacity(1);
            probe.insert("v", element.clone());
            probe
        };
        match self {
            Removal::Equal(values) => Ok(values.iter().any(|value| values_equal(element, value))),
            Removal::Wrapped(test) => test.matches(&wrap(element)),
            Removal::WrappedScalar(test) => {
                if matches!(element, Value::Array(_)) {
                    Ok(false)
                } else {
                    test.matches(&wrap(element))
                }
            }
            Removal::Document(test) => match element {
                Value::Document(document) => test.matches(document),
                _ => Ok(false),
            },
        }
    }
}

fn pull_all_test(operand: &Value) -> Removal {
    match operand {
        Value::Array(values) => Removal::Equal(values.clone()),
        _ => Removal::Equal(Vec::new()),
    }
}

fn wrapped(condition: &Value) -> Result<CompiledFilter, CanopyError> {
    let mut filter = Document::with_capacity(1);
    filter.insert("v", condition.clone());
    compile_filter(&Value::Document(filter))
}

fn pull_test(condition: &Value) -> Result<Removal, CanopyError> {
    match condition {
        Value::Document(fields) => {
            let expression = fields
                .first_key()
                .is_some_and(|key| key.starts_with('$') && !matches!(key, "$and" | "$or" | "$nor"));
            if expression {
                Ok(Removal::Wrapped(wrapped(condition)?))
            } else {
                Ok(Removal::Document(compile_filter(condition)?))
            }
        }
        Value::Regex(_) => Ok(Removal::WrappedScalar(wrapped(condition)?)),
        _ => Ok(Removal::Equal(vec![condition.clone()])),
    }
}
