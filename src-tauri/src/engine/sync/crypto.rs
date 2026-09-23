//! Cryptographic core of AETHER sync & backup.
//!
//! Everything here is built from audited RustCrypto / BLAKE3 crates; no
//! primitive is implemented by hand.
//!
//! * **Key derivation** — Argon2id (v1.3, default m = 64 MiB, t = 3, p = 1)
//!   turns the passphrase plus a 16-byte random salt into a 32-byte master
//!   key ([`derive_master`]).
//! * **Sub-keys** — BLAKE3 `derive_key` with fixed, versioned context strings
//!   derives independent keys from the master ([`KeySet`]): one for file
//!   contents (`aether-sync-file-v1`), one for metadata such as indexes and
//!   device records (`aether-sync-meta-v1`) and one for keyed name hashing
//!   (`aether-sync-names-v1`).
//! * **Verifier** — `blake3(master || "verify")` is stored next to the salt so
//!   a wrong passphrase is detected before anything is decrypted. The
//!   passphrase itself is never persisted.
//! * **Envelope** — every encrypted object is
//!
//!   ```text
//!   "AETHSYN1" | u32 BE header length | header JSON | 12-byte nonce | AES-256-GCM ciphertext+tag
//!   ```
//!
//!   The plaintext header ([`EnvelopeHeader`]) is versioned JSON and, together
//!   with the magic and the length prefix, is the AEAD associated data: any
//!   change to the header, the nonce or the ciphertext makes decryption fail.
//!   Nonces are 96 random bits from the OS RNG, fresh for every encryption.
//! * **Name privacy** — file names in a sync folder or backup never contain a
//!   plaintext path or content hash; they are keyed BLAKE3 hashes
//!   ([`KeySet::path_hash`], [`KeySet::blob_id`]).
//!
//! All key material lives in [`Zeroizing`] buffers and is wiped on drop.

use std::fmt;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::engine::error::AetherError;

/// Length of every symmetric key (AES-256, BLAKE3 keys).
pub const KEY_LEN: usize = 32;
/// Length of the Argon2id salt.
pub const SALT_LEN: usize = 16;
/// Length of an AES-GCM nonce.
pub const NONCE_LEN: usize = 12;
/// Length of an AES-GCM authentication tag.
pub const TAG_LEN: usize = 16;
/// Magic bytes at the start of every envelope (format version 1).
pub const MAGIC: &[u8; 8] = b"AETHSYN1";
/// Version written into [`EnvelopeHeader::v`].
pub const FORMAT_VERSION: u32 = 1;
/// Upper bound for the plaintext header (defends against garbage input).
pub const MAX_HEADER_LEN: usize = 16 * 1024;
/// Minimum passphrase length (in characters) for new or changed passphrases.
pub const MIN_PASSPHRASE_CHARS: usize = 8;

const CTX_FILE: &str = "aether-sync-file-v1";
const CTX_META: &str = "aether-sync-meta-v1";
const CTX_NAMES: &str = "aether-sync-names-v1";
const VERIFY_SUFFIX: &[u8] = b"verify";

/// Argon2id memory floor accepted from stored parameters (OWASP minimum,
/// 19 MiB). Tests use tiny parameters so the floor is relaxed there.
const MIN_M_KIB: u32 = if cfg!(test) { 8 } else { 19 * 1024 };
/// Argon2id memory ceiling accepted from stored parameters (1 GiB) so a
/// crafted key file cannot make unlocking exhaust memory.
const MAX_M_KIB: u32 = 1024 * 1024;

/// Key-derivation algorithm identifier (only Argon2id exists in v1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KdfAlgorithm {
    /// Argon2id, RFC 9106.
    Argon2id,
}

/// Argon2id cost parameters, stored in plaintext next to the salt so any
/// device (or a future relay client) can re-derive the same key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    /// Algorithm, always `argon2id`.
    pub alg: KdfAlgorithm,
    /// Argon2 version number (`19` = v1.3).
    pub version: u32,
    /// Memory cost in KiB.
    pub m_kib: u32,
    /// Number of passes.
    pub t: u32,
    /// Degree of parallelism (lanes).
    pub p: u32,
}

impl KdfParams {
    /// Production parameters: Argon2id v1.3, 64 MiB, 3 passes, 1 lane.
    pub const DEFAULT: KdfParams = KdfParams {
        alg: KdfAlgorithm::Argon2id,
        version: 0x13,
        m_kib: 64 * 1024,
        t: 3,
        p: 1,
    };

    /// Cheap parameters for unit tests only.
    #[cfg(test)]
    pub const TESTING: KdfParams = KdfParams {
        alg: KdfAlgorithm::Argon2id,
        version: 0x13,
        m_kib: 64,
        t: 1,
        p: 1,
    };

    /// Reject parameters outside the supported, safe range. Stored
    /// parameters are untrusted input (they come from a shared folder).
    pub fn validate(&self) -> Result<(), AetherError> {
        if self.version != 0x13 {
            return Err(AetherError::InvalidInput(format!(
                "unsupported Argon2 version {}",
                self.version
            )));
        }
        if !(1..=16).contains(&self.p) {
            return Err(AetherError::InvalidInput(format!(
                "Argon2 parallelism {} is out of range",
                self.p
            )));
        }
        if !(1..=10).contains(&self.t) {
            return Err(AetherError::InvalidInput(format!(
                "Argon2 pass count {} is out of range",
                self.t
            )));
        }
        if self.m_kib < MIN_M_KIB.max(8 * self.p) || self.m_kib > MAX_M_KIB {
            return Err(AetherError::InvalidInput(format!(
                "Argon2 memory cost {} KiB is out of range",
                self.m_kib
            )));
        }
        Ok(())
    }
}

/// The 32-byte master key derived from the passphrase. Wiped on drop and
/// never printed.
pub struct MasterKey(Zeroizing<[u8; KEY_LEN]>);

impl MasterKey {
    /// Wrap raw key bytes (e.g. read back from the opt-in key file).
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Borrow the raw key bytes.
    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MasterKey(<redacted>)")
    }
}

/// Derive the master key with Argon2id.
pub fn derive_master(
    passphrase: &[u8],
    salt: &[u8; SALT_LEN],
    params: &KdfParams,
) -> Result<MasterKey, AetherError> {
    params.validate()?;
    let argon_params = Params::new(params.m_kib, params.t, params.p, Some(KEY_LEN))
        .map_err(|e| AetherError::InvalidInput(format!("Argon2 parameters: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(passphrase, salt, out.as_mut())
        .map_err(|e| AetherError::InvalidInput(format!("key derivation failed: {e}")))?;
    Ok(MasterKey(out))
}

/// A fresh random salt from the OS RNG.
pub fn random_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// Parse a hex salt as stored in key files and headers.
pub fn parse_salt(hex_salt: &str) -> Result<[u8; SALT_LEN], AetherError> {
    let bytes = hex::decode(hex_salt.trim())
        .map_err(|_| AetherError::InvalidInput("salt is not valid hex".into()))?;
    bytes
        .try_into()
        .map_err(|_| AetherError::InvalidInput("salt must be 16 bytes".into()))
}

/// `blake3(master || "verify")` — lets a device check a passphrase without
/// decrypting anything.
pub fn verifier_of(master: &MasterKey) -> blake3::Hash {
    let mut hasher = blake3::Hasher::new();
    hasher.update(master.as_bytes());
    hasher.update(VERIFY_SUFFIX);
    hasher.finalize()
}

/// Plain BLAKE3 content hash (hex). Only ever stored *inside* encrypted
/// indexes; names on disk use [`KeySet::blob_id`] instead.
pub fn content_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Validate the length of a new passphrase.
pub fn check_new_passphrase(passphrase: &str) -> Result<(), AetherError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(AetherError::InvalidInput(format!(
            "the passphrase must be at least {MIN_PASSPHRASE_CHARS} characters long"
        )));
    }
    Ok(())
}

/// What an envelope contains; part of the authenticated header so one kind
/// of object can never be substituted for another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeKind {
    /// File content in a sync folder.
    Blob,
    /// A device's file index in a sync folder.
    Index,
    /// A device record (name, platform, last seen).
    Device,
    /// A conflict record.
    Conflict,
    /// The file list of a backup archive.
    BackupIndex,
    /// File content inside a backup archive.
    BackupBlob,
}

/// Versioned plaintext header of an envelope. It is authenticated (AAD) but
/// not secret: it carries only what another device needs to pick the key
/// and validate the object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvelopeHeader {
    /// Format version ([`FORMAT_VERSION`]).
    pub v: u32,
    /// Object kind.
    pub kind: EnvelopeKind,
    /// KDF parameters of the key that encrypted this object.
    pub kdf: KdfParams,
    /// Hex salt of that key (identifies the passphrase epoch).
    pub salt: String,
    /// Device that wrote the object.
    pub device_id: String,
    /// Keyed hash of the logical path, when the object belongs to one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_hash: Option<String>,
    /// Modification time of the source file (ms since the Unix epoch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
    /// Plaintext size in bytes.
    pub size: u64,
    /// Keyed content id ([`KeySet::blob_id`]) for blobs, or a binding hash
    /// for backup indexes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

/// Fields of a header that vary per object; the rest comes from the key.
#[derive(Debug, Clone, Default)]
pub struct HeaderFields {
    /// Writer device id.
    pub device_id: String,
    /// See [`EnvelopeHeader::path_hash`].
    pub path_hash: Option<String>,
    /// See [`EnvelopeHeader::mtime`].
    pub mtime: Option<i64>,
    /// See [`EnvelopeHeader::content_hash`].
    pub content_hash: Option<String>,
}

/// Seal `plaintext` with AES-256-GCM under `key`; the serialized header is
/// authenticated as associated data. A fresh random nonce is used.
pub fn seal_with_key(
    key: &[u8; KEY_LEN],
    header: &EnvelopeHeader,
    plaintext: &[u8],
) -> Result<Vec<u8>, AetherError> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    seal_with_nonce(key, header, plaintext, &nonce)
}

fn seal_with_nonce(
    key: &[u8; KEY_LEN],
    header: &EnvelopeHeader,
    plaintext: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, AetherError> {
    let header_json = serde_json::to_vec(header)
        .map_err(|e| AetherError::InvalidInput(format!("header serialize: {e}")))?;
    if header_json.len() > MAX_HEADER_LEN {
        return Err(AetherError::InvalidInput(
            "envelope header too large".into(),
        ));
    }
    let mut out = Vec::with_capacity(
        MAGIC.len() + 4 + header_json.len() + NONCE_LEN + plaintext.len() + TAG_LEN,
    );
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(header_json.len() as u32).to_be_bytes());
    out.extend_from_slice(&header_json);
    let ciphertext = aead_encrypt(key, nonce, plaintext, &out)?;
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Raw AES-256-GCM encryption (ciphertext || tag).
fn aead_encrypt(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, AetherError> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AetherError::InvalidInput("invalid key length".into()))?;
    cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| AetherError::InvalidInput("encryption failed".into()))
}

/// Raw AES-256-GCM decryption; fails on any tampering.
fn aead_decrypt(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, AetherError> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AetherError::InvalidInput("invalid key length".into()))?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| {
            AetherError::InvalidInput(
                "decryption failed: the data was modified or belongs to a different passphrase"
                    .into(),
            )
        })
}

/// Parse and return the plaintext header without decrypting (used to route
/// an object to the right key epoch). Returns the header and the offset at
/// which the nonce starts.
pub fn peek_header(bytes: &[u8]) -> Result<(EnvelopeHeader, usize), AetherError> {
    let prefix = MAGIC.len() + 4;
    if bytes.len() < prefix || &bytes[..MAGIC.len()] != MAGIC {
        return Err(AetherError::InvalidInput(
            "not an AETHER encrypted object (bad magic)".into(),
        ));
    }
    let mut len_bytes = [0u8; 4];
    len_bytes.copy_from_slice(&bytes[MAGIC.len()..prefix]);
    let header_len = u32::from_be_bytes(len_bytes) as usize;
    if header_len == 0 || header_len > MAX_HEADER_LEN || bytes.len() < prefix + header_len {
        return Err(AetherError::InvalidInput("corrupt envelope header".into()));
    }
    let header: EnvelopeHeader = serde_json::from_slice(&bytes[prefix..prefix + header_len])
        .map_err(|e| AetherError::InvalidInput(format!("corrupt envelope header: {e}")))?;
    if header.v != FORMAT_VERSION {
        return Err(AetherError::InvalidInput(format!(
            "unsupported envelope version {}",
            header.v
        )));
    }
    Ok((header, prefix + header_len))
}

/// Decrypt an envelope with `key`, returning the authenticated header and
/// the plaintext.
pub fn open_with_key(
    key: &[u8; KEY_LEN],
    bytes: &[u8],
) -> Result<(EnvelopeHeader, Vec<u8>), AetherError> {
    let (header, header_end) = peek_header(bytes)?;
    if bytes.len() < header_end + NONCE_LEN + TAG_LEN {
        return Err(AetherError::InvalidInput("truncated envelope".into()));
    }
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[header_end..header_end + NONCE_LEN]);
    let plaintext = aead_decrypt(
        key,
        &nonce,
        &bytes[header_end + NONCE_LEN..],
        &bytes[..header_end],
    )?;
    if plaintext.len() as u64 != header.size {
        return Err(AetherError::InvalidInput(
            "envelope size does not match its header".into(),
        ));
    }
    Ok((header, plaintext))
}

/// The unlocked key material: master key plus the derived sub-keys, salt and
/// KDF parameters of the passphrase epoch. Everything is wiped on drop.
pub struct KeySet {
    master: MasterKey,
    file_key: Zeroizing<[u8; KEY_LEN]>,
    meta_key: Zeroizing<[u8; KEY_LEN]>,
    names_key: Zeroizing<[u8; KEY_LEN]>,
    salt: [u8; SALT_LEN],
    kdf: KdfParams,
}

impl fmt::Debug for KeySet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeySet")
            .field("salt", &self.salt_hex())
            .field("kdf", &self.kdf)
            .finish_non_exhaustive()
    }
}

impl KeySet {
    /// Derive all sub-keys from `master`.
    pub fn new(master: MasterKey, salt: [u8; SALT_LEN], kdf: KdfParams) -> Self {
        let file_key = Zeroizing::new(blake3::derive_key(CTX_FILE, master.as_bytes()));
        let meta_key = Zeroizing::new(blake3::derive_key(CTX_META, master.as_bytes()));
        let names_key = Zeroizing::new(blake3::derive_key(CTX_NAMES, master.as_bytes()));
        Self {
            master,
            file_key,
            meta_key,
            names_key,
            salt,
            kdf,
        }
    }

    /// Run Argon2id and build the key set in one step.
    pub fn derive(
        passphrase: &str,
        salt: [u8; SALT_LEN],
        kdf: KdfParams,
    ) -> Result<Self, AetherError> {
        let master = derive_master(passphrase.as_bytes(), &salt, &kdf)?;
        Ok(Self::new(master, salt, kdf))
    }

    /// The master key (only used to persist it when the user opts in).
    pub fn master(&self) -> &MasterKey {
        &self.master
    }

    /// Salt as lowercase hex.
    pub fn salt_hex(&self) -> String {
        hex::encode(self.salt)
    }

    /// KDF parameters of this epoch.
    pub fn kdf(&self) -> KdfParams {
        self.kdf
    }

    /// Hex verifier (`blake3(master || "verify")`).
    pub fn verifier_hex(&self) -> String {
        verifier_of(&self.master).to_hex().to_string()
    }

    /// Constant-time comparison against a stored hex verifier.
    pub fn matches_verifier(&self, stored_hex: &str) -> bool {
        match blake3::Hash::from_hex(stored_hex.trim()) {
            // `blake3::Hash` implements constant-time equality.
            Ok(stored) => stored == verifier_of(&self.master),
            Err(_) => false,
        }
    }

    /// Keyed hash of a logical path (hex). Deterministic per passphrase.
    pub fn path_hash(&self, path: &str) -> String {
        let mut hasher = blake3::Hasher::new_keyed(&self.names_key);
        hasher.update(b"path\0");
        hasher.update(path.as_bytes());
        hasher.finalize().to_hex().to_string()
    }

    /// Keyed, content-addressed blob name for a plaintext content hash. Equal
    /// contents map to the same blob (dedupe) without revealing the hash.
    pub fn blob_id(&self, content_hash_hex: &str) -> String {
        let mut hasher = blake3::Hasher::new_keyed(&self.names_key);
        hasher.update(b"blob\0");
        hasher.update(content_hash_hex.as_bytes());
        hasher.finalize().to_hex().to_string()
    }

    /// Header for an object encrypted with this key.
    pub fn header(&self, kind: EnvelopeKind, fields: HeaderFields, size: u64) -> EnvelopeHeader {
        EnvelopeHeader {
            v: FORMAT_VERSION,
            kind,
            kdf: self.kdf,
            salt: self.salt_hex(),
            device_id: fields.device_id,
            path_hash: fields.path_hash,
            mtime: fields.mtime,
            size,
            content_hash: fields.content_hash,
        }
    }

    fn key_for(&self, kind: EnvelopeKind) -> &[u8; KEY_LEN] {
        match kind {
            EnvelopeKind::Blob | EnvelopeKind::BackupBlob => &self.file_key,
            EnvelopeKind::Index
            | EnvelopeKind::Device
            | EnvelopeKind::Conflict
            | EnvelopeKind::BackupIndex => &self.meta_key,
        }
    }

    /// Encrypt an object of `kind` (file key for contents, meta key for
    /// everything else).
    pub fn seal(
        &self,
        kind: EnvelopeKind,
        fields: HeaderFields,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, AetherError> {
        let header = self.header(kind, fields, plaintext.len() as u64);
        seal_with_key(self.key_for(kind), &header, plaintext)
    }

    /// Decrypt an object and check that it is of the `expected` kind and was
    /// written under this passphrase epoch.
    pub fn open(
        &self,
        expected: EnvelopeKind,
        bytes: &[u8],
    ) -> Result<(EnvelopeHeader, Vec<u8>), AetherError> {
        let (header, _) = peek_header(bytes)?;
        if header.kind != expected {
            return Err(AetherError::InvalidInput(format!(
                "unexpected object kind {:?} (expected {:?})",
                header.kind, expected
            )));
        }
        if header.salt != self.salt_hex() {
            return Err(AetherError::InvalidInput(
                "this object was encrypted with a different passphrase".into(),
            ));
        }
        open_with_key(self.key_for(expected), bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn test_keys(passphrase: &str) -> KeySet {
        KeySet::derive(passphrase, [7u8; SALT_LEN], KdfParams::TESTING).expect("derive")
    }

    fn fields() -> HeaderFields {
        HeaderFields {
            device_id: "device-a".into(),
            path_hash: Some("p".into()),
            mtime: Some(1_700_000_000_000),
            content_hash: Some("c".into()),
        }
    }

    // ── Known-answer tests for the primitives exactly as configured ──

    /// RFC 9106 §5.3 Argon2id test vector, run through the same algorithm
    /// and version selection `derive_master` uses.
    #[test]
    fn argon2id_matches_rfc9106_vector() {
        let params = argon2::ParamsBuilder::new()
            .m_cost(32)
            .t_cost(3)
            .p_cost(4)
            .data(argon2::AssociatedData::new(&[0x04; 12]).unwrap())
            .output_len(32)
            .build()
            .unwrap();
        let ctx = Argon2::new_with_secret(&[0x03; 8], Algorithm::Argon2id, Version::V0x13, params)
            .unwrap();
        let mut out = [0u8; 32];
        ctx.hash_password_into(&[0x01; 32], &[0x02; 16], &mut out)
            .unwrap();
        assert_eq!(
            hex::encode(out),
            "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"
        );
    }

    /// NIST CAVS `gcmEncryptExtIV256.rsp` vector through our AEAD helpers.
    #[test]
    fn aes256gcm_matches_nist_vector() {
        let key: [u8; 32] =
            hex::decode("92e11dcdaa866f5ce790fd24501f92509aacf4cb8b1339d50c9c1240935dd08b")
                .unwrap()
                .try_into()
                .unwrap();
        let nonce: [u8; 12] = hex::decode("ac93a1a6145299bde902f21a")
            .unwrap()
            .try_into()
            .unwrap();
        let plaintext = hex::decode("2d71bcfa914e4ac045b2aa60955fad24").unwrap();
        let aad = hex::decode("1e0889016f67601c8ebea4943bc23ad6").unwrap();
        let out = aead_encrypt(&key, &nonce, &plaintext, &aad).unwrap();
        assert_eq!(
            hex::encode(&out),
            "8995ae2e6df3dbf96fac7b7137bae67feca5aa77d51d4a0a14d9c51e1da474ab"
        );
        assert_eq!(aead_decrypt(&key, &nonce, &out, &aad).unwrap(), plaintext);
    }

    /// Official BLAKE3 test vectors (hash, keyed hash, derive_key).
    #[test]
    fn blake3_matches_official_vectors() {
        let input: Vec<u8> = (0..1025u32).map(|i| (i % 251) as u8).collect();
        let key = *b"whats the Elvish word for friend";
        let context = "BLAKE3 2019-12-27 16:29:52 test vectors context";
        assert_eq!(
            content_hash(&[]),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
        assert_eq!(
            content_hash(&input),
            "d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444"
        );
        assert_eq!(
            blake3::keyed_hash(&key, &input).to_hex().as_str(),
            "357dc55de0c7e382c900fd6e320acc04146be01db6a8ce7210b7189bd664ea69"
        );
        assert_eq!(
            hex::encode(blake3::derive_key(context, &input)),
            "effaa245f065fbf82ac186839a249707c3bddf6d3fdda22d1b95a3c970379bcb"
        );
    }

    #[test]
    fn default_kdf_parameters_match_the_spec() {
        let d = KdfParams::DEFAULT;
        assert_eq!(d.alg, KdfAlgorithm::Argon2id);
        assert_eq!(d.version, 0x13);
        assert_eq!(d.m_kib, 65_536);
        assert_eq!(d.t, 3);
        assert_eq!(d.p, 1);
        assert!(d.validate().is_ok());
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"alg\":\"argon2id\""));
    }

    #[test]
    fn kdf_rejects_hostile_parameters() {
        let mut p = KdfParams::TESTING;
        p.m_kib = MAX_M_KIB + 1;
        assert!(p.validate().is_err());
        let mut p = KdfParams::TESTING;
        p.t = 0;
        assert!(p.validate().is_err());
        let mut p = KdfParams::TESTING;
        p.version = 0x10;
        assert!(p.validate().is_err());
        let mut p = KdfParams::TESTING;
        p.p = 0;
        assert!(p.validate().is_err());
    }

    // ── Envelope behaviour ──

    #[test]
    fn round_trip_encrypt_decrypt() {
        let keys = test_keys("correct horse battery staple");
        let message = b"# Secret note\n\nhello";
        let sealed = keys.seal(EnvelopeKind::Blob, fields(), message).unwrap();
        assert!(!sealed
            .windows(message.len())
            .any(|w| w == message.as_slice()));
        let (header, plaintext) = keys.open(EnvelopeKind::Blob, &sealed).unwrap();
        assert_eq!(plaintext, message);
        assert_eq!(header.size, message.len() as u64);
        assert_eq!(header.device_id, "device-a");
        assert_eq!(header.salt, keys.salt_hex());
        assert_eq!(header.kdf, KdfParams::TESTING);
    }

    #[test]
    fn empty_plaintext_round_trips() {
        let keys = test_keys("correct horse battery staple");
        let sealed = keys.seal(EnvelopeKind::Index, fields(), b"").unwrap();
        let (_, plaintext) = keys.open(EnvelopeKind::Index, &sealed).unwrap();
        assert!(plaintext.is_empty());
    }

    #[test]
    fn wrong_passphrase_fails_to_decrypt() {
        let right = test_keys("correct horse battery staple");
        let wrong = test_keys("correct horse battery stapler");
        let sealed = right.seal(EnvelopeKind::Blob, fields(), b"data").unwrap();
        assert!(wrong.open(EnvelopeKind::Blob, &sealed).is_err());
        assert!(!wrong.matches_verifier(&right.verifier_hex()));
    }

    #[test]
    fn different_salt_is_rejected_before_decryption() {
        let a = test_keys("same passphrase");
        let b = KeySet::derive("same passphrase", [9u8; SALT_LEN], KdfParams::TESTING).unwrap();
        let sealed = a.seal(EnvelopeKind::Blob, fields(), b"data").unwrap();
        let err = b.open(EnvelopeKind::Blob, &sealed).unwrap_err().to_string();
        assert!(err.contains("different passphrase"));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let keys = test_keys("correct horse battery staple");
        let sealed = keys
            .seal(EnvelopeKind::Blob, fields(), b"payload bytes")
            .unwrap();
        let (_, header_end) = peek_header(&sealed).unwrap();
        // Flip one bit in every region after the header: nonce, ciphertext, tag.
        for idx in [header_end, header_end + NONCE_LEN, sealed.len() - 1] {
            let mut bad = sealed.clone();
            bad[idx] ^= 0x01;
            assert!(keys.open(EnvelopeKind::Blob, &bad).is_err(), "byte {idx}");
        }
        // Truncation.
        assert!(keys
            .open(EnvelopeKind::Blob, &sealed[..sealed.len() - 1])
            .is_err());
    }

    #[test]
    fn tampered_header_aad_fails() {
        let keys = test_keys("correct horse battery staple");
        let sealed = keys.seal(EnvelopeKind::Blob, fields(), b"payload").unwrap();
        // Rewrite the (plaintext) header with a different mtime but keep the
        // length so the envelope still parses: AAD mismatch must be caught.
        let text = String::from_utf8_lossy(&sealed).to_string();
        assert!(text.contains("1700000000000"));
        let forged: Vec<u8> = {
            let (_, header_end) = peek_header(&sealed).unwrap();
            let header = std::str::from_utf8(&sealed[12..header_end]).unwrap();
            let changed = header.replace("1700000000000", "1700000000001");
            assert_eq!(changed.len(), header.len());
            let mut v = sealed[..12].to_vec();
            v.extend_from_slice(changed.as_bytes());
            v.extend_from_slice(&sealed[header_end..]);
            v
        };
        assert!(peek_header(&forged).is_ok());
        assert!(keys.open(EnvelopeKind::Blob, &forged).is_err());
        // A wrong magic is rejected outright.
        let mut bad_magic = sealed.clone();
        bad_magic[0] = b'X';
        assert!(keys.open(EnvelopeKind::Blob, &bad_magic).is_err());
    }

    #[test]
    fn object_kind_cannot_be_substituted() {
        let keys = test_keys("correct horse battery staple");
        let sealed = keys.seal(EnvelopeKind::Conflict, fields(), b"{}").unwrap();
        assert!(keys.open(EnvelopeKind::Index, &sealed).is_err());
        assert!(keys.open(EnvelopeKind::Conflict, &sealed).is_ok());
    }

    #[test]
    fn nonces_are_unique_across_10k_encryptions() {
        let keys = test_keys("correct horse battery staple");
        let mut seen = HashSet::new();
        for _ in 0..10_000 {
            let sealed = keys.seal(EnvelopeKind::Blob, fields(), b"x").unwrap();
            let (_, header_end) = peek_header(&sealed).unwrap();
            let nonce = sealed[header_end..header_end + NONCE_LEN].to_vec();
            assert!(seen.insert(nonce), "nonce reused");
        }
        assert_eq!(seen.len(), 10_000);
    }

    #[test]
    fn kdf_verifier_accepts_right_and_rejects_wrong_passphrase() {
        let salt = random_salt();
        let a = KeySet::derive("tangerine dream 42", salt, KdfParams::TESTING).unwrap();
        let again = KeySet::derive("tangerine dream 42", salt, KdfParams::TESTING).unwrap();
        let wrong = KeySet::derive("tangerine dream 43", salt, KdfParams::TESTING).unwrap();
        let verifier = a.verifier_hex();
        assert_eq!(verifier.len(), 64);
        assert!(again.matches_verifier(&verifier));
        assert!(!wrong.matches_verifier(&verifier));
        assert!(!a.matches_verifier("not hex"));
        // The verifier is exactly blake3(master || "verify").
        let mut concat = a.master().as_bytes().to_vec();
        concat.extend_from_slice(b"verify");
        assert_eq!(blake3::hash(&concat).to_hex().as_str(), verifier);
    }

    #[test]
    fn path_hashing_is_deterministic_and_keyed() {
        let a = test_keys("correct horse battery staple");
        let a2 = test_keys("correct horse battery staple");
        let b = test_keys("another passphrase entirely");
        let h = a.path_hash("vault/Projects/Plan.md");
        assert_eq!(h, a2.path_hash("vault/Projects/Plan.md"));
        assert_eq!(h.len(), 64);
        assert_ne!(h, a.path_hash("vault/Projects/plan.md"));
        assert_ne!(h, b.path_hash("vault/Projects/Plan.md"));
        assert_ne!(h, content_hash(b"vault/Projects/Plan.md"));
        let content = content_hash(b"body");
        assert_eq!(a.blob_id(&content), a2.blob_id(&content));
        assert_ne!(a.blob_id(&content), b.blob_id(&content));
        assert_ne!(a.blob_id(&content), content);
    }

    #[test]
    fn subkeys_are_independent() {
        let keys = test_keys("correct horse battery staple");
        assert_ne!(*keys.file_key, *keys.meta_key);
        assert_ne!(*keys.meta_key, *keys.names_key);
        assert_ne!(*keys.file_key, *keys.master.as_bytes());
        assert_eq!(
            *keys.file_key,
            blake3::derive_key("aether-sync-file-v1", keys.master.as_bytes())
        );
    }

    #[test]
    fn debug_output_never_contains_key_material() {
        let keys = test_keys("correct horse battery staple");
        let rendered = format!("{keys:?} {:?}", keys.master());
        assert!(!rendered.contains(&hex::encode(keys.master().as_bytes())));
        assert!(rendered.contains("redacted") || rendered.contains(".."));
    }

    #[test]
    fn salt_parsing_validates_length() {
        let salt = random_salt();
        assert_eq!(parse_salt(&hex::encode(salt)).unwrap(), salt);
        assert!(parse_salt("abcd").is_err());
        assert!(parse_salt("zz").is_err());
    }

    #[test]
    fn new_passphrase_minimum_length() {
        assert!(check_new_passphrase("short").is_err());
        assert!(check_new_passphrase("long enough").is_ok());
        // Counts characters, not bytes.
        assert!(check_new_passphrase("äöüäöüä").is_err());
    }
}
