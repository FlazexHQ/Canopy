//! Verification against the published AWS signing examples.

use canopy_sigv4::{Credentials, SignInput, sha256, sign_request};
use time::macros::datetime;
use url::Url;

#[test]
fn aws_s3_authorization_examples() -> Result<(), Box<dyn std::error::Error>> {
    let credentials = Credentials {
        access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
        session_token: None,
    };
    for (path, headers, expected) in [
        (
            "/test.txt",
            [("range".into(), "bytes=0-9".into())].into_iter().collect(),
            "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
        ),
        (
            "/?lifecycle",
            Default::default(),
            "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
        ),
    ] {
        let url = Url::parse(&format!("https://examplebucket.s3.amazonaws.com{path}"))?;
        let signed = sign_request(
            SignInput {
                method: "GET",
                url: &url,
                headers,
                payload_hash: &sha256(b""),
                region: "us-east-1",
                service: "s3",
                credentials: &credentials,
                now: datetime!(2013-05-24 00:00:00 UTC),
            },
            true,
        )?;
        let signature = signed
            .headers
            .get("authorization")
            .and_then(|auth| auth.split_once("Signature="))
            .map(|(_, signature)| signature);
        assert_eq!(signature, Some(expected));
    }
    Ok(())
}
