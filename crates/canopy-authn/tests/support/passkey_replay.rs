use super::*;
use webauthn_support::{Authenticator, Key};

pub(super) struct ReplayPasskeys {
    authenticators: HashMap<String, Authenticator>,
    registrations: HashMap<String, u32>,
}

impl ReplayPasskeys {
    pub(super) fn load() -> Result<Self> {
        let manifest: Value =
            serde_json::from_str(&webauthn_support::read("conformance/auth/documents/manifest.json"))?;
        let mut authenticators = HashMap::new();
        for passkey in manifest["passkeys"].as_array().ok_or("Passkey manifest")? {
            let description = &passkey["authenticator"];
            let key = &description["jwk"];
            let decode = |field| -> Result<Vec<u8>> { Ok(URL_SAFE_NO_PAD.decode(str_at(key, field)?)?) };
            let d = decode("d")?;
            let x = decode("x")?;
            let key = match description["algorithm"].as_str() {
                Some("ES256") => Key::es256_from_jwk(&d, &x, &decode("y")?),
                Some("EdDSA") => Key::eddsa_from_jwk(&d, &x),
                _ => return Err("Unknown fixture passkey algorithm".into()),
            };
            let name = str_at(description, "name")?;
            authenticators.insert(
                name,
                Authenticator {
                    key,
                    credential_id: URL_SAFE_NO_PAD.decode(str_at(description, "credentialId")?)?,
                    aaguid: hex::decode(str_at(description, "aaguid")?)?
                        .try_into()
                        .map_err(|_| "Fixture AAGUID")?,
                    backed_up: description["backedUp"].as_bool().ok_or("Fixture backup state")?,
                },
            );
        }
        Ok(Self { authenticators, registrations: HashMap::new() })
    }

    pub(super) fn rebuild(
        &mut self,
        bindings: &mut Bindings,
        step: &Value,
        registration: bool,
    ) -> Result<()> {
        let details = &step["details"];
        let name = str_at(details, "authenticator")?;
        let authenticator = self.authenticators.get(&name).ok_or("Fixture authenticator")?;
        let incoming = &step["request"]["body"]["response"];
        assert_eq!(str_at(incoming, "rawId")?, URL_SAFE_NO_PAD.encode(&authenticator.credential_id));
        let wire = &incoming["response"];
        let client = &details["clientData"];
        let client_json = bindings.resolve(&client.to_string())?.into_bytes();
        bindings.bind(&str_at(wire, "clientDataJSON")?, &URL_SAFE_NO_PAD.encode(&client_json))?;
        if registration {
            let count = self.registrations.entry(name.clone()).or_default();
            if name == "device" {
                *count += 1;
            }
            let registration_name = step["request"]["body"]["name"].as_str();
            let mut flags = authenticator.flags(true);
            if registration_name == Some("No UV") {
                flags &= !webauthn_support::FLAG_UV;
            }
            let auth_data = webauthn_support::authenticator_data(
                "auth.canopy.test",
                flags,
                *count,
                &webauthn_support::attested(
                    &authenticator.aaguid,
                    &authenticator.credential_id,
                    &authenticator.key.cose(),
                ),
            );
            let packed = details["attestation"] == "packed";
            let attestation = if registration_name == Some("Bad sig") {
                webauthn_support::attestation_object(
                    "packed",
                    webauthn_support::text_map(vec![
                        ("alg", webauthn_support::int(authenticator.key.alg())),
                        ("sig", webauthn_support::bytes(&[1; 64])),
                    ]),
                    &auth_data,
                )
            } else {
                authenticator.register_with(client_json, auth_data, packed).attestation_object
            };
            bindings
                .compare_text(&str_at(wire, "attestationObject")?, &URL_SAFE_NO_PAD.encode(attestation))?;
        } else {
            let fields = &details["authenticatorData"];
            let rp_id_hash = hex::decode(str_at(fields, "rpIdHash")?)?;
            let flags = u8::try_from(fields["flags"].as_u64().ok_or("Authenticator flags")?)?;
            let count = u32::try_from(fields["signCount"].as_u64().ok_or("Authenticator counter")?)?;
            let auth_data = [rp_id_hash.as_slice(), &[flags], &count.to_be_bytes()].concat();
            assert_eq!(str_at(wire, "authenticatorData")?, URL_SAFE_NO_PAD.encode(&auth_data));
            let mut signed = authenticator.assert_with(client_json, auth_data).signature;
            if step["client"] == "a" {
                signed.fill(1);
            }
            bindings.bind(&str_at(wire, "signature")?, &URL_SAFE_NO_PAD.encode(signed))?;
        }
        Ok(())
    }
}
