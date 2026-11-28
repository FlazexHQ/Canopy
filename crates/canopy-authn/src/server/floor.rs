use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

const WINDOW: usize = 64;
const CEILING: Duration = Duration::from_secs(1);
const RANK: usize = 3;

/// Routes whose answer time could reveal whether an email address has an account.
pub(super) const FLOOR_ROUTES: [&str; 9] = [
    "/sign-in/email",
    "/sign-up/email",
    "/request-password-reset",
    "/sign-in/magic-link",
    "/email-otp/send-verification-otp",
    "/email-otp/request-password-reset",
    "/forget-password/email-otp",
    "/send-verification-email",
    "/upgrade",
];

/// How long to hold the answers of routes whose timing could reveal whether an address has an account.
///
/// An answer waits until it took the configured floor or the third slowest of the last 64 answers on its
/// route, whichever is longer, up to one second (or the floor, when the floor is longer). A fixed floor
/// alone hides nothing where the slow path outlasts it, and a rank rather than a percentile keeps a rare
/// slow path covered when most requests take the fast one.
pub(super) struct ResponseFloor {
    floor: Duration,
    recent: Mutex<HashMap<&'static str, VecDeque<Duration>>>,
}

impl ResponseFloor {
    pub(super) fn new(floor: Duration) -> Self {
        Self { floor, recent: Mutex::new(HashMap::new()) }
    }

    /// The route's key when its answers are held.
    pub(super) fn route(route: &str) -> Option<&'static str> {
        FLOOR_ROUTES.into_iter().find(|candidate| *candidate == route)
    }

    /// How long an answer on `route` must take in all.
    pub(super) fn target(&self, route: &'static str) -> Duration {
        let recent = self.recent.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut times: Vec<Duration> = recent.get(route).into_iter().flatten().copied().collect();
        drop(recent);
        times.sort_unstable_by(|a, b| b.cmp(a));
        let slow = times.get(RANK.min(times.len()).saturating_sub(1)).copied().unwrap_or_default();
        self.floor.max(slow).min(self.floor.max(CEILING))
    }

    /// Records how long an answer on `route` took before it was held.
    pub(super) fn record(&self, route: &'static str, took: Duration) {
        let mut recent = self.recent.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let times = recent.entry(route).or_default();
        times.push_back(took);
        if times.len() > WINDOW {
            times.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUTE: &str = "/sign-in/email";

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn holds_to_the_floor_without_history() {
        let floor = ResponseFloor::new(ms(80));
        assert_eq!(floor.target(ROUTE), ms(80));
    }

    #[test]
    fn holds_to_the_third_slowest_recent_answer() {
        let floor = ResponseFloor::new(ms(80));
        for took in [10, 300, 20, 250, 30, 200, 40] {
            floor.record(ROUTE, ms(took));
        }
        assert_eq!(floor.target(ROUTE), ms(200));
        assert_eq!(floor.target("/sign-up/email"), ms(80));
    }

    #[test]
    fn one_or_two_stalls_do_not_raise_the_target() {
        let floor = ResponseFloor::new(ms(80));
        floor.record(ROUTE, ms(900));
        floor.record(ROUTE, ms(700));
        floor.record(ROUTE, ms(5));
        assert_eq!(floor.target(ROUTE), ms(80));
    }

    #[test]
    fn caps_at_one_second_unless_the_floor_is_longer() {
        let floor = ResponseFloor::new(ms(80));
        for _ in 0..3 {
            floor.record(ROUTE, ms(5_000));
        }
        assert_eq!(floor.target(ROUTE), CEILING);
        let long = ResponseFloor::new(ms(1_500));
        for _ in 0..3 {
            long.record(ROUTE, ms(5_000));
        }
        assert_eq!(long.target(ROUTE), ms(1_500));
    }

    #[test]
    fn forgets_answers_older_than_the_window() {
        let floor = ResponseFloor::new(ms(80));
        for _ in 0..3 {
            floor.record(ROUTE, ms(600));
        }
        for _ in 0..WINDOW {
            floor.record(ROUTE, ms(10));
        }
        assert_eq!(floor.target(ROUTE), ms(80));
    }

    #[test]
    fn holds_only_the_routes_that_reveal_accounts() {
        assert_eq!(ResponseFloor::route("/sign-in/email"), Some("/sign-in/email"));
        assert_eq!(ResponseFloor::route("/upgrade"), Some("/upgrade"));
        assert_eq!(ResponseFloor::route("/get-session"), None);
    }
}
