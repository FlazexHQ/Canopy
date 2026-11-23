use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use canopy_policy::{Role, Roles};
use canopy_protocol::{CanopyError, ErrorCode};

/// The size and refill speed of a token bucket.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BucketSpec {
    /// Tokens added per second, which is the rate a caller can sustain.
    pub per_second: f64,
    /// The most tokens a bucket holds, which is the burst a caller can spend at once.
    pub burst: f64,
}

/// The clock of the limits, in milliseconds since the epoch.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

fn system_clock() -> Clock {
    Arc::new(|| SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64))
}

struct Bucket {
    tokens: f64,
    at: f64,
    order: u64,
}

#[derive(Default)]
struct Held {
    buckets: HashMap<String, Bucket>,
    /// The keys from the least to the most recently used.
    order: BTreeMap<u64, String>,
    next: u64,
}

impl Held {
    fn touch(&mut self, key: &str, bucket: &mut Bucket) {
        self.order.remove(&bucket.order);
        bucket.order = self.next;
        self.order.insert(self.next, key.to_owned());
        self.next += 1;
    }
}

/// Token buckets per key, held in memory with a bounded number of keys. A bucket starts full, spends one token
/// per request and refills continuously, so short bursts pass and a sustained excess does not.
pub struct TokenBuckets {
    spec: BucketSpec,
    max_keys: usize,
    now: Clock,
    held: Mutex<Held>,
}

fn wait_ms(spec: BucketSpec, tokens: f64, cost: f64) -> u64 {
    let missing = cost.min(spec.burst) - tokens;
    let wait = ((missing / spec.per_second) * 1000.0 - 1e-6).ceil().max(1.0);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let wait = wait as u64;
    wait
}

impl TokenBuckets {
    /// Creates buckets of `spec` for at most `max_keys` keys, timed by `now`.
    pub fn new(spec: BucketSpec, max_keys: usize, now: Clock) -> TokenBuckets {
        TokenBuckets { spec, max_keys, now, held: Mutex::default() }
    }

    fn held(&self) -> std::sync::MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Spends `cost` tokens of the bucket of `key`. Returns 0 when they were available; otherwise nothing is
    /// spent and the result is how many milliseconds to wait until they will be.
    pub fn take(&self, key: &str, cost: f64) -> u64 {
        let now = (self.now)();
        let spec = self.spec;
        let mut held = self.held();
        let mut bucket = match held.buckets.remove(key) {
            Some(mut bucket) => {
                let elapsed = (now - bucket.at).max(0.0);
                bucket.tokens = spec.burst.min(bucket.tokens + (elapsed * spec.per_second) / 1000.0);
                bucket.at = now;
                bucket
            }
            None => {
                if held.buckets.len() >= self.max_keys {
                    self.evict(&mut held, now);
                }
                Bucket { tokens: spec.burst, at: now, order: u64::MAX }
            }
        };
        held.touch(key, &mut bucket);
        let wait = if bucket.tokens >= cost {
            bucket.tokens -= cost;
            0
        } else {
            wait_ms(spec, bucket.tokens, cost)
        };
        held.buckets.insert(key.to_owned(), bucket);
        wait
    }

    /// The milliseconds until `key` could spend `cost` tokens, without spending them: 0 when it could now.
    pub fn peek(&self, key: &str, cost: f64) -> u64 {
        let held = self.held();
        let Some(bucket) = held.buckets.get(key) else { return 0 };
        let elapsed = ((self.now)() - bucket.at).max(0.0);
        let tokens = self.spec.burst.min(bucket.tokens + (elapsed * self.spec.per_second) / 1000.0);
        if tokens >= cost { 0 } else { wait_ms(self.spec, tokens, cost) }
    }

    /// The number of keys held.
    pub fn len(&self) -> usize {
        self.held().buckets.len()
    }

    /// Whether no key is held.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drops buckets that have refilled completely, then the least recently used one if none had.
    fn evict(&self, held: &mut Held, now: f64) {
        let full_after_ms = (self.spec.burst / self.spec.per_second) * 1000.0;
        let full: Vec<(String, u64)> = held
            .buckets
            .iter()
            .filter(|(_, bucket)| now - bucket.at >= full_after_ms)
            .map(|(key, bucket)| (key.clone(), bucket.order))
            .collect();
        for (key, order) in full {
            held.buckets.remove(&key);
            held.order.remove(&order);
        }
        if held.buckets.len() >= self.max_keys
            && let Some((_, oldest)) = held.order.pop_first()
        {
            held.buckets.remove(&oldest);
        }
    }
}

/// Options of [`RateLimits`].
#[derive(Clone)]
pub struct RateLimitOptions {
    /// HTTP requests of REST and GraphQL.
    pub requests: BucketSpec,
    /// Failed authentications (an unknown API key, a bad token) per client address. Once an address has spent
    /// its budget, its requests are refused before their credentials are checked.
    pub failed_authentications: BucketSpec,
    /// Whether callers with the `service` role are exempt.
    pub exempt_service: bool,
    /// The most callers tracked per kind of limit.
    pub max_keys: usize,
    /// The clock, in milliseconds since the epoch.
    pub now: Clock,
}

impl Default for RateLimitOptions {
    fn default() -> RateLimitOptions {
        RateLimitOptions {
            requests: BucketSpec { per_second: 50.0, burst: 200.0 },
            failed_authentications: BucketSpec { per_second: 1.0, burst: 30.0 },
            exempt_service: true,
            max_keys: 50_000,
            now: system_clock(),
        }
    }
}

/// The HTTP request limits of the data plane, as the TypeScript `RateLimits` counts them: callers are keyed by
/// API key and subject, and anonymous callers, who all share a key, by client address too. State is in memory
/// and per process.
pub struct RateLimits {
    requests: TokenBuckets,
    failures: TokenBuckets,
    exempt_service: bool,
}

impl RateLimits {
    /// Creates the limits.
    pub fn new(options: RateLimitOptions) -> RateLimits {
        RateLimits {
            requests: TokenBuckets::new(options.requests, options.max_keys, Arc::clone(&options.now)),
            failures: TokenBuckets::new(options.failed_authentications, options.max_keys, options.now),
            exempt_service: options.exempt_service,
        }
    }

    /// Counts one request of a caller. Returns 0 to proceed, or the milliseconds to wait.
    pub fn request(&self, key: Option<&str>, subject: &str, roles: &Roles, address: &str) -> u64 {
        if self.exempt_service && roles.contains(Role::SERVICE) {
            return 0;
        }
        let mut caller = format!("{}\u{0}{subject}", key.unwrap_or_default());
        if subject == "anon" {
            caller.push('\u{0}');
            caller.push_str(address);
        }
        self.requests.take(&caller, 1.0)
    }

    /// Whether `address` has used up its budget of failed authentications. Returns 0 to go on and check the
    /// credentials, or the milliseconds to wait. Nothing is spent.
    pub fn authentication_blocked(&self, address: &str) -> u64 {
        self.failures.peek(address, 1.0)
    }

    /// Counts one failed authentication from `address`.
    pub fn authentication_failed(&self, address: &str) {
        self.failures.take(address, 1.0);
    }
}

/// The `Retry-After` value in whole seconds for a wait in milliseconds.
pub fn retry_after_seconds(wait_ms: u64) -> u64 {
    wait_ms.div_ceil(1000).max(1)
}

/// The error for a request over a budget, carrying `retryAfterSeconds` in its details.
pub fn rate_limit_error(wait_ms: u64) -> CanopyError {
    let seconds = retry_after_seconds(wait_ms);
    let unit = if seconds == 1 { "second" } else { "seconds" };
    CanopyError::named(
        ErrorCode::RateLimited,
        "RateLimitError",
        format!("Too many requests. Retry in {seconds} {unit}."),
    )
    .with_details(format!("{{\"retryAfterSeconds\":{seconds}}}"))
}
