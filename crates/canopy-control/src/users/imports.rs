use super::*;

fn hash_text<'a>(hash: &'a Document, field: &str, algorithm: &str) -> Result<&'a str, CanopyError> {
    text(hash, field)
        .filter(|value| js_length(value) <= 4096 && (!value.is_empty() || field == "saltSeparator"))
        .ok_or_else(|| invalid(format!("The {algorithm} hash needs {field} as a string")))
}

fn hash_number(hash: &Document, field: &str, algorithm: &str) -> Result<f64, CanopyError> {
    crate::core::number(hash, field)
        .filter(|value| value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0)
        .ok_or_else(|| invalid(format!("The {algorithm} hash needs {field} as an integer")))
}

fn bounded(value: f64, field: &str, max: u32) -> Result<f64, CanopyError> {
    if (1.0..=f64::from(max)).contains(&value) {
        Ok(value)
    } else {
        Err(invalid(format!("{field} must be an integer from 1 to {max}")))
    }
}

fn base64(value: &str, field: &str) -> Result<(), CanopyError> {
    let data = value.trim_end_matches('=');
    if value.len() - data.len() > 2
        || !data.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/'))
    {
        return Err(invalid(format!("{field} is not base64")));
    }
    Ok(())
}

enum Legacy<'a> {
    Bcrypt(&'a str),
    Argon(&'a str),
    Pbkdf(&'a str, f64, &'a str, &'a str),
    Firebase(&'a str, &'a str, f64, f64, &'a str, &'a str),
}

impl<'a> Legacy<'a> {
    fn parse(hash: &'a Document) -> Result<Self, CanopyError> {
        let algorithm = text(hash, "algorithm").unwrap_or_default();
        let string = |field| hash_text(hash, field, algorithm);
        let integer = |field| hash_number(hash, field, algorithm);
        Ok(match algorithm {
            "bcrypt" => Self::Bcrypt(string("hash")?),
            "argon2id" => Self::Argon(string("hash")?),
            "pbkdf2-sha1" | "pbkdf2-sha256" | "pbkdf2-sha512" => {
                Self::Pbkdf(algorithm, integer("iterations")?, string("salt")?, string("hash")?)
            }
            "firebase-scrypt" => Self::Firebase(
                string("signerKey")?,
                string("saltSeparator")?,
                integer("rounds")?,
                integer("memCost")?,
                string("salt")?,
                string("hash")?,
            ),
            _ => {
                let label = match hash.get("algorithm") {
                    Some(value) => {
                        let json = value.clone().into_relaxed_extjson();
                        json.to_string()
                    }
                    None => "undefined".into(),
                };
                return Err(invalid(format!("Unknown password hash algorithm {label}")));
            }
        })
    }

    fn encode(self) -> Result<String, CanopyError> {
        let encoded = match self {
            Self::Bcrypt(hash) => {
                let parts: Vec<_> = hash.split('$').collect();
                let ["", variant, cost, digest] = parts.as_slice() else {
                    return Err(invalid("The bcrypt hash is not in the $2b$ format"));
                };
                if !matches!(*variant, "2" | "2a" | "2b" | "2x" | "2y")
                    || cost.len() != 2
                    || !cost.bytes().all(|byte| byte.is_ascii_digit())
                    || digest.len() != 53
                    || !digest.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'/'))
                {
                    return Err(invalid("The bcrypt hash is not in the $2b$ format"));
                }
                if cost.parse::<u8>().is_ok_and(|value| value > 16) {
                    return Err(invalid("The bcrypt cost may not exceed 16"));
                }
                format!("bcrypt${hash}")
            }
            Self::Argon(hash) => {
                if !hash.starts_with("$argon2id$") {
                    return Err(invalid("The argon2id hash is not in the PHC format"));
                }
                for (param, min, max, label) in
                    [('m', 8, 262_144, "memory"), ('t', 1, 32, "passes"), ('p', 1, 16, "lanes")]
                {
                    let prefix = format!("{param}=");
                    let count =
                        hash.split(['$', ',']).find_map(|value| value.strip_prefix(&prefix)).and_then(
                            |value| value.split(|ch: char| !ch.is_ascii_digit()).next()?.parse::<u32>().ok(),
                        );
                    if !count.is_some_and(|value| (min..=max).contains(&value)) {
                        let unit = if param == 'm' { " KiB" } else { "" };
                        return Err(invalid(format!(
                            "The argon2id {label} must be from {min} to {max}{unit}"
                        )));
                    }
                }
                format!("argon2id${hash}")
            }
            Self::Pbkdf(algorithm, iterations, salt, hash) => {
                bounded(iterations, "iterations", 10_000_000)?;
                base64(salt, "salt")?;
                base64(hash, "hash")?;
                format!("{algorithm}${iterations}${salt}${hash}")
            }
            Self::Firebase(key, separator, rounds, memory, salt, hash) => {
                base64(key, "signerKey")?;
                base64(separator, "saltSeparator")?;
                bounded(rounds, "rounds", 16)?;
                bounded(memory, "memCost", 16)?;
                base64(salt, "salt")?;
                base64(hash, "hash")?;
                format!("firebase-scrypt${key}${separator}${rounds}${memory}${salt}${hash}")
            }
        };
        Ok(format!("canopy-legacy${encoded}"))
    }
}

fn identities(input: &Document) -> Result<Vec<Document>, CanopyError> {
    input
        .get_array("identities")
        .into_iter()
        .flatten()
        .filter_map(Bson::as_document)
        .map(|identity| {
            let provider = text(identity, "provider").unwrap_or_default();
            let mut chars = provider.bytes();
            let lower_or_digit = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
            if provider == "credential"
                || !chars.next().is_some_and(lower_or_digit)
                || !chars.all(|byte| lower_or_digit(byte) || matches!(byte, b'_' | b'-'))
            {
                return Err(invalid(format!("The identity provider {provider} is not valid")));
            }
            Ok(doc! { "providerId": provider, "accountId": text(identity, "subject").unwrap_or_default() })
        })
        .collect()
}

impl UserRoutes {
    pub(super) async fn import(&self, call: &Call, now: DateTime) -> Result<Reply, CanopyError> {
        let mut schema = vec![
            ("email", string(1, 320)),
            ("createdAt", optional(string(0, 64))),
            ("disabled", optional(Schema::Boolean)),
            ("passwordHash", optional(Schema::Document)),
            (
                "identities",
                optional(Schema::Array(
                    Box::new(Schema::Object(vec![("provider", string(1, 64)), ("subject", string(1, 256))])),
                    20,
                )),
            ),
        ];
        schema.extend(fields());
        let body = body(call, vec![("users", Schema::Array(Box::new(Schema::Object(schema)), 1000))])?;
        let mut accepted = Vec::new();
        let mut refused = Vec::new();
        let mut failed = Vec::new();
        for user in body.get_array("users").into_iter().flatten().filter_map(Bson::as_document) {
            let email = text(user, "email").unwrap_or_default();
            let hash = match user.get_document("passwordHash").ok().map(Legacy::parse).transpose() {
                Ok(hash) => hash,
                Err(error) => {
                    refused.push(doc! { "email": email, "reason": error.message() });
                    continue;
                }
            };
            let created_at = text(user, "createdAt")
                .map(|value| {
                    date(value).ok_or_else(|| invalid(format!("createdAt of {email} is not a date")))
                })
                .transpose()?;
            accepted.push((user, hash, created_at));
        }
        let mut created = 0;
        let mut skipped = 0;
        for (user, hash, created_at) in accepted {
            let label = text(user, "email").unwrap_or_default();
            let result = async {
                email(label)?;
                check_roles(user)?;
                let password = hash.map(Legacy::encode).transpose()?;
                let accounts = identities(user)?;
                let mut input = user.clone();
                input.remove("passwordHash");
                input.remove("identities");
                if input.remove("disabled") == Some(Bson::Boolean(true)) {
                    input.insert("banned", true);
                    input.insert("banReason", "Disabled in the system it was imported from");
                }
                if let Some(created_at) = created_at {
                    input.insert("createdAt", created_at);
                }
                self.create(input, password, accounts, now).await
            }
            .await;
            match result {
                Ok(_) => created += 1,
                Err(error) if error.code() == ErrorCode::Conflict => skipped += 1,
                Err(error) if error.code() == ErrorCode::ValidationFailed => {
                    failed.push(doc! { "email": label, "reason": error.message() })
                }
                Err(_) => failed.push(doc! { "email": label, "reason": "The user could not be created" }),
            }
        }
        failed.extend(refused);
        let failures =
            i32::try_from(failed.len()).map_err(|error| err(ErrorCode::Internal, error.to_string()))?;
        Ok(reply(200, &doc! { "created": created, "skipped": skipped, "failed": failed })?.audited(
            doc! { "action": "user.import", "details": {
                "created": created, "skipped": skipped, "failed": failures,
            } },
        ))
    }
}
