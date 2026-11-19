use std::collections::HashSet;

use crate::ct::Ct;

/// A pending wait for the echo of one write.
#[derive(Debug)]
struct Waiter {
    token: u64,
    ct: Ct,
    keys: HashSet<String>,
    deadline_ms: u64,
}

/// Tells when the change events of a committed write have been fanned out. A wait for `(keys, T)` is done once,
/// for every key, an event with `ct >= T` was processed, or once anything later than `T` was processed, because
/// the stream is ordered. Cluster times are not unique per event, so a time equal to `T` never counts as proof
/// on its own. Waits that pass their deadline end unechoed.
#[derive(Debug, Default)]
pub struct EchoWaiter {
    position: Ct,
    seen_at_position: HashSet<String>,
    waiters: Vec<Waiter>,
}

/// The outcome of a wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settled {
    /// The token given to [`EchoWaiter::wait`].
    pub token: u64,
    /// Whether the events were fanned out; `false` after the deadline.
    pub echoed: bool,
}

impl EchoWaiter {
    /// Creates a waiter at the start of the stream.
    pub fn new() -> EchoWaiter {
        EchoWaiter::default()
    }

    /// Starts a wait. Returns `true` when the events were already processed, so no wait is kept.
    pub fn wait(&mut self, token: u64, keys: Vec<String>, ct: Ct, deadline_ms: u64) -> bool {
        let keys: HashSet<String> = keys.into_iter().collect();
        if self.passed(ct, &keys) {
            return true;
        }
        self.waiters.push(Waiter { token, ct, keys, deadline_ms });
        false
    }

    /// Records a batch of fanned out events, as `(key, ct)` in stream order, and returns the waits it settled.
    pub fn processed<'a>(&mut self, events: impl IntoIterator<Item = (&'a str, Ct)>) -> Vec<Settled> {
        for (key, ct) in events {
            if ct > self.position {
                self.position = ct;
                self.seen_at_position.clear();
            }
            if ct >= self.position {
                self.seen_at_position.insert(key.to_owned());
            }
            for waiter in &mut self.waiters {
                if ct >= waiter.ct {
                    waiter.keys.remove(key);
                }
            }
        }
        self.settle()
    }

    /// Records that the stream reached `ct` without further events, such as a progress report.
    pub fn advance(&mut self, ct: Ct) -> Vec<Settled> {
        if ct > self.position {
            self.position = ct;
            self.seen_at_position.clear();
        }
        self.settle()
    }

    /// Ends the waits whose deadline passed.
    pub fn expire(&mut self, now_ms: u64) -> Vec<Settled> {
        let mut out = Vec::new();
        self.waiters.retain(|waiter| {
            if waiter.deadline_ms <= now_ms {
                out.push(Settled { token: waiter.token, echoed: false });
                false
            } else {
                true
            }
        });
        out
    }

    /// Ends every wait unechoed, for shutdown.
    pub fn close(&mut self) -> Vec<Settled> {
        self.waiters.drain(..).map(|waiter| Settled { token: waiter.token, echoed: false }).collect()
    }

    /// The number of pending waits.
    pub fn pending(&self) -> usize {
        self.waiters.len()
    }

    /// The earliest deadline of a pending wait.
    pub fn next_deadline(&self) -> Option<u64> {
        self.waiters.iter().map(|waiter| waiter.deadline_ms).min()
    }

    fn passed(&self, ct: Ct, keys: &HashSet<String>) -> bool {
        if self.position > ct {
            return true;
        }
        if self.position < ct {
            return false;
        }
        keys.iter().all(|key| self.seen_at_position.contains(key))
    }

    fn settle(&mut self) -> Vec<Settled> {
        let position = self.position;
        let mut out = Vec::new();
        self.waiters.retain(|waiter| {
            if waiter.keys.is_empty() || position > waiter.ct {
                out.push(Settled { token: waiter.token, echoed: true });
                false
            } else {
                true
            }
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::{EchoWaiter, Settled};
    use crate::ct::Ct;

    fn keys(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn settles_when_every_key_is_seen_at_or_after_the_write() {
        let mut waiter = EchoWaiter::new();
        assert!(!waiter.wait(1, keys(&["c/1", "c/2"]), Ct(10), 1000));
        assert_eq!(waiter.processed([("c/1", Ct(10))]), vec![]);
        assert_eq!(waiter.processed([("c/2", Ct(10))]), vec![Settled { token: 1, echoed: true }]);
    }

    #[test]
    fn an_event_at_the_same_time_for_another_key_is_not_proof() {
        let mut waiter = EchoWaiter::new();
        assert!(!waiter.wait(1, keys(&["c/1"]), Ct(10), 1000));
        assert_eq!(waiter.processed([("c/9", Ct(10))]), vec![]);
        assert_eq!(waiter.pending(), 1);
    }

    #[test]
    fn a_later_event_settles_every_earlier_wait() {
        let mut waiter = EchoWaiter::new();
        assert!(!waiter.wait(1, keys(&["c/1"]), Ct(10), 1000));
        assert_eq!(waiter.processed([("c/9", Ct(11))]), vec![Settled { token: 1, echoed: true }]);
    }

    #[test]
    fn a_wait_for_events_already_processed_is_done_at_once() {
        let mut waiter = EchoWaiter::new();
        waiter.processed([("c/1", Ct(10))]);
        assert!(waiter.wait(1, keys(&["c/1"]), Ct(10), 1000));
        assert!(waiter.wait(2, keys(&["c/5"]), Ct(9), 1000));
        assert!(!waiter.wait(3, keys(&["c/5"]), Ct(10), 1000));
    }

    #[test]
    fn expires_after_the_deadline_without_an_echo() {
        let mut waiter = EchoWaiter::new();
        assert!(!waiter.wait(1, keys(&["c/1"]), Ct(10), 500));
        assert_eq!(waiter.expire(499), vec![]);
        assert_eq!(waiter.expire(500), vec![Settled { token: 1, echoed: false }]);
        assert_eq!(waiter.pending(), 0);
    }

    #[test]
    fn progress_past_the_write_settles_it() {
        let mut waiter = EchoWaiter::new();
        assert!(!waiter.wait(1, keys(&["c/1"]), Ct(10), 500));
        assert_eq!(waiter.advance(Ct(10)), vec![]);
        assert_eq!(waiter.advance(Ct(11)), vec![Settled { token: 1, echoed: true }]);
    }
}
