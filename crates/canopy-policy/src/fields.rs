//! Field level security: combining field rules per role, checking paths, projecting documents and immutable
//! fields.

use canopy_matcher::projection::{exclusion, inclusion};
use canopy_protocol::{CanopyError, DocRef, Document, Value};
use canopy_query::{is_within, paths_overlap, strip_indexes};

use crate::model::{FieldRule, FieldRules, Roles};
use crate::values::{js_document, js_fields, js_keys, js_number};

/// The fields a request may read or write, after combining the rules of all its roles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldAccess {
    /// Every field.
    All,
    /// Only these paths and what lies beneath them.
    Only(Vec<String>),
    /// Every path but these, what lies beneath them and their ancestors.
    Omit(Vec<String>),
}

/// The refusal of a `$text` search by a caller that cannot read every field.
pub const TEXT_SEARCH_DENIED: &str = "$text is not available when some fields are not readable";

fn unique(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for path in paths {
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// Keeps the outermost of paths that contain each other: `profile` covers `profile.name`.
fn prune_descendants(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let unique = unique(paths);
    unique
        .iter()
        .filter(|path| !unique.iter().any(|other| other != *path && is_within(path, other)))
        .cloned()
        .collect()
}

fn from_rule(rule: &FieldRule) -> FieldAccess {
    match rule {
        FieldRule::Only(paths) if paths.iter().any(|path| path == "*") => FieldAccess::All,
        FieldRule::Only(paths) => FieldAccess::Only(prune_descendants(paths.iter().cloned())),
        FieldRule::Omit(paths) if paths.is_empty() => FieldAccess::All,
        FieldRule::Omit(paths) => FieldAccess::Omit(prune_descendants(paths.iter().cloned())),
    }
}

fn union(a: FieldAccess, b: FieldAccess) -> FieldAccess {
    match (a, b) {
        (FieldAccess::All, _) | (_, FieldAccess::All) => FieldAccess::All,
        (FieldAccess::Only(a), FieldAccess::Only(b)) => {
            FieldAccess::Only(prune_descendants(a.into_iter().chain(b)))
        }
        (FieldAccess::Omit(a), FieldAccess::Omit(b)) => {
            let mut hidden: Vec<String> = Vec::new();
            for x in &a {
                for y in &b {
                    let path = if is_within(x, y) {
                        x
                    } else if is_within(y, x) {
                        y
                    } else {
                        continue;
                    };
                    if !hidden.contains(path) {
                        hidden.push(path.clone());
                    }
                }
            }
            if hidden.is_empty() { FieldAccess::All } else { FieldAccess::Omit(prune_descendants(hidden)) }
        }
        (FieldAccess::Only(only), FieldAccess::Omit(omit))
        | (FieldAccess::Omit(omit), FieldAccess::Only(only)) => {
            let hidden: Vec<String> =
                omit.into_iter().filter(|x| !only.iter().any(|allowed| is_within(x, allowed))).collect();
            if hidden.is_empty() { FieldAccess::All } else { FieldAccess::Omit(prune_descendants(hidden)) }
        }
    }
}

fn rule_for<'a>(rules: &'a FieldRules, role: &str) -> Option<&'a FieldRule> {
    rules.iter().find(|(name, _)| name == role).map(|(_, rule)| rule)
}

/// Combines the field rules of every role in the request. A role without an entry uses `default`; without a
/// `default` it may access every field. The combination is a union. When an `only` rule of one role reaches
/// inside a field another role omits as a whole, the field stays hidden: the combination never grants more
/// than either rule.
pub fn field_access(rules: Option<&FieldRules>, roles: &Roles) -> FieldAccess {
    let Some(rules) = rules else { return FieldAccess::All };
    let mut access: Option<FieldAccess> = None;
    for role in roles.iter() {
        let rule = rule_for(rules, role).or_else(|| rule_for(rules, "default"));
        let next = rule.map_or(FieldAccess::All, from_rule);
        access = Some(match access {
            None => next,
            Some(current) => union(current, next),
        });
    }
    access.unwrap_or_else(|| rule_for(rules, "default").map_or(FieldAccess::All, from_rule))
}

/// Returns true when `path` may be read or written under `access`. Under `only`, the path must equal an
/// allowed path or lie beneath one. Under `omit`, it must not equal, lie beneath or be an ancestor of a hidden
/// path, because reading or writing `profile` as a whole touches `profile.ssn`. Array index segments are
/// ignored. `_id` is always accessible.
pub fn can_access(access: &FieldAccess, path: &str) -> bool {
    let paths = match access {
        FieldAccess::All => return true,
        FieldAccess::Only(paths) | FieldAccess::Omit(paths) => paths,
    };
    let normalized = strip_indexes(path);
    if normalized == "_id" {
        return true;
    }
    match access {
        FieldAccess::Only(_) => paths.iter().any(|allowed| is_within(&normalized, allowed)),
        _ => !paths.iter().any(|hidden| paths_overlap(&normalized, hidden)),
    }
}

/// Returns the paths in `paths` that `access` does not allow.
pub fn denied_paths(access: &FieldAccess, paths: &[String]) -> Vec<String> {
    paths.iter().filter(|path| !can_access(access, path)).cloned().collect()
}

/// Returns the written paths that touch an immutable path: equal to it, beneath it or an ancestor of it. Array
/// indexes are ignored, so `lines.0.sku` touches an immutable `lines.sku`.
pub fn immutable_violations(written: &[String], immutable: &[String]) -> Vec<String> {
    let frozen: Vec<String> = immutable.iter().map(|path| strip_indexes(path)).collect();
    written
        .iter()
        .filter(|path| {
            let stripped = strip_indexes(path);
            frozen.iter().any(|field| paths_overlap(&stripped, field))
        })
        .cloned()
        .collect()
}

/// Whether a filter's `$text` search is out of reach for `access`. A text index may cover fields the caller
/// cannot read, and `$text` names none of them, so it is allowed only when every field is readable.
pub fn denies_text_search(access: &FieldAccess, filter: &Document) -> bool {
    *access != FieldAccess::All && filter.contains_key("$text")
}

/// Removes every field `access` does not allow from a document. `_id` is always kept.
pub fn project_readable(access: &FieldAccess, document: &Document) -> Result<Document, CanopyError> {
    match access {
        FieldAccess::All => Ok(document.clone()),
        FieldAccess::Only(paths) => Ok(inclusion(paths.clone(), true)?.apply(DocRef::Owned(document))),
        FieldAccess::Omit(paths) => Ok(exclusion(paths.clone(), true)?.apply(DocRef::Owned(document))),
    }
}

fn flags(paths: &[String], flag: i32) -> Document {
    js_document(paths.iter().map(|path| (path.clone(), Value::Int32(flag))).collect())
}

/// Expresses `access` as one MongoDB projection, for push down. Returns `None` when every field is readable.
pub fn to_projection(access: &FieldAccess) -> Option<Document> {
    match access {
        FieldAccess::All => None,
        FieldAccess::Only(paths) => Some(flags(paths, 1)),
        FieldAccess::Omit(paths) => Some(flags(paths, 0)),
    }
}

fn outermost(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter(|path| !paths.iter().any(|other| other != *path && is_within(path, other)))
        .cloned()
        .collect()
}

/// Intersects a caller's projection (fields mapped to 0 or 1) with the readable fields. Returns the projection
/// to send to MongoDB, or `None` when no projection is needed. Fields outside `readable` are also stripped in
/// process by [`project_readable`], so the intersection only needs to be safe, not minimal.
pub fn intersect_projection(user: Option<&Document>, readable: &FieldAccess) -> Option<Document> {
    let Some(user) = user else { return to_projection(readable) };
    let is = |path: &str, flag: f64| user.get(path).and_then(js_number) == Some(flag);
    let user_paths: Vec<String> =
        js_keys(user).into_iter().filter(|path| *path != "_id").map(str::to_owned).collect();
    let user_include = user_paths.iter().any(|path| is(path, 1.0));
    let with_id = |mut out: Document| {
        if is("_id", 0.0) {
            out.insert("_id", Value::Int32(0));
        }
        out
    };
    let id_only = || -> Document { [("_id".to_owned(), Value::Int32(1))].into_iter().collect() };
    match readable {
        FieldAccess::All => {
            Some(js_fields(user).into_iter().map(|(key, value)| (key.to_owned(), value.clone())).collect())
        }
        _ if user_include => {
            let mut kept: Vec<String> = user_paths
                .iter()
                .filter(|path| is(path, 1.0) && can_access(readable, path))
                .cloned()
                .collect();
            if let FieldAccess::Only(allowed_paths) = readable {
                for allowed in allowed_paths {
                    if user_paths.iter().any(|path| is(path, 1.0) && is_within(allowed, path))
                        && !kept.contains(allowed)
                    {
                        kept.push(allowed.clone());
                    }
                }
            }
            let pruned = outermost(&kept);
            if pruned.is_empty() { Some(id_only()) } else { Some(with_id(flags(&pruned, 1))) }
        }
        FieldAccess::Omit(hidden) => {
            let excluded = unique(user_paths.iter().cloned().chain(hidden.iter().cloned()));
            Some(with_id(flags(&outermost(&excluded), 0)))
        }
        FieldAccess::Only(allowed) => {
            let kept: Vec<String> = allowed
                .iter()
                .filter(|path| !user_paths.iter().any(|hidden| is_within(path, hidden)))
                .cloned()
                .collect();
            if kept.is_empty() { Some(id_only()) } else { Some(with_id(flags(&kept, 1))) }
        }
    }
}

/// Lists the top level fields of a document, which is what an insert or a replacement writes.
pub fn document_paths(document: &Document) -> Vec<String> {
    js_fields(document)
        .into_iter()
        .filter(|(_, value)| !matches!(value, Value::Undefined))
        .map(|(key, _)| key.to_owned())
        .collect()
}
