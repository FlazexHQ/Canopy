use super::*;
use crate::registry::referenced_top_fields;
use canopy_matcher::compile_filter;
use canopy_policy::{Clause, PolicyKind, can_access};

pub(super) struct Inspection {
    events: VecDeque<(Document, Document)>,
    tail: Option<InspectionTail>,
    history: VecDeque<Value>,
    last_sample: u64,
    sampled_events: u64,
    last_lag: u64,
    sequence: u64,
}

pub(crate) fn inspection_number(value: u64) -> Value {
    Value::Double(value as f64)
}

fn text(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

fn date(value: u64) -> Value {
    Value::DateTime(i64::try_from(value).unwrap_or(i64::MAX))
}

fn base36(mut value: u64) -> String {
    let mut digits = Vec::new();
    loop {
        if let Some(digit) = char::from_digit((value % 36) as u32, 36) {
            digits.push(digit);
        }
        value /= 36;
        if value == 0 {
            return digits.into_iter().rev().collect();
        }
    }
}

impl Inspection {
    pub(super) fn record(
        &mut self,
        node: &str,
        version: &str,
        event: &Event,
        candidates: Vec<Value>,
        now: u64,
    ) {
        self.sequence += 1;
        let mut summary = Document::new();
        summary.insert("id", text(format!("{node}.{}", base36(self.sequence))));
        summary.insert("ct", text(event.ct.to_string()));
        if let Some(wall) = event.wall_ms {
            summary.insert("wallTime", Value::DateTime(wall));
        }
        summary.insert("coll", text(&event.coll));
        summary.insert("op", text(event.op.as_str()));
        summary.insert("docId", event.id.clone());
        if let Some(diff) = &event.diff {
            summary.insert(
                "fields",
                Value::Array(
                    diff.set.iter().map(|(key, _)| text(key)).chain(diff.unset.iter().map(text)).collect(),
                ),
            );
        }
        if let Some(tail) = &mut self.tail {
            tail(&summary);
        }
        let mut trace = summary.clone();
        trace.insert("policyVersion", text(version));
        trace.insert("candidates", Value::Array(candidates));
        if self.events.len() == 256 {
            self.events.pop_front();
        }
        self.events.push_back((summary, trace));
        self.last_lag = event
            .wall_ms
            .and_then(|wall| u64::try_from(wall).ok())
            .map_or(0, |wall| now.saturating_sub(wall));
    }

    fn sample(&mut self, events: u64, now: u64) {
        let elapsed = now.saturating_sub(self.last_sample).max(1);
        let delta = events.saturating_sub(self.sampled_events);
        let mut point = Document::new();
        point.insert("t", inspection_number(now));
        point.insert("lagMs", inspection_number(if delta == 0 { 0 } else { self.last_lag }));
        point.insert(
            "eventsPerSecond",
            Value::Double((delta as f64 * 100_000.0 / elapsed as f64).round() / 100.0),
        );
        if self.history.len() == 120 {
            self.history.pop_front();
        }
        self.history.push_back(Value::Document(point));
        self.last_sample = now;
        self.sampled_events = events;
    }
}

/// Receives event summaries while a live inspector is attached.
pub type InspectionTail = Box<dyn FnMut(&Document) + Send>;

impl Engine {
    /// Starts the bounded history and optionally delivers live event summaries.
    pub fn enable_inspection(&mut self, now: u64, tail: Option<InspectionTail>) {
        if self.inspection.is_none() {
            let mut inspection = Inspection {
                events: VecDeque::new(),
                history: VecDeque::new(),
                tail,
                last_sample: now,
                sampled_events: self.metrics.events,
                last_lag: 0,
                sequence: self.metrics.events,
            };
            inspection.sample(self.metrics.events, now);
            self.inspection = Some(inspection);
        } else if let Some(inspection) = &mut self.inspection
            && tail.is_some()
        {
            inspection.tail = tail;
        }
    }

    /// Stops retaining or tracing change events.
    pub fn disable_inspection(&mut self) {
        self.inspection = None;
    }

    /// Samples the stream counters when inspection is active.
    pub fn sample_inspection(&mut self, now: u64) {
        if let Some(inspection) = &mut self.inspection {
            inspection.sample(self.metrics.events, now);
        }
    }

    /// Returns the inspector statistics and lag history.
    pub fn inspection_stats(&self) -> Document {
        let mut stats = Document::new();
        stats.insert("connections", inspection_number(self.inspection_connection_count()));
        stats.insert("sessions", inspection_number(self.sessions.len() as u64));
        stats.insert(
            "subscriptions",
            inspection_number(self.sessions.values().map(|state| state.subs.len() as u64).sum()),
        );
        let mut observers = Document::new();
        for kind in [Kind::Filter, Kind::Window, Kind::Polling] {
            observers.insert(kind.as_str(), inspection_number(self.metrics.observers(kind)));
        }
        stats.insert("observers", Value::Document(observers));
        stats.insert(
            "subjects",
            inspection_number(
                self.sessions.values().map(|s| &s.principal.subject).collect::<HashSet<_>>().len() as u64,
            ),
        );
        stats.insert("policyVersion", text(self.policy_version()));
        stats.insert("streamPosition", text(self.position.to_string()));
        stats
            .insert("collections", Value::Array(self.realtime_collections().into_iter().map(text).collect()));
        if let Some(inspection) = &self.inspection {
            if let Some(Value::Document(last)) = inspection.history.back() {
                for key in ["lagMs", "eventsPerSecond"] {
                    if let Some(value) = last.get(key) {
                        stats.insert(key, value.clone());
                    }
                }
            }
            stats.insert("history", Value::Array(inspection.history.iter().cloned().collect()));
        }
        stats
    }

    /// Returns the current sessions and subscriptions.
    pub fn inspection_connections(&self) -> Vec<Value> {
        let sessions: BTreeMap<_, _> = self.sessions.iter().collect();
        sessions
            .into_iter()
            .map(|(sid, state)| {
                let mut entry = Document::new();
                entry.insert("sid", text(sid));
                entry.insert("subject", text(&state.principal.subject));
                entry.insert(
                    "roles",
                    Value::Array(state.principal.roles.sorted().into_iter().map(text).collect()),
                );
                if let Some(key) = &state.principal.key_id {
                    entry.insert("keyId", text(key));
                }
                entry.insert("connected", Value::Bool(state.session.conn().is_some()));
                entry.insert("openedAt", date(state.opened_at));
                if let Some(expires) = state.principal.expires_at_ms {
                    entry.insert("tokenExpiresAt", date(expires));
                }
                let subs: BTreeMap<_, _> = state.subs.iter().collect();
                entry.insert(
                    "subscriptions",
                    Value::Array(
                        subs.into_iter()
                            .filter_map(|(id, sub)| {
                                let mut item = Document::new();
                                item.insert("id", text(id.as_ref()));
                                item.insert("coll", text(&sub.coll));
                                item.insert("observer", text(self.registry.get(sub.observer)?.key()));
                                Some(Value::Document(item))
                            })
                            .collect(),
                    ),
                );
                let documents = state.session.inspection_documents();
                let bytes = state
                    .session
                    .conn()
                    .and_then(|id| self.conns.get(&id))
                    .and_then(|conn| conn.queued_bytes.as_ref())
                    .map_or(0, |read| read());
                entry.insert("documents", inspection_number(documents as u64));
                entry.insert("queuedBytes", inspection_number(bytes as u64));
                entry.insert("lastSeq", inspection_number(state.session.last_seq()));
                Value::Document(entry)
            })
            .collect()
    }

    /// Returns current shared observers.
    pub fn inspection_observers(&self) -> Vec<Value> {
        self.registry
            .ids()
            .into_iter()
            .filter_map(|id| self.registry.get(id))
            .map(|observer| Value::Document(observer.inspection()))
            .collect()
    }

    /// Returns the buffered change summaries, newest first.
    pub fn inspection_events(&self) -> Vec<Value> {
        self.inspection.as_ref().map_or_else(Vec::new, |inspection| {
            inspection
                .events
                .iter()
                .rev()
                .take(100)
                .map(|(summary, _)| Value::Document(summary.clone()))
                .collect()
        })
    }

    /// Returns the number of collections in the active policy bundle.
    pub fn policy_collection_count(&self) -> usize {
        self.policy.set().collections().len()
    }

    /// Counts sessions with an attached connection.
    pub fn inspection_connection_count(&self) -> u64 {
        self.sessions.values().filter(|s| s.session.conn().is_some()).count() as u64
    }

    /// Finds a trace by its event identifier and masks explanations when requested.
    pub fn inspection_trace(&self, id: &str, viewer: bool) -> Option<Document> {
        let (summary, trace) = self
            .inspection
            .as_ref()?
            .events
            .iter()
            .find(|(summary, _)| summary.get("id").and_then(Value::as_str) == Some(id))?;
        let mut trace = trace.clone();
        if viewer {
            let coll = summary.get("coll")?.as_str()?;
            let access = self.policy.readable(
                coll,
                &crate::auth::Principal {
                    roles: [Role::AUTHENTICATED].into_iter().collect(),
                    ..crate::auth::Principal::anon()
                }
                .context(None, 0),
            );
            if let Some(Value::Array(candidates)) = trace.get_mut("candidates") {
                for candidate in candidates {
                    let Value::Document(candidate) = candidate else { continue };
                    let Some(Value::Document(dls)) = candidate.get("dls") else { continue };
                    let Some(Value::Array(policies)) = dls.get("policies") else { continue };
                    let hidden = policies.iter().any(|policy| {
                        let Value::Document(policy) = policy else { return false };
                        let Some(Value::Array(fields)) = policy.get("fields") else { return false };
                        fields.iter().filter_map(Value::as_str).any(|field| !can_access(&access, field))
                    });
                    if hidden {
                        let mut masked = Document::new();
                        masked.insert("masked", Value::Bool(true));
                        candidate.insert("dls", Value::Document(masked));
                    }
                }
            }
        }
        Some(trace)
    }

    pub(super) fn inspect_outcome(
        &self,
        id: ObserverId,
        event: &Event,
        before: bool,
        now: u64,
    ) -> Option<Document> {
        let observer = self.registry.get(id)?;
        let after = observer.inspection_has(&event.key);
        let outcome = match (before, after) {
            (true, true) => "updated",
            (true, false) => "left",
            (false, true) => "entered",
            (false, false) => "unmatched",
        };
        let mut out = Document::new();
        out.insert("observer", text(observer.key()));
        out.insert("type", text(observer.kind().as_str()));
        out.insert("outcome", text(outcome));
        let mut subscribers = Vec::new();
        let mut denial = None;
        let listeners = observer.inspection_listeners().filter_map(|listener| {
            let (sid, sub) = self.listeners.get(&listener)?;
            let state = self.sessions.get(sid)?;
            let subscription = state.subs.get(sub)?;
            Some((sid, sub, state, subscription))
        });
        for (sid, sub, state, subscription) in listeners.take(100) {
            if !after && subscribers.is_empty() {
                denial = self.inspection_denial(state, subscription, event, now);
            }
            let mut entry = Document::new();
            entry.insert("sid", text(sid));
            entry.insert("sub", text(sub.as_ref()));
            entry.insert("subject", text(&state.principal.subject));
            subscribers.push(Value::Document(entry));
        }
        out.insert("subscribers", Value::Array(subscribers));
        if let Some(denial) = denial {
            out.insert("dls", Value::Document(denial));
        }
        Some(out)
    }

    fn inspection_denial(
        &self,
        state: &SessionState,
        subscription: &Sub,
        event: &Event,
        now: u64,
    ) -> Option<Document> {
        let Post::Doc(image) = &event.post else { return None };
        let raw = image.raw()?;
        let filter = caller_filter(&subscription.query, self.config.limits.max_window).ok()?;
        if !compile_filter(&Value::Document(filter)).ok()?.matches_raw(raw).ok()? {
            return None;
        }
        let context = state.context(now);
        let explanation = self.policy.explain(&event.coll, Operation::Read, &context, Clause::Using).ok()?;
        if explanation.bypass {
            return None;
        }
        let definition = self.policy.collection(&event.coll)?;
        let mut policies = Vec::new();
        let mut permissive = Vec::new();
        let mut permissive_matched = false;
        let mut restrictive_failed = Vec::new();
        for policy in explanation.policies {
            if !policy.applies && policy.issue.is_none() {
                continue;
            }
            let matched = policy
                .resolved
                .and_then(|filter| compile_filter(&Value::Document(filter)).ok())
                .and_then(|filter| filter.matches_raw(raw).ok())
                .unwrap_or(false);
            let mut entry = Document::new();
            entry.insert("name", text(&policy.name));
            entry.insert("kind", text(policy.kind.as_str()));
            entry.insert("matched", Value::Bool(matched));
            if let Some(issue) = policy.issue {
                let mut detail = Document::new();
                detail.insert("variable", text(issue.variable));
                detail.insert("kind", text(issue.kind.to_string()));
                entry.insert("issue", Value::Document(detail));
            }
            let mut fields = HashSet::new();
            if let Some(template) = definition
                .policies
                .iter()
                .find(|def| def.name == policy.name)
                .and_then(|def| def.using.as_ref())
            {
                referenced_top_fields(&Value::Document(template.clone()), &mut fields);
            }
            let fields: std::collections::BTreeSet<_> = fields.into_iter().collect();
            entry.insert("fields", Value::Array(fields.into_iter().map(text).collect()));
            match policy.kind {
                PolicyKind::Permissive => {
                    permissive.push(text(policy.name));
                    permissive_matched |= matched;
                }
                PolicyKind::Restrictive if !matched => restrictive_failed.push(text(policy.name)),
                PolicyKind::Restrictive => {}
            }
            policies.push(Value::Document(entry));
        }
        let (reason, responsible) = if !explanation.exposed || permissive.is_empty() {
            ("no_grant", Vec::new())
        } else if !permissive_matched {
            ("no_permissive", permissive)
        } else if !restrictive_failed.is_empty() {
            ("restrictive", restrictive_failed)
        } else {
            return None;
        };
        let mut denial = Document::new();
        denial.insert("reason", text(reason));
        denial.insert("responsible", Value::Array(responsible));
        denial.insert("policies", Value::Array(policies));
        Some(denial)
    }
}
