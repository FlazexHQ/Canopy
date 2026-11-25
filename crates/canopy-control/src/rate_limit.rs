//! Fixed window attempt counters and the account lockout of repeated failed logins.

use std::collections::HashMap;
use std::sync::Mutex;

/// The windows by key (start and count), and the keys in the order they were added.
type Windows = (HashMap<String, (i64, u32)>, Vec<String>);

/// A fixed window counter per key, in memory, with a bounded number of keys.
pub(crate) struct RateLimiter {
    limit: u32,
    window_ms: i64,
    max_keys: usize,
    windows: Mutex<Windows>,
}

impl RateLimiter {
    pub(crate) fn new(limit: u32, window_ms: i64) -> RateLimiter {
        RateLimiter { limit, window_ms, max_keys: 10_000, windows: Mutex::new((HashMap::new(), Vec::new())) }
    }

    /// Counts one attempt at `now`. Returns how long to wait in milliseconds when over the limit, else 0.
    pub(crate) fn hit(&self, key: &str, now: i64) -> i64 {
        let Ok(mut guard) = self.windows.lock() else { return 0 };
        let (windows, order) = &mut *guard;
        let fresh = windows.get(key).is_none_or(|(start, _)| now - start >= self.window_ms);
        if fresh {
            if !windows.contains_key(key) && windows.len() >= self.max_keys {
                windows.retain(|_, (start, _)| now - *start < self.window_ms);
                order.retain(|name| windows.contains_key(name));
                if windows.len() >= self.max_keys
                    && let Some(oldest) = order.first().cloned()
                {
                    windows.remove(&oldest);
                    order.retain(|name| *name != oldest);
                }
            }
            if !windows.contains_key(key) {
                order.push(key.to_owned());
            }
            windows.insert(key.to_owned(), (now, 0));
        }
        let Some(window) = windows.get_mut(key) else { return 0 };
        window.1 += 1;
        if window.1 > self.limit { window.0 + self.window_ms - now } else { 0 }
    }

    /// Forgets a key, after a successful login for example.
    pub(crate) fn reset(&self, key: &str) {
        if let Ok(mut guard) = self.windows.lock() {
            let (windows, order) = &mut *guard;
            windows.remove(key);
            order.retain(|name| name != key);
        }
    }
}

/// The lockout after repeated failed logins of one account: none for the first five failures, then a delay
/// of one second that doubles with every failure, up to 15 minutes.
pub(crate) fn lockout_ms(failures: i64) -> i64 {
    const FREE: i64 = 5;
    const BASE_MS: i64 = 1000;
    const MAX_MS: i64 = 15 * 60_000;
    if failures < FREE {
        return 0;
    }
    let doublings = u32::try_from((failures - FREE).min(30)).unwrap_or(30);
    BASE_MS.saturating_mul(1i64 << doublings).min(MAX_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_refuses_attempts_over_the_limit_until_it_ends() {
        let limiter = RateLimiter::new(2, 1000);
        assert_eq!(limiter.hit("k", 0), 0);
        assert_eq!(limiter.hit("k", 100), 0);
        assert_eq!(limiter.hit("k", 400), 600);
        assert_eq!(limiter.hit("other", 400), 0);
        assert_eq!(limiter.hit("k", 1000), 0);
        limiter.reset("k");
        assert_eq!(limiter.hit("k", 1001), 0);
    }

    #[test]
    fn the_lockout_doubles_after_five_failures_up_to_fifteen_minutes() {
        assert_eq!(lockout_ms(4), 0);
        assert_eq!(lockout_ms(5), 1000);
        assert_eq!(lockout_ms(6), 2000);
        assert_eq!(lockout_ms(14), 512_000);
        assert_eq!(lockout_ms(15), 900_000);
        assert_eq!(lockout_ms(100), 900_000);
    }
}
