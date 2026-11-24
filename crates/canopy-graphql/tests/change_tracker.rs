//! Tests the changes emitted for successive GraphQL live query results.

#![allow(clippy::panic)]

use std::sync::Arc;

use canopy_graphql::execute::{ChangeKind, ChangeTracker, LiveChange};
use canopy_protocol::{Document, Value};

fn document(id: &str, title: &str) -> Arc<Document> {
    let mut doc = Document::new();
    doc.insert("_id", Value::String(id.to_owned()));
    doc.insert("title", Value::String(title.to_owned()));
    Arc::new(doc)
}

fn assert_change(
    change: &LiveChange,
    kind: ChangeKind,
    id: Option<&str>,
    doc: Option<&Arc<Document>>,
    index: Option<usize>,
) {
    assert_eq!(change.kind, kind);
    assert_eq!(change.id, id.map(|id| Value::String(id.to_owned())));
    assert_eq!(change.index, index);
    match (change.doc.as_ref(), doc) {
        (Some(actual), Some(expected)) => assert!(Arc::ptr_eq(actual, expected)),
        (None, None) => {}
        _ => panic!("unexpected document in {change:?}"),
    }
}

#[test]
fn first_result_adds_documents_in_result_order_then_emits_ready() {
    let mut tracker = ChangeTracker::default();
    let b = document("b", "Second by id");
    let a = document("a", "First by id");
    let changes = tracker.changes(&[Arc::clone(&b), Arc::clone(&a)]);

    let [first, second, ready] = changes.as_slice() else {
        panic!("expected two additions and ready, got {changes:?}");
    };
    assert_change(first, ChangeKind::Added, Some("b"), Some(&b), Some(0));
    assert_change(second, ChangeKind::Added, Some("a"), Some(&a), Some(1));
    assert_change(ready, ChangeKind::Ready, None, None, None);
}

#[test]
fn empty_initial_result_emits_ready_once() {
    let mut tracker = ChangeTracker::default();
    let changes = tracker.changes(&[]);
    let [ready] = changes.as_slice() else {
        panic!("expected ready, got {changes:?}");
    };
    assert_change(ready, ChangeKind::Ready, None, None, None);
    assert!(tracker.changes(&[]).is_empty());
}

#[test]
fn later_results_emit_removals_first_and_additions_and_changes_in_result_order() {
    let mut tracker = ChangeTracker::default();
    let a = document("a", "Moved");
    let b = document("b", "Removed first");
    let c = document("c", "Replaced");
    let d = document("d", "Unchanged");
    let e = document("e", "Removed second");
    let f = document("f", "Added");

    tracker.changes(&[Arc::clone(&a), b, Arc::clone(&c), Arc::clone(&d), e]);
    let replacement = Arc::new((*c).clone());
    let result = [Arc::clone(&f), Arc::clone(&a), Arc::clone(&replacement), d];
    let changes = tracker.changes(&result);

    let [removed_b, removed_e, added, moved, replaced] = changes.as_slice() else {
        panic!("expected two removals, one addition and two changes, got {changes:?}");
    };
    assert_change(removed_b, ChangeKind::Removed, Some("b"), None, Some(1));
    assert_change(removed_e, ChangeKind::Removed, Some("e"), None, Some(4));
    assert_change(added, ChangeKind::Added, Some("f"), Some(&f), Some(0));
    assert_change(moved, ChangeKind::Changed, Some("a"), Some(&a), Some(1));
    assert_change(replaced, ChangeKind::Changed, Some("c"), Some(&replacement), Some(2));
    assert!(tracker.changes(&result).is_empty());
}
