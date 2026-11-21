//! Ending the sessions of a revoked API key or a revoked token session.

use super::{ConnState, Engine, Head, Principal, quoted};
use canopy_protocol::ErrorCode;

impl Engine {
    /// Returns the distinct stored API key IDs used by connected or resumable sessions.
    pub fn active_key_ids(&self) -> Vec<String> {
        let mut ids: Vec<_> =
            self.sessions.values().filter_map(|state| state.principal.key_id.clone()).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    /// Ends connected and resumable sessions that match the given principal predicate.
    pub fn close_matching(
        &mut self,
        matches: impl Fn(&Principal) -> bool,
        code: u16,
        reason: &str,
        now: u64,
    ) {
        let sessions: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, state)| matches(&state.principal))
            .map(|(sid, state)| (sid.clone(), state.session.conn()))
            .collect();
        let head =
            Head::new("err").raw("code", &quoted(ErrorCode::Forbidden.as_str())).text("msg", reason).finish();
        for (sid, conn) in sessions {
            if let Some(conn) = conn {
                self.send(&sid, head.clone());
                self.close_conn(conn, code, reason);
                if let Some(entry) = self.conns.get_mut(&conn) {
                    entry.state = ConnState::Closed;
                }
            }
            self.destroy(&sid, now);
        }
    }
}
