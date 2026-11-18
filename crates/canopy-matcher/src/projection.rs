//! MongoDB inclusion and exclusion projections over documents.

use std::collections::HashMap;

use canopy_protocol::{ArrayRef, CanopyError, DocRef, Document, Value, ValueRef};

use crate::errors::unsupported_query;
use crate::numeric::{read_numeric, to_double};
use crate::path::split_path;

/// A projection tree: a leaf marks a projected path, a branch marks a projected sub path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionNode {
    /// The whole field is projected.
    Leaf,
    /// Some sub paths of the field are projected.
    Branch(HashMap<String, ProjectionNode>),
}

/// Whether a projection keeps or removes its paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionMode {
    /// Keeps only the listed paths.
    Include,
    /// Removes the listed paths.
    Exclude,
}

/// A compiled projection.
#[derive(Debug, Clone)]
pub struct CompiledProjection {
    mode: ProjectionMode,
    include_id: bool,
    paths: Vec<String>,
    tree: HashMap<String, ProjectionNode>,
}

impl CompiledProjection {
    /// Whether the projection keeps or removes its paths.
    pub fn mode(&self) -> ProjectionMode {
        self.mode
    }

    /// Whether `_id` is part of the result.
    pub fn include_id(&self) -> bool {
        self.include_id
    }

    /// The projected paths, without `_id`.
    pub fn paths(&self) -> &[String] {
        &self.paths
    }

    /// Applies the projection, returning a new document.
    pub fn apply(&self, document: DocRef<'_>) -> Document {
        let mut out = match self.mode {
            ProjectionMode::Include => include_document(document, &self.tree),
            ProjectionMode::Exclude => exclude_document(document, &self.tree),
        };
        if !self.include_id {
            out.remove("_id");
        }
        out
    }
}

fn flag(path: &str, value: &Value) -> Result<bool, CanopyError> {
    if let Value::Bool(on) = value {
        return Ok(*on);
    }
    if let Some(number) = read_numeric(value.view()) {
        return Ok(to_double(number) != 0.0);
    }
    if matches!(value, Value::Document(_) | Value::String(_)) {
        return Err(unsupported_query(format!("The projection of {path} is not evaluated in process")));
    }
    Err(CanopyError::invalid_query(format!("Invalid projection value for {path}")))
}

/// Builds a tree from dotted paths. Fails when one path is a prefix of another (a path collision).
pub fn build_tree<S: AsRef<str>>(paths: &[S]) -> Result<HashMap<String, ProjectionNode>, CanopyError> {
    let mut root = HashMap::new();
    for path in paths {
        let path = path.as_ref();
        let parts = split_path(path);
        if parts.iter().any(|part| part.is_empty() || part.starts_with('$')) {
            return Err(CanopyError::invalid_query(format!("Invalid projection path: {path}")));
        }
        let collision = || CanopyError::invalid_query(format!("Path collision at {path}"));
        let mut node = &mut root;
        let last = parts.len() - 1;
        for (index, part) in parts.into_iter().enumerate() {
            if index == last {
                if node.contains_key(&part) {
                    return Err(collision());
                }
                node.insert(part, ProjectionNode::Leaf);
                break;
            }
            let child = node.entry(part).or_insert_with(|| ProjectionNode::Branch(HashMap::new()));
            node = match child {
                ProjectionNode::Leaf => return Err(collision()),
                ProjectionNode::Branch(children) => children,
            };
        }
    }
    Ok(root)
}

fn include_value(value: ValueRef<'_>, tree: &HashMap<String, ProjectionNode>) -> Option<Value> {
    match value {
        ValueRef::Document(document) => Some(Value::Document(include_document(document, tree))),
        ValueRef::Array(items) => Some(Value::Array(include_array(items, tree))),
        _ => None,
    }
}

fn include_array(items: ArrayRef<'_>, tree: &HashMap<String, ProjectionNode>) -> Vec<Value> {
    items.iter().filter_map(|element| include_value(element, tree)).collect()
}

fn include_document(document: DocRef<'_>, tree: &HashMap<String, ProjectionNode>) -> Document {
    let mut out = Document::new();
    for (name, value) in document.iter() {
        match tree.get(name) {
            None => {}
            Some(ProjectionNode::Leaf) => out.insert(name, value.to_value()),
            Some(ProjectionNode::Branch(children)) => {
                if let Some(projected) = include_value(value, children) {
                    out.insert(name, projected);
                }
            }
        }
    }
    out
}

fn exclude_value(value: ValueRef<'_>, tree: &HashMap<String, ProjectionNode>) -> Value {
    match value {
        ValueRef::Document(document) => Value::Document(exclude_document(document, tree)),
        ValueRef::Array(items) => {
            Value::Array(items.iter().map(|element| exclude_value(element, tree)).collect())
        }
        other => other.to_value(),
    }
}

fn exclude_document(document: DocRef<'_>, tree: &HashMap<String, ProjectionNode>) -> Document {
    let mut out = Document::new();
    for (name, value) in document.iter() {
        match tree.get(name) {
            Some(ProjectionNode::Leaf) => {}
            None => out.insert(name, value.to_value()),
            Some(ProjectionNode::Branch(children)) => out.insert(name, exclude_value(value, children)),
        }
    }
    out
}

/// Compiles a projection such as `{ title: 1, "owner.name": 1 }` or `{ secret: 0 }`.
pub fn compile_projection(spec: &Value) -> Result<CompiledProjection, CanopyError> {
    let Value::Document(spec) = spec else {
        return Err(CanopyError::invalid_query("A projection must be a document"));
    };
    let mut include_id = true;
    let mut included = Vec::new();
    let mut excluded = Vec::new();
    for (path, value) in spec.iter() {
        let on = flag(path, value)?;
        if path == "_id" {
            include_id = on;
        } else if on {
            included.push(path.to_owned());
        } else {
            excluded.push(path.to_owned());
        }
    }
    if spec.contains_key("_id") {
        if let Some(nested) = included.iter().chain(&excluded).find(|path| path.starts_with("_id.")) {
            return Err(CanopyError::invalid_query(format!("Path collision at {nested}")));
        }
    }
    if !included.is_empty() && !excluded.is_empty() {
        return Err(CanopyError::invalid_query("Cannot mix inclusion and exclusion in a projection"));
    }
    if included.is_empty() { exclusion(excluded, include_id) } else { inclusion(included, include_id) }
}

/// Builds an inclusion projection from paths.
pub fn inclusion(paths: Vec<String>, include_id: bool) -> Result<CompiledProjection, CanopyError> {
    let with_id = include_id && !paths.iter().any(|path| path == "_id" || path.starts_with("_id."));
    let tree = if with_id {
        let mut all: Vec<&str> = paths.iter().map(String::as_str).collect();
        all.push("_id");
        build_tree(&all)?
    } else {
        build_tree(&paths)?
    };
    Ok(CompiledProjection { mode: ProjectionMode::Include, include_id, paths, tree })
}

/// Builds an exclusion projection from paths.
pub fn exclusion(paths: Vec<String>, include_id: bool) -> Result<CompiledProjection, CanopyError> {
    let tree = build_tree(&paths)?;
    Ok(CompiledProjection { mode: ProjectionMode::Exclude, include_id, paths, tree })
}
