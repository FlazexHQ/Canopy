//! The parts of an X.509 certificate (RFC 5280) that the requirements of WebAuthn §8.2.1 name, read
//! without evaluating any trust path.

use crate::der::{self, Reader};

const OID_COUNTRY: &[u8] = &[0x55, 0x04, 0x06];
const OID_ORGANIZATION: &[u8] = &[0x55, 0x04, 0x0a];
const OID_ORGANIZATIONAL_UNIT: &[u8] = &[0x55, 0x04, 0x0b];
const OID_COMMON_NAME: &[u8] = &[0x55, 0x04, 0x03];
const OID_BASIC_CONSTRAINTS: &[u8] = &[0x55, 0x1d, 0x13];
const OID_KEY_USAGE: &[u8] = &[0x55, 0x1d, 0x0f];
const OID_EXTENDED_KEY_USAGE: &[u8] = &[0x55, 0x1d, 0x25];
const OID_SUBJECT_ALT_NAME: &[u8] = &[0x55, 0x1d, 0x11];
const OID_CERTIFICATE_POLICIES: &[u8] = &[0x55, 0x1d, 0x20];
/// 1.3.6.1.4.1.45724.1.1.4, the FIDO AAGUID extension.
const OID_FIDO_AAGUID: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0xe5, 0x1c, 0x01, 0x01, 0x04];
/// 1.2.840.10045.2.1, id-ecPublicKey.
const OID_EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
/// 1.2.840.10045.3.1.7, prime256v1.
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
/// 1.3.101.112, id-Ed25519.
const OID_ED25519: &[u8] = &[0x2b, 0x65, 0x70];
/// 1.2.840.113549.1.1.1, rsaEncryption.
const OID_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

const ORGANIZATIONAL_UNIT: &[u8] = b"Authenticator Attestation";

/// The public key of a certificate, in the form `ring` verifies.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CertificateKey {
    /// An uncompressed P-256 point.
    P256(Vec<u8>),
    /// An Ed25519 public key.
    Ed25519(Vec<u8>),
    /// The DER `RSAPublicKey`.
    Rsa(Vec<u8>),
}

/// The fields of an attestation certificate the relying party checks.
#[derive(Debug)]
pub(crate) struct AttestationCertificate {
    pub(crate) key: CertificateKey,
    pub(crate) aaguid: Option<[u8; 16]>,
}

/// Parses a leaf attestation certificate and checks what WebAuthn §8.2.1 requires without a trust anchor:
/// version 3; a subject with C, O, CN and the OU "Authenticator Attestation"; no basic constraints with CA
/// set; a non critical AAGUID extension of 16 bytes when present; no repeated extension and no critical
/// extension the relying party does not know.
pub(crate) fn parse_attestation_certificate(bytes: &[u8]) -> Result<AttestationCertificate, &'static str> {
    let certificate = der::single(bytes, der::SEQUENCE).ok_or("not a DER certificate")?;
    let mut certificate = Reader::new(certificate);
    let tbs = certificate.expect(der::SEQUENCE).ok_or("no TBSCertificate")?;
    certificate.expect(der::SEQUENCE).ok_or("no signature algorithm")?;
    certificate.expect(der::BIT_STRING).ok_or("no signature")?;
    if !certificate.is_empty() {
        return Err("data after the certificate signature");
    }

    let mut tbs = Reader::new(tbs);
    let version = tbs.expect(0xa0).ok_or("not a version 3 certificate")?;
    if der::single(version, der::INTEGER) != Some(&[2]) {
        return Err("not a version 3 certificate");
    }
    tbs.expect(der::INTEGER).ok_or("no serial number")?;
    tbs.expect(der::SEQUENCE).ok_or("no signature algorithm")?;
    tbs.expect(der::SEQUENCE).ok_or("no issuer")?;
    tbs.expect(der::SEQUENCE).ok_or("no validity")?;
    let subject = tbs.expect(der::SEQUENCE).ok_or("no subject")?;
    let spki = tbs.expect(der::SEQUENCE).ok_or("no subject public key info")?;
    tbs.optional(0x81).ok_or("malformed issuer unique id")?;
    tbs.optional(0x82).ok_or("malformed subject unique id")?;
    let extensions = tbs.optional(0xa3).ok_or("malformed extensions")?;
    if !tbs.is_empty() {
        return Err("unexpected fields in the TBSCertificate");
    }

    check_subject(subject)?;
    let key = public_key(spki)?;
    let aaguid = match extensions {
        Some(extensions) => check_extensions(extensions)?,
        None => None,
    };
    Ok(AttestationCertificate { key, aaguid })
}

fn check_subject(subject: &[u8]) -> Result<(), &'static str> {
    let mut country = false;
    let mut organization = false;
    let mut common_name = false;
    let mut unit = false;
    let mut names = Reader::new(subject);
    while !names.is_empty() {
        let set = names.expect(der::SET).ok_or("malformed subject")?;
        let mut attributes = Reader::new(set);
        while !attributes.is_empty() {
            let attribute = attributes.expect(der::SEQUENCE).ok_or("malformed subject")?;
            let mut attribute = Reader::new(attribute);
            let oid = attribute.expect(der::OID).ok_or("malformed subject")?;
            let (_, value) = attribute.any().ok_or("malformed subject")?;
            if !attribute.is_empty() {
                return Err("malformed subject");
            }
            let present = !value.is_empty();
            match oid {
                OID_COUNTRY => country = present,
                OID_ORGANIZATION => organization = present,
                OID_COMMON_NAME => common_name = present,
                OID_ORGANIZATIONAL_UNIT => unit = value == ORGANIZATIONAL_UNIT,
                _ => {}
            }
        }
    }
    if !unit {
        return Err("the subject OU is not \"Authenticator Attestation\"");
    }
    if !(country && organization && common_name) {
        return Err("the subject lacks C, O or CN");
    }
    Ok(())
}

fn public_key(spki: &[u8]) -> Result<CertificateKey, &'static str> {
    let mut spki = Reader::new(spki);
    let algorithm = spki.expect(der::SEQUENCE).ok_or("malformed public key")?;
    let bits = spki.expect(der::BIT_STRING).ok_or("malformed public key")?;
    if !spki.is_empty() {
        return Err("malformed public key");
    }
    let key = der::whole_bits(bits).ok_or("malformed public key")?.to_vec();
    let mut algorithm = Reader::new(algorithm);
    let oid = algorithm.expect(der::OID).ok_or("malformed public key algorithm")?;
    match oid {
        OID_EC_PUBLIC_KEY => {
            let curve = algorithm.expect(der::OID).ok_or("the EC key names no curve")?;
            if curve != OID_P256 || !algorithm.is_empty() {
                return Err("the EC key is not on P-256");
            }
            if key.len() != 65 || key.first() != Some(&0x04) {
                return Err("the EC key is not an uncompressed point");
            }
            Ok(CertificateKey::P256(key))
        }
        OID_ED25519 => {
            if !algorithm.is_empty() || key.len() != 32 {
                return Err("malformed Ed25519 key");
            }
            Ok(CertificateKey::Ed25519(key))
        }
        OID_RSA => {
            match algorithm.any() {
                Some((0x05, [])) if algorithm.is_empty() => {}
                None => {}
                _ => return Err("malformed RSA key parameters"),
            }
            Ok(CertificateKey::Rsa(key))
        }
        _ => Err("unsupported public key algorithm"),
    }
}

fn check_extensions(extensions: &[u8]) -> Result<Option<[u8; 16]>, &'static str> {
    let list = der::single(extensions, der::SEQUENCE).ok_or("malformed extensions")?;
    let mut list = Reader::new(list);
    let mut seen: Vec<&[u8]> = Vec::new();
    let mut aaguid = None;
    while !list.is_empty() {
        let extension = list.expect(der::SEQUENCE).ok_or("malformed extension")?;
        let mut extension = Reader::new(extension);
        let oid = extension.expect(der::OID).ok_or("malformed extension")?;
        let critical = match extension.optional(der::BOOLEAN).ok_or("malformed extension")? {
            None => false,
            Some([0xff]) => true,
            Some(_) => return Err("malformed critical flag"),
        };
        let value = extension.expect(der::OCTET_STRING).ok_or("malformed extension")?;
        if !extension.is_empty() {
            return Err("malformed extension");
        }
        if seen.contains(&oid) {
            return Err("an extension appears twice");
        }
        seen.push(oid);
        match oid {
            OID_BASIC_CONSTRAINTS => {
                if is_ca(value)? {
                    return Err("the basic constraints extension marks a CA");
                }
            }
            OID_FIDO_AAGUID => {
                if critical {
                    return Err("the AAGUID extension is critical");
                }
                let inner = der::single(value, der::OCTET_STRING).ok_or("malformed AAGUID extension")?;
                aaguid = Some(<[u8; 16]>::try_from(inner).map_err(|_| "malformed AAGUID extension")?);
            }
            OID_KEY_USAGE | OID_EXTENDED_KEY_USAGE | OID_SUBJECT_ALT_NAME | OID_CERTIFICATE_POLICIES => {}
            _ if critical => return Err("an unknown critical extension"),
            _ => {}
        }
    }
    Ok(aaguid)
}

fn is_ca(value: &[u8]) -> Result<bool, &'static str> {
    let constraints = der::single(value, der::SEQUENCE).ok_or("malformed basic constraints")?;
    let mut constraints = Reader::new(constraints);
    let ca = match constraints.optional(der::BOOLEAN).ok_or("malformed basic constraints")? {
        None => false,
        Some([0x00]) => false,
        Some([0xff]) => true,
        Some(_) => return Err("malformed basic constraints"),
    };
    if constraints.optional(der::INTEGER).ok_or("malformed basic constraints")?.is_some() && !ca {
        return Err("a path length without CA");
    }
    if !constraints.is_empty() {
        return Err("malformed basic constraints");
    }
    Ok(ca)
}
