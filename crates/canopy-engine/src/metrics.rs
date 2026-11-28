use std::collections::BTreeMap;
use std::fmt::Write as _;

use crate::observer::Kind;

/// Counters of the engine, rendered in the Prometheus text format by [`Metrics::render`].
#[derive(Debug, Default, Clone)]
pub struct Metrics {
    /// Open connections.
    pub connections: u64,
    /// Sessions opened since start.
    pub sessions_opened: u64,
    /// Sessions ended since start.
    pub sessions_closed: u64,
    /// Live subscriptions.
    pub subscriptions: u64,
    /// Subscriptions refused by policy.
    pub denials: u64,
    /// Change events processed.
    pub events: u64,
    /// Candidate observers evaluated, summed over events.
    pub candidates: u64,
    /// Events applied to observers.
    pub matches: u64,
    /// Documents looked up for updates without a post image.
    pub lookups: u64,
    /// Sessions ended because the client could not keep up.
    pub slow_consumers: u64,
    /// Messages refused by the message budget.
    pub rate_limited: u64,
    observers: BTreeMap<&'static str, u64>,
    resyncs: BTreeMap<String, u64>,
    mutations: BTreeMap<&'static str, u64>,
}

impl Metrics {
    /// Counts a new observer.
    pub fn observer_created(&mut self, kind: Kind) {
        *self.observers.entry(kind.as_str()).or_default() += 1;
    }

    /// Counts a destroyed observer.
    pub fn observer_destroyed(&mut self, kind: Kind) {
        let count = self.observers.entry(kind.as_str()).or_default();
        *count = count.saturating_sub(1);
    }

    /// Counts a resync.
    pub fn resync(&mut self, reason: &str) {
        *self.resyncs.entry(reason.to_owned()).or_default() += 1;
    }

    /// Counts a mutation outcome: `echo`, `docs` or `error`.
    pub fn mutation(&mut self, result: &'static str) {
        *self.mutations.entry(result).or_default() += 1;
    }

    /// Live observers of a type.
    pub fn observers(&self, kind: Kind) -> u64 {
        self.observers.get(kind.as_str()).copied().unwrap_or(0)
    }

    /// Renders every counter with the `canopyd_` prefix.
    pub fn render(&self) -> String {
        let mut out = String::new();
        let mut gauge = |name: &str, help: &str, kind: &str, value: u64| {
            let _ = writeln!(out, "# HELP canopyd_{name} {help}");
            let _ = writeln!(out, "# TYPE canopyd_{name} {kind}");
            let _ = writeln!(out, "canopyd_{name} {value}");
        };
        gauge("connections", "Open connections", "gauge", self.connections);
        gauge("sessions_opened_total", "Sessions opened", "counter", self.sessions_opened);
        gauge("sessions_closed_total", "Sessions ended", "counter", self.sessions_closed);
        gauge("subscriptions", "Live subscriptions", "gauge", self.subscriptions);
        gauge("denials_total", "Subscriptions refused by policy", "counter", self.denials);
        gauge("events_total", "Change events processed", "counter", self.events);
        gauge("candidates_total", "Candidate observers evaluated", "counter", self.candidates);
        gauge("match_evaluations_total", "Events applied to observers", "counter", self.matches);
        gauge("lazy_lookups_total", "Documents looked up for updates", "counter", self.lookups);
        gauge("slow_consumers_total", "Sessions ended as slow consumers", "counter", self.slow_consumers);
        gauge("rate_limited_total", "Messages refused by the message budget", "counter", self.rate_limited);
        let _ = writeln!(out, "# HELP canopyd_observers Live observers by type");
        let _ = writeln!(out, "# TYPE canopyd_observers gauge");
        for kind in [Kind::Filter, Kind::Window, Kind::Polling] {
            let _ = writeln!(out, "canopyd_observers{{type=\"{}\"}} {}", kind.as_str(), self.observers(kind));
        }
        let _ = writeln!(out, "# HELP canopyd_resyncs_total Resyncs by reason");
        let _ = writeln!(out, "# TYPE canopyd_resyncs_total counter");
        for (reason, count) in &self.resyncs {
            let _ = writeln!(out, "canopyd_resyncs_total{{reason=\"{reason}\"}} {count}");
        }
        let _ = writeln!(out, "# HELP canopyd_mutations_total Mutations by result");
        let _ = writeln!(out, "# TYPE canopyd_mutations_total counter");
        for (result, count) in &self.mutations {
            let _ = writeln!(out, "canopyd_mutations_total{{result=\"{result}\"}} {count}");
        }
        out
    }
}
