//! Deterministic generated tests of the DLS invariants that hold inside the policy engine:
//!
//! * I1: a non service read never matches a document that fails `USING(read)`.
//! * I2: a non service write never accepts a document that fails `CHECK(op)`, and never changes an
//!   immutable path.
//! * I3: a projected document never holds a field outside `readable(roles)`.
//! * I5: a variable that cannot be resolved denies: a permissive policy drops out, a restrictive one denies
//!   the operation.
//! * I6: no claim or context value appears in variable issues, their descriptions or explain reasons.
//!
//! The expected decisions come from a reference written from the DLS rules (permissive policies combine with
//! OR, restrictive ones with AND, `check` falls back to `using`, a policy without a clause matches every
//! document, `service` bypasses), evaluated policy by policy, never from the engine's own composition.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use canopy_matcher::compile_filter;
use canopy_policy::{
    Clause, CollectionFields, CollectionPolicies, Compiled, ContextLookup, EngineHooks, FieldAccess,
    FieldKind, FieldRule, Operation, PolicyDefinition, PolicyEngine, PolicyKind, PolicyVariableIssue,
    RequestContext, Resolution, Roles, create_policy_set, describe_issue, immutable_violations,
    project_readable, resolve_clause,
};
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{Document, Value};
use canopy_query::js_property_order;

const NOW: i64 = 1_793_962_800_000;
const DAY: i64 = 86_400_000;
const COLLECTION: &str = "items";
const SECRET: &str = "s3cr3t-claim-value";

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % n as u64).unwrap()
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    fn subset<T: Clone>(&mut self, items: &[T]) -> Vec<T> {
        loop {
            let chosen: Vec<T> = items.iter().filter(|_| self.chance(40)).cloned().collect();
            if !chosen.is_empty() {
                return chosen;
            }
        }
    }
}

fn document(source: &str) -> Document {
    match js_property_order(&parse(source, DecodeOptions::default()).expect("EJSON")) {
        Value::Document(document) => document,
        other => panic!("expected a document, got {other:?}"),
    }
}

fn strings(items: &[&str]) -> Value {
    Value::Array(items.iter().map(|item| Value::String((*item).to_owned())).collect())
}

const USING: [&str; 10] = [
    r#"{"owner": {"$auth": "sub"}}"#,
    r#"{"org": {"$in": {"$auth": "orgs"}}}"#,
    r#"{"level": {"$lte": {"$auth": "level"}}}"#,
    r#"{"published": true}"#,
    r#"{"team": {"$in": {"$ctx": "teams"}}}"#,
    r#"{"createdAt": {"$gte": {"$now": {"offset": "-P1D"}}}}"#,
    r#"{"level": {"$gte": {"$numberInt": "1"}}}"#,
    r#"{"$or": [{"owner": {"$auth": "sub"}}, {"published": true}]}"#,
    r#"{"owner": {"$auth": "profile.id"}}"#,
    r#"{"level": {"$lt": {"$auth": "level", "as": "number"}}}"#,
];

const CHECK: [&str; 5] = [
    r#"{"owner": {"$auth": "sub"}}"#,
    r#"{"level": {"$lte": {"$numberInt": "2"}}}"#,
    r#"{"org": {"$in": {"$auth": "orgs"}}}"#,
    r#"{"published": {"$ne": true}}"#,
    r#"{"team": {"$in": {"$ctx": "teams"}}}"#,
];

const ROLES: [&str; 5] = ["authenticated", "anon", "public", "editor", "auditor"];

fn policy(rng: &mut Rng, index: usize) -> PolicyDefinition {
    let ops = rng.subset(&Operation::ALL);
    let using = (ops.iter().any(|op| op.uses_using()) && rng.chance(80)).then(|| document(rng.pick(&USING)));
    let check = (ops.iter().any(|op| op.uses_check()) && rng.chance(60)).then(|| document(rng.pick(&CHECK)));
    PolicyDefinition {
        name: format!("p{index}"),
        kind: if rng.chance(70) { PolicyKind::Permissive } else { PolicyKind::Restrictive },
        ops,
        roles: rng.subset(&ROLES).into_iter().map(str::to_owned).collect(),
        using,
        check,
    }
}

fn field_rule(rng: &mut Rng) -> FieldRule {
    let only = |paths: &[&str]| FieldRule::Only(paths.iter().map(|path| (*path).to_owned()).collect());
    let omit = |paths: &[&str]| FieldRule::Omit(paths.iter().map(|path| (*path).to_owned()).collect());
    match rng.below(7) {
        0 => only(&["title", "profile.name", "owner"]),
        1 => omit(&["secret", "profile.ssn"]),
        2 => only(&["*"]),
        3 => omit(&[]),
        4 => only(&["profile"]),
        5 => omit(&["profile"]),
        _ => only(&["title", "lines.sku"]),
    }
}

fn collection(rng: &mut Rng) -> CollectionPolicies {
    let count = 1 + rng.below(5);
    let mut def = CollectionPolicies::new(COLLECTION);
    def.exposed = rng.chance(92);
    def.realtime = rng.chance(50);
    def.policies = (0..count).map(|index| policy(rng, index)).collect();
    if rng.chance(80) {
        let mut rules = Vec::new();
        for role in ["default", "authenticated", "anon", "editor", "auditor"] {
            if rng.chance(45) {
                rules.push((role.to_owned(), field_rule(rng)));
            }
        }
        def.fields = Some([(FieldKind::Read, rules)].into_iter().collect::<CollectionFields>());
    }
    def
}

fn contexts() -> Vec<(String, ContextLookup)> {
    vec![(
        "teams".to_owned(),
        ContextLookup {
            from: "memberships".to_owned(),
            filter: document(r#"{"userId": {"$auth": "sub"}}"#),
            select: "teamId".to_owned(),
            max: 100.0,
            ttl: "30s".to_owned(),
        },
    )]
}

fn claims(rng: &mut Rng) -> Document {
    let mut claims = Document::new();
    match rng.below(6) {
        0 => {}
        1 => claims.insert("sub", Value::Null),
        2 => claims.insert("sub", strings(&[SECRET])),
        3 => claims
            .insert("sub", Value::Document([("token".to_owned(), strings(&[SECRET]))].into_iter().collect())),
        _ => claims.insert("sub", Value::String((*rng.pick(&["u1", "u2"])).to_owned())),
    }
    match rng.below(5) {
        0 => {}
        1 => claims.insert("orgs", Value::String(SECRET.to_owned())),
        2 => claims.insert("orgs", Value::Array(vec![Value::Document(Document::new())])),
        _ => claims.insert("orgs", strings(&rng.subset(&["o1", "o2", "o3"]))),
    }
    match rng.below(5) {
        0 => {}
        1 => claims.insert("level", Value::String(SECRET.to_owned())),
        2 => claims.insert("level", Value::String("2".to_owned())),
        _ => claims.insert("level", Value::Int32(i32::try_from(rng.below(4)).unwrap())),
    }
    if rng.chance(40) {
        claims.insert(
            "profile",
            Value::Document([("id".to_owned(), Value::String("u1".to_owned()))].into_iter().collect()),
        );
    }
    claims
}

fn request(rng: &mut Rng) -> RequestContext {
    if rng.chance(5) {
        return RequestContext {
            roles: ["service"].into_iter().collect(),
            claims: None,
            ctx: None,
            now: NOW,
        };
    }
    let authenticated = rng.chance(75);
    let mut roles = Roles::new();
    roles.insert(if authenticated { "authenticated" } else { "anon" });
    for custom in ["editor", "auditor"] {
        if rng.chance(30) {
            roles.insert(custom);
        }
    }
    let ctx = match rng.below(4) {
        0 => None,
        1 => Some(Document::new()),
        2 => Some([("teams".to_owned(), Value::String(SECRET.to_owned()))].into_iter().collect()),
        _ => Some([("teams".to_owned(), strings(&rng.subset(&["t1", "t2"])))].into_iter().collect()),
    };
    RequestContext { roles, claims: authenticated.then(|| claims(rng)), ctx, now: NOW }
}

fn generated_document(rng: &mut Rng, id: i32) -> Document {
    let mut doc = Document::new();
    doc.insert("_id", Value::Int32(id));
    if rng.chance(80) {
        doc.insert("owner", Value::String((*rng.pick(&["u1", "u2", "u3"])).to_owned()));
    }
    if rng.chance(80) {
        doc.insert("org", Value::String((*rng.pick(&["o1", "o2", "o3"])).to_owned()));
    }
    if rng.chance(80) {
        doc.insert("level", Value::Int32(i32::try_from(rng.below(4)).unwrap()));
    }
    if rng.chance(60) {
        doc.insert("published", Value::Bool(rng.chance(50)));
    }
    if rng.chance(70) {
        doc.insert("team", Value::String((*rng.pick(&["t1", "t2", "t3"])).to_owned()));
    }
    if rng.chance(70) {
        let offset = i64::try_from(rng.below(5)).unwrap() - 3;
        doc.insert("createdAt", Value::DateTime(NOW + offset * DAY / 2));
    }
    if rng.chance(70) {
        doc.insert("title", Value::String("t".to_owned()));
    }
    if rng.chance(60) {
        doc.insert("secret", Value::String("x".to_owned()));
    }
    let profile = || -> Document {
        [
            ("name".to_owned(), Value::String("n".to_owned())),
            ("ssn".to_owned(), Value::String("s".to_owned())),
        ]
        .into_iter()
        .collect()
    };
    match rng.below(5) {
        0 => {}
        1 => doc.insert("profile", Value::Document(profile())),
        2 => doc.insert("profile", Value::Array(vec![Value::Document(profile()), Value::Int32(1)])),
        3 => doc.insert("profile", Value::String("flat".to_owned())),
        _ => doc.insert("profile", Value::Document(Document::new())),
    }
    if rng.chance(40) {
        let line: Document =
            [("sku".to_owned(), Value::String("a".to_owned())), ("price".to_owned(), Value::Int32(3))]
                .into_iter()
                .collect();
        doc.insert("lines", Value::Array(vec![Value::Document(line)]));
    }
    doc
}

fn grants(policy: &PolicyDefinition, ctx: &RequestContext) -> bool {
    policy.roles.iter().any(|role| role == "public" || ctx.roles.contains(role))
}

/// Whether a policy's clause holds for a document: `None` when a variable cannot be resolved.
fn holds(policy: &PolicyDefinition, clause: Clause, ctx: &RequestContext, doc: &Document) -> Option<bool> {
    let chosen = match clause {
        Clause::Using => policy.using.clone(),
        Clause::Check => policy.check.clone().or_else(|| policy.using.clone()),
    };
    let Some(chosen) = chosen else { return Some(true) };
    match resolve_clause(&chosen, ctx).expect("validated clauses resolve") {
        Resolution::Resolved(filter) => {
            Some(compile_filter(&Value::Document(filter)).expect("matcher").matches(doc).unwrap_or(false))
        }
        Resolution::Unresolvable(_) => None,
    }
}

fn reference(
    def: &CollectionPolicies,
    op: Operation,
    clause: Clause,
    ctx: &RequestContext,
    doc: &Document,
) -> bool {
    if ctx.is_service() {
        return true;
    }
    if !def.exposed {
        return false;
    }
    let applicable = |kind: PolicyKind| {
        def.policies
            .iter()
            .filter(move |policy| policy.kind == kind && policy.ops.contains(&op) && grants(policy, ctx))
    };
    applicable(PolicyKind::Permissive).any(|policy| holds(policy, clause, ctx, doc) == Some(true))
        && applicable(PolicyKind::Restrictive).all(|policy| holds(policy, clause, ctx, doc) == Some(true))
}

fn decide(compiled: &Compiled, doc: &Document) -> bool {
    compiled.matcher().expect("compiled filters are matcher safe").matches(doc).unwrap_or(false)
}

#[derive(Default)]
struct Recorder {
    issues: Mutex<Vec<PolicyVariableIssue>>,
    errors: Mutex<usize>,
}

struct Hooks(Arc<Recorder>);

impl EngineHooks for Hooks {
    fn on_variable_issue(&self, issue: &PolicyVariableIssue) {
        self.0.issues.lock().unwrap().push(issue.clone());
    }

    fn on_evaluation_error(&self, _error: &canopy_protocol::CanopyError, _collection: &str, _op: Operation) {
        *self.0.errors.lock().unwrap() += 1;
    }
}

const USER_FILTERS: [&str; 4] = [
    "{}",
    r#"{"level": {"$gt": {"$numberInt": "0"}}}"#,
    r#"{"$or": [{"published": true}, {"owner": "u2"}]}"#,
    r#"{"owner": {"$exists": false}}"#,
];

#[derive(Default)]
struct Tally {
    sets: usize,
    decisions: usize,
    allowed: usize,
    denied: usize,
    bypasses: Vec<String>,
    over_denials: Vec<String>,
    leaks: Vec<String>,
}

fn count_decision(tally: &mut Tally, label: impl Fn() -> String, engine: bool, expected: bool) {
    tally.decisions += 1;
    if expected {
        tally.allowed += 1;
    } else {
        tally.denied += 1;
    }
    if engine && !expected {
        tally.bypasses.push(label());
    } else if !engine && expected {
        tally.over_denials.push(label());
    }
}

fn leaves(prefix: &str, value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Document(document) if !document.is_empty() => {
            for (key, inner) in document.iter() {
                let path = if prefix.is_empty() { (*key).to_owned() } else { format!("{prefix}.{key}") };
                leaves(&path, inner, out);
            }
        }
        Value::Array(items) if !items.is_empty() => items.iter().for_each(|item| leaves(prefix, item, out)),
        Value::Document(_) | Value::Array(_) => {}
        _ => out.push(prefix.to_owned()),
    }
}

fn within(path: &str, base: &str) -> bool {
    path == base || path.strip_prefix(base).is_some_and(|rest| rest.starts_with('.'))
}

fn readable_leaf(access: &FieldAccess, leaf: &str) -> bool {
    match access {
        FieldAccess::All => true,
        _ if leaf == "_id" => true,
        FieldAccess::Only(paths) => paths.iter().any(|allowed| within(leaf, allowed)),
        FieldAccess::Omit(paths) => !paths.iter().any(|hidden| within(leaf, hidden)),
    }
}

fn rule_allows(rule: Option<&FieldRule>, leaf: &str) -> bool {
    match rule {
        None => true,
        Some(FieldRule::Only(paths)) => {
            leaf == "_id" || paths.iter().any(|allowed| allowed == "*" || within(leaf, allowed))
        }
        Some(FieldRule::Omit(paths)) => leaf == "_id" || !paths.iter().any(|hidden| within(leaf, hidden)),
    }
}

#[test]
fn generated_policy_sets_keep_the_invariants() {
    let mut rng = Rng(20_261_118);
    let mut tally = Tally::default();
    while tally.sets < 400 {
        let def = collection(&mut rng);
        let Ok(set) = create_policy_set(vec![def.clone()], contexts()) else { continue };
        tally.sets += 1;
        let recorder = Arc::new(Recorder::default());
        let engine = PolicyEngine::with_hooks(set, Box::new(Hooks(Arc::clone(&recorder))));
        let docs: Vec<Document> = (0..12).map(|id| generated_document(&mut rng, id)).collect();
        for _ in 0..6 {
            let ctx = request(&mut rng);
            let user_filter = document(rng.pick(&USER_FILTERS));
            let user_matcher = compile_filter(&Value::Document(user_filter.clone())).expect("user filter");
            let read = engine.using(COLLECTION, Operation::Read, &ctx);
            let effective = engine.effective_read(COLLECTION, &user_filter, &ctx).expect("and");
            for op in Operation::ALL {
                let using = engine.using(COLLECTION, op, &ctx);
                let check = engine.check(COLLECTION, op, &ctx);
                let target = engine.target(COLLECTION, op, &ctx).expect("and");
                for doc in &docs {
                    let label = |what: &str| {
                        let what = what.to_owned();
                        let ctx = ctx.clone();
                        let def = def.clone();
                        let doc = doc.clone();
                        move || {
                            format!(
                                "{what} {op} for {ctx:?}\n  policies {:?}\n  document {doc:?}",
                                def.policies
                            )
                        }
                    };
                    let expected_using = reference(&def, op, Clause::Using, &ctx, doc);
                    count_decision(&mut tally, label("USING"), decide(&using, doc), expected_using);
                    if op.uses_check() {
                        let expected_check = reference(&def, op, Clause::Check, &ctx, doc);
                        count_decision(&mut tally, label("CHECK"), decide(&check, doc), expected_check);
                    }
                    let expected_read = reference(&def, Operation::Read, Clause::Using, &ctx, doc);
                    if op != Operation::Insert {
                        count_decision(
                            &mut tally,
                            label("target"),
                            decide(&target, doc),
                            expected_using && expected_read,
                        );
                    }
                    if op == Operation::Read {
                        let expected = expected_read && user_matcher.matches(doc).unwrap_or(false);
                        count_decision(
                            &mut tally,
                            label("effective read"),
                            decide(&effective, doc),
                            expected,
                        );
                        if decide(&read, doc) != expected_read {
                            tally.bypasses.push(label("read")());
                        }
                    }
                }
            }
            let readable = engine.readable(COLLECTION, &ctx);
            let rules = def.fields.as_ref().and_then(|fields| fields.get(FieldKind::Read));
            for doc in &docs {
                let projected = project_readable(&readable, doc).expect("projection");
                if projected.get("_id") != doc.get("_id") {
                    tally.leaks.push(format!("_id dropped from {doc:?} under {readable:?}"));
                }
                let mut found = Vec::new();
                leaves("", &Value::Document(projected.clone()), &mut found);
                for leaf in found {
                    let by_roles = ctx.is_service()
                        || ctx.roles.iter().any(|role| {
                            let rule = rules.and_then(|rules| {
                                rules
                                    .iter()
                                    .find(|(name, _)| name == role)
                                    .or_else(|| rules.iter().find(|(name, _)| name == "default"))
                                    .map(|(_, rule)| rule)
                            });
                            rule_allows(rule, &leaf)
                        });
                    if !readable_leaf(&readable, &leaf) || !by_roles {
                        tally.leaks.push(format!(
                            "{leaf} of {projected:?} is outside {readable:?} (roles {:?})",
                            ctx.roles
                        ));
                    }
                }
            }
            for issue in recorder.issues.lock().unwrap().iter() {
                let text = format!(
                    "{issue:?} {}",
                    describe_issue(&canopy_policy::VariableIssue {
                        kind: issue.kind,
                        variable: issue.variable.clone(),
                    })
                );
                assert!(!text.contains(SECRET), "a variable issue carries a claim value: {text}");
            }
            for op in Operation::ALL {
                for clause in [Clause::Using, Clause::Check] {
                    let explanation = engine.explain(COLLECTION, op, &ctx, clause).expect("explain");
                    for policy in &explanation.policies {
                        assert!(!policy.reason.contains(SECRET), "an explain reason carries a claim value");
                    }
                }
            }
        }
        assert_eq!(*recorder.errors.lock().unwrap(), 0, "validated policies never fail to evaluate");
    }
    let report = |name: &str, found: &[String]| {
        format!(
            "{} {name} of {} decisions, first:\n{}",
            found.len(),
            tally.decisions,
            found.first().cloned().unwrap_or_default()
        )
    };
    assert!(tally.bypasses.is_empty(), "{}", report("bypasses", &tally.bypasses));
    assert!(tally.over_denials.is_empty(), "{}", report("over denials", &tally.over_denials));
    assert!(
        tally.leaks.is_empty(),
        "{} unreadable fields projected, first: {}",
        tally.leaks.len(),
        tally.leaks[0]
    );
    assert!(tally.decisions > 100_000, "too few decisions: {}", tally.decisions);
    assert!(tally.allowed > tally.decisions / 20, "too few allowed decisions: {}", tally.allowed);
    assert!(tally.denied > tally.decisions / 20, "too few denied decisions: {}", tally.denied);
}

fn single(policies: Vec<PolicyDefinition>) -> (PolicyEngine, Arc<Recorder>) {
    let mut def = CollectionPolicies::new(COLLECTION);
    def.exposed = true;
    def.policies = policies;
    let recorder = Arc::new(Recorder::default());
    let set = create_policy_set(vec![def], contexts()).expect("valid set");
    (PolicyEngine::with_hooks(set, Box::new(Hooks(Arc::clone(&recorder)))), recorder)
}

fn read_policy(name: &str, kind: PolicyKind, using: Option<&str>) -> PolicyDefinition {
    PolicyDefinition {
        name: name.to_owned(),
        kind,
        ops: vec![Operation::Read],
        roles: vec!["authenticated".to_owned()],
        using: using.map(document),
        check: None,
    }
}

fn user(claims: &str) -> RequestContext {
    RequestContext {
        roles: ["authenticated"].into_iter().collect(),
        claims: Some(document(claims)),
        ctx: None,
        now: NOW,
    }
}

#[test]
fn a_missing_variable_drops_a_permissive_policy() {
    let (engine, recorder) =
        single(vec![read_policy("own", PolicyKind::Permissive, Some(r#"{"owner": {"$auth": "sub"}}"#))]);
    assert_eq!(engine.using(COLLECTION, Operation::Read, &user("{}")), Compiled::Deny);
    assert_eq!(engine.using(COLLECTION, Operation::Read, &user(r#"{"sub": null}"#)), Compiled::Deny);
    let issues = recorder.issues.lock().unwrap();
    assert_eq!(issues.len(), 2);
    assert!(issues.iter().all(|issue| issue.variable == "$auth:sub" && issue.policy == "own"));
}

#[test]
fn an_unresolvable_restrictive_policy_denies_even_beside_an_open_permissive_one() {
    let (engine, _) = single(vec![
        read_policy("everyone", PolicyKind::Permissive, None),
        read_policy("tenant", PolicyKind::Restrictive, Some(r#"{"org": {"$in": {"$auth": "orgs"}}}"#)),
    ]);
    assert_eq!(engine.using(COLLECTION, Operation::Read, &user(r#"{"orgs": "o1"}"#)), Compiled::Deny);
    assert_eq!(engine.using(COLLECTION, Operation::Read, &user("{}")), Compiled::Deny);
    let allowed = engine.using(COLLECTION, Operation::Read, &user(r#"{"orgs": ["o1"]}"#));
    assert_eq!(allowed, Compiled::Filter(document(r#"{"org": {"$in": ["o1"]}}"#)));
}

#[test]
fn a_shape_issue_never_widens_a_list_operator() {
    let (engine, _) = single(vec![read_policy(
        "tenant",
        PolicyKind::Permissive,
        Some(r#"{"org": {"$nin": {"$auth": "blocked"}}}"#),
    )]);
    for claims in [r#"{"blocked": "o1"}"#, r#"{"blocked": [{"a": 1}]}"#, "{}", r#"{"blocked": [null]}"#] {
        assert_eq!(
            engine.using(COLLECTION, Operation::Read, &user(claims)),
            Compiled::Deny,
            "claims {claims}"
        );
    }
}

#[test]
fn immutable_paths_cannot_be_written_through_ancestors_descendants_or_indexes() {
    let immutable = vec!["owner".to_owned(), "meta.created".to_owned(), "lines.sku".to_owned()];
    let cases = [
        ("owner", true),
        ("owner.name", true),
        ("meta", true),
        ("meta.created", true),
        ("meta.created.at", true),
        ("meta.other", false),
        ("lines", true),
        ("lines.0.sku", true),
        ("lines.0", true),
        ("lines.0.price", false),
        ("ownerName", false),
        ("metadata", false),
        ("title", false),
    ];
    for (path, frozen) in cases {
        let found = immutable_violations(&[path.to_owned()], &immutable);
        assert_eq!(!found.is_empty(), frozen, "{path}");
    }
}

#[test]
fn service_bypasses_and_an_unexposed_collection_denies() {
    let mut def = CollectionPolicies::new(COLLECTION);
    def.policies = vec![read_policy("everyone", PolicyKind::Permissive, None)];
    let engine = PolicyEngine::new(create_policy_set(vec![def], contexts()).expect("valid set"));
    let service =
        RequestContext { roles: ["service"].into_iter().collect(), claims: None, ctx: None, now: NOW };
    assert_eq!(engine.using(COLLECTION, Operation::Read, &service), Compiled::All);
    assert_eq!(engine.using(COLLECTION, Operation::Read, &user("{}")), Compiled::Deny);
    assert_eq!(engine.using("unknown", Operation::Read, &user("{}")), Compiled::Deny);
    assert!(!engine.has_grant(COLLECTION, Operation::Read, &user("{}")));
}
