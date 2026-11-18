//! Dotted path traversal with MongoDB's implicit array semantics.

use canopy_protocol::{ArrayRef, CanopyError, DocRef, ValueRef};

/// The result of testing a value: a match decision, or an error (such as a regular expression input too large
/// to match in process) that must reach the caller rather than being read as "no match".
pub type Outcome = Result<bool, CanopyError>;

/// A test of the value found at the end of a path. `None` stands for a missing value.
pub type LeafFn<'f> = dyn Fn(Option<ValueRef<'_>>) -> Outcome + 'f;

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
    fn field(self, name: &str) -> Option<ValueRef<'a>> {
        match self {
            Item::Document(document) | Item::Value(ValueRef::Document(document)) => {
                present(document.get(name)?)
            }
            Item::Positions(items) => {
                if !is_array_index(name) {
                    return None;
                }
                present(items.get(name.parse::<usize>().ok()?)?)
            }
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

/// Returns true when `leaf` holds for any value the path reaches, following MongoDB's implicit array
/// traversal: arrays met before the last segment are searched element by element (and by position for
/// numeric segments), and when `expand_last` is set an array found at the end is tested element by element
/// and then as a whole.
pub fn any_path_value(root: Item<'_>, parts: &[String], expand_last: bool, leaf: &LeafFn<'_>) -> Outcome {
    walk(Some(root), parts, 0, expand_last, leaf, false)
}

fn walk(
    item: Option<Item<'_>>,
    parts: &[String],
    index: usize,
    expand_last: bool,
    leaf: &LeafFn<'_>,
    via_position: bool,
) -> Outcome {
    let Some(part) = parts.get(index) else {
        return match item {
            Some(Item::Value(value)) => {
                if let (true, ValueRef::Array(items)) = (expand_last, value) {
                    for element in items.iter() {
                        if leaf(present(element))? {
                            return Ok(true);
                        }
                    }
                }
                leaf(Some(value))
            }
            Some(Item::Document(_) | Item::Positions(_)) => Ok(false),
            None => leaf(None),
        };
    };
    match item {
        Some(Item::Value(ValueRef::Array(items))) => {
            if is_array_index(part) {
                let last = index + 1 == parts.len();
                if let Some(element) = part.parse::<usize>().ok().and_then(|position| items.get(position)) {
                    if walk(
                        present(element).map(Item::Value),
                        parts,
                        index + 1,
                        expand_last && !last,
                        leaf,
                        true,
                    )? {
                        return Ok(true);
                    }
                }
            }
            for element in items.iter() {
                if matches!(element, ValueRef::Document(_))
                    && walk(
                        Item::Value(element).field(part).map(Item::Value),
                        parts,
                        index + 1,
                        expand_last,
                        leaf,
                        false,
                    )?
                {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Some(item) if item.is_document() => {
            walk(item.field(part).map(Item::Value), parts, index + 1, expand_last, leaf, false)
        }
        Some(_) if via_position => Ok(false),
        _ => leaf(None),
    }
}

/// Splits a dotted path into its segments.
pub fn split_path(path: &str) -> Vec<String> {
    path.split('.').map(str::to_owned).collect()
}
