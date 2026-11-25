//! Dotted path traversal with MongoDB's implicit array semantics.

use canopy_protocol::{ArrayRef, CanopyError, DocRef, Document, Value, ValueRef};

/// The result of testing a value: a match decision, or an error (such as a regular expression input too large
/// to match in process) that must reach the caller rather than being read as "no match".
pub type Outcome = Result<bool, CanopyError>;

pub(crate) struct Segment {
    pub(crate) name: String,
    position: Option<usize>,
}

impl Segment {
    pub(crate) fn new(name: &str) -> Self {
        Self { name: name.to_owned(), position: is_array_index(name).then(|| name.parse().ok()).flatten() }
    }
}

trait PathPart {
    fn name(&self) -> &str;
    fn position(&self) -> Option<usize>;
}

impl PathPart for Segment {
    fn name(&self) -> &str {
        &self.name
    }

    fn position(&self) -> Option<usize> {
        self.position
    }
}

impl PathPart for String {
    fn name(&self) -> &str {
        self
    }

    fn position(&self) -> Option<usize> {
        is_array_index(self).then(|| self.parse().ok()).flatten()
    }
}

/// A node reached while walking a path: a document, an array read as a document of its positions (the
/// `$elemMatch` object form), or any value.
#[derive(Debug, Clone, Copy)]
pub enum Item<'a> {
    /// A document.
    Document(DocRef<'a>),
    /// An array whose elements are addressed by their decimal positions.
    Positions(ArrayRef<'a>),
    /// Any value.
    Value(ValueRef<'a>),
}

impl<'a> Item<'a> {
    fn field(self, segment: &impl PathPart) -> Option<ValueRef<'a>> {
        match self {
            Item::Document(document) | Item::Value(ValueRef::Document(document)) => {
                present(document.get(segment.name())?)
            }
            Item::Positions(items) => present(items.get(segment.position()?)?),
            Item::Value(_) => None,
        }
    }

    fn is_document(self) -> bool {
        matches!(self, Item::Document(_) | Item::Positions(_) | Item::Value(ValueRef::Document(_)))
    }
}

/// Returns `None` for the deprecated `undefined`, which the matcher treats as a missing value.
pub fn present(value: ValueRef<'_>) -> Option<ValueRef<'_>> {
    if matches!(value, ValueRef::Undefined) { None } else { Some(value) }
}

/// Returns true when a path segment can address an array position.
pub fn is_array_index(part: &str) -> bool {
    !part.is_empty()
        && part.bytes().all(|byte| byte.is_ascii_digit())
        && (part == "0" || !part.starts_with('0'))
}

/// A test of the value found at the end of a path. `None` stands for a missing value.
pub type LeafFn<'f> = dyn Fn(Option<ValueRef<'_>>) -> Outcome + 'f;

/// Returns true when `leaf` holds for any value the path reaches, following MongoDB's implicit array
/// traversal: arrays met before the last segment are searched element by element (and by position for
/// numeric segments), and when `expand_last` is set an array found at the end is tested element by element
/// and then as a whole.
pub fn any_path_value(root: Item<'_>, parts: &[String], expand_last: bool, leaf: &LeafFn<'_>) -> Outcome {
    walk(Some(root), parts, expand_last, leaf, false)
}

#[inline]
pub(crate) fn test_path(
    root: Item<'_>,
    parts: &[Segment],
    expand_last: bool,
    leaf: &(impl Fn(Option<ValueRef<'_>>) -> Outcome + ?Sized),
) -> Outcome {
    if let Item::Document(DocRef::Owned(document)) = root
        && !parts.is_empty()
    {
        return walk_owned(document, parts, expand_last, leaf);
    }
    walk(Some(root), parts, expand_last, leaf, false)
}

#[inline]
fn walk_owned(
    mut document: &Document,
    mut parts: &[Segment],
    expand_last: bool,
    leaf: &(impl Fn(Option<ValueRef<'_>>) -> Outcome + ?Sized),
) -> Outcome {
    while let [part, rest @ ..] = parts {
        match document.get(&part.name) {
            None | Some(Value::Undefined) => return leaf(None),
            Some(value) if rest.is_empty() => return test_value(value.view(), expand_last, leaf),
            Some(Value::Document(child)) => document = child,
            Some(Value::Array(items)) => {
                if let [next, tail @ ..] = rest {
                    return walk_array(ArrayRef::Owned(items), next, tail, expand_last, leaf);
                }
            }
            Some(_) => return leaf(None),
        }
        parts = rest;
    }
    Ok(false)
}

#[inline]
fn walk(
    mut item: Option<Item<'_>>,
    mut parts: &[impl PathPart],
    expand_last: bool,
    leaf: &(impl Fn(Option<ValueRef<'_>>) -> Outcome + ?Sized),
    mut via_position: bool,
) -> Outcome {
    while let [part, rest @ ..] = parts {
        match item {
            Some(Item::Value(ValueRef::Array(items))) => {
                return walk_array(items, part, rest, expand_last, leaf);
            }
            Some(node) if node.is_document() => item = node.field(part).map(Item::Value),
            Some(_) if via_position => return Ok(false),
            _ => return leaf(None),
        }
        parts = rest;
        via_position = false;
    }
    match item {
        Some(Item::Value(value)) => test_value(value, expand_last, leaf),
        Some(Item::Document(_) | Item::Positions(_)) => Ok(false),
        None => leaf(None),
    }
}

#[inline]
fn test_value(
    value: ValueRef<'_>,
    expand: bool,
    leaf: &(impl Fn(Option<ValueRef<'_>>) -> Outcome + ?Sized),
) -> Outcome {
    if let (true, ValueRef::Array(items)) = (expand, value) {
        for element in items.iter() {
            if leaf(present(element))? {
                return Ok(true);
            }
        }
    }
    leaf(Some(value))
}

fn walk_array<P: PathPart>(
    items: ArrayRef<'_>,
    part: &P,
    rest: &[P],
    expand_last: bool,
    leaf: &(impl Fn(Option<ValueRef<'_>>) -> Outcome + ?Sized),
) -> Outcome {
    if let Some(element) = part.position().and_then(|position| items.get(position))
        && walk(present(element).map(Item::Value), rest, expand_last && !rest.is_empty(), leaf, true)?
    {
        return Ok(true);
    }
    for element in items.iter() {
        if matches!(element, ValueRef::Document(_))
            && walk(Item::Value(element).field(part).map(Item::Value), rest, expand_last, leaf, false)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Splits a dotted path into its segments.
pub fn split_path(path: &str) -> Vec<String> {
    path.split('.').map(str::to_owned).collect()
}
