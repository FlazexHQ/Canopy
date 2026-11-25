use std::sync::Arc;
use std::time::UNIX_EPOCH;

use base64::{
    Engine, alphabet,
    engine::{
        GeneralPurpose,
        general_purpose::{NO_PAD, STANDARD},
    },
};
use canopy_mongo::mongodb::bson::doc;
use canopy_protocol::CanopyError;
use ring::hmac;
use tokio::sync::watch;

use crate::{Webhooks, field, invalid, queue::add, unavailable};

pub(crate) fn key(secret: &str) -> Result<hmac::Key, CanopyError> {
    let bytes = if let Some(encoded) = secret.strip_prefix("whsec_") {
        let compact: String =
            encoded.chars().filter(|ch| !matches!(ch, ' ' | '\t' | '\r' | '\n' | '\x0c')).collect();
        let unpadded = GeneralPurpose::new(&alphabet::STANDARD, NO_PAD);
        STANDARD
            .decode(&compact)
            .or_else(|_| unpadded.decode(&compact))
            .map_err(|_| invalid("Invalid webhook secret"))?
    } else {
        secret.as_bytes().to_vec()
    };
    if bytes.is_empty() {
        return Err(invalid("The webhook secret is empty"));
    }
    Ok(hmac::Key::new(hmac::HMAC_SHA256, &bytes))
}

impl Webhooks {
    /// Claims and attempts one due delivery. Returns false when the queue has no due work.
    pub async fn dispatch_one(&self) -> Result<bool, CanopyError> {
        let Some(delivery) = self
            .queue
            .claim(self.now(), self.options.timeout_ms.saturating_add(30_000), &self.options.node)
            .await
            .map_err(unavailable)?
        else {
            return Ok(false);
        };
        let hook = field(&delivery, "hook")?;
        let id = field(&delivery, "_id")?;
        let body = field(&delivery, "body")?;
        let attempts = delivery.get_i32("attempts").map_err(unavailable)?;
        let Some(endpoint) = self.hooks.get(hook) else {
            if self
                .queue
                .dead_letter(&delivery, self.now(), "The hook is no longer configured", None)
                .await
                .map_err(unavailable)?
            {
                self.count(hook, "dead_lettered");
            }
            return Ok(true);
        };
        let timestamp = self.now().timestamp_millis().div_euclid(1000);
        let signed = hmac::sign(&self.key, format!("{id}.{timestamp}.{body}").as_bytes());
        let signature = format!("v1,{}", STANDARD.encode(signed.as_ref()));
        let response = self
            .http
            .post(endpoint.url.clone())
            .header("content-type", "application/json")
            .header("user-agent", "canopy-webhooks")
            .header("webhook-id", id)
            .header("webhook-timestamp", timestamp.to_string())
            .header("webhook-signature", signature)
            .body(body.to_owned())
            .send()
            .await;
        let now = self.now();
        let (error, status, wait) = match response {
            Ok(response) if response.status().is_success() => {
                if self.queue.finish(&delivery, doc! {
                    "status": "delivered", "deliveredAt": now, "lastStatus": i32::from(response.status().as_u16()),
                    "expiresAt": add(now, 7 * 86_400_000),
                }, doc! { "lockedUntil": "", "lastError": "" }).await.map_err(unavailable)? {
                    self.count(hook, "delivered");
                }
                return Ok(true);
            }
            Ok(response) => {
                let status = i32::from(response.status().as_u16());
                let wait = response
                    .headers()
                    .get("retry-after")
                    .and_then(|header| header.to_str().ok())
                    .and_then(|header| retry_after(header, now.timestamp_millis()));
                (format!("The endpoint answered {status}"), Some(status), wait)
            }
            Err(error) if error.is_timeout() => {
                (format!("The endpoint did not answer within {} ms", self.options.timeout_ms), None, None)
            }
            Err(error) => (format!("The request failed: {}", error.without_url()), None, None),
        };
        if attempts >= self.options.max_attempts {
            if self.queue.dead_letter(&delivery, now, &error, status).await.map_err(unavailable)? {
                self.count(hook, "dead_lettered");
                tracing::warn!(hook, delivery = id, attempts, "Webhook delivery moved to dead letters");
            }
        } else {
            let base = self
                .options
                .retry_base_ms
                .saturating_mul(2_i64.saturating_pow(attempts.saturating_sub(1).max(0) as u32));
            let jitter = 0.8 + (self.options.random)() * 0.4;
            let delay = (base.min(self.options.retry_max_ms) as f64 * jitter) as i64;
            let delay = delay.max(wait.unwrap_or(0)).min(self.options.retry_max_ms);
            let mut set = doc! { "status": "pending", "nextAt": add(now, delay), "lastError": error };
            let mut unset = doc! { "lockedUntil": "" };
            if let Some(status) = status {
                set.insert("lastStatus", status);
            } else {
                unset.insert("lastStatus", "");
            }
            if self.queue.finish(&delivery, set, unset).await.map_err(unavailable)? {
                self.count(hook, "retried");
            }
        }
        Ok(true)
    }

    pub(crate) async fn dispatch_loop(self: Arc<Self>, mut stop: watch::Receiver<bool>) {
        while !*stop.borrow() {
            match self.dispatch_one().await {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => tracing::error!(error = %error, "Could not process webhook delivery"),
            }
            tokio::select! {
                _ = stop.changed() => break,
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(self.options.poll) => {}
            }
        }
    }
}

fn retry_after(header: &str, now: i64) -> Option<i64> {
    let header = header.trim();
    if !header.is_empty() && header.bytes().all(|ch| ch.is_ascii_digit()) {
        return Some(header.parse::<i64>().unwrap_or(i64::MAX).saturating_mul(1000));
    }
    let at = httpdate::parse_http_date(header).ok()?;
    let millis = match at.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(error) => -(error.duration().as_millis() as i64),
    };
    Some(millis.saturating_sub(now).max(0))
}

#[cfg(test)]
mod tests {
    use super::retry_after;

    #[test]
    fn reads_delta_seconds_and_http_dates() {
        assert_eq!(retry_after(" 12 ", 0), Some(12_000));
        assert_eq!(retry_after("Sun, 06 Nov 1994 08:49:37 GMT", 784_111_770_000), Some(7_000));
        assert_eq!(retry_after("Sun, 06 Nov 1994 08:49:37 GMT", 784_111_778_000), Some(0));
        assert_eq!(retry_after("later", 0), None);
    }
}
