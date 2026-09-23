//! Update check against the project's GitHub releases.
//!
//! This is a *check* only: it asks the public GitHub API for the latest
//! published release, compares versions with a strict SemVer 2.0 parser
//! and reports the result. Nothing is downloaded or installed; the UI links
//! the user to the release page. The single outbound request goes to
//! `https://api.github.com` with an 8 s timeout and no credentials.

use std::cmp::Ordering;
use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::engine::error::AetherError;

/// GitHub API endpoint for the newest non-draft, non-prerelease release.
pub const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/EkexDon/AETHER-OS/releases/latest";
/// Human-facing releases page, used when no release has been published yet.
pub const RELEASES_PAGE_URL: &str = "https://github.com/EkexDon/AETHER-OS/releases";
/// Path prefix every release link from the API must start with.
const REPO_PATH_PREFIX: &str = "/EkexDon/AETHER-OS/";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Largest release response read from the API (release notes included).
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// Result of an update check.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UpdateInfo {
    /// Version of the running build (normalised, without a leading `v`).
    pub current: String,
    /// Latest published version (equals `current` when nothing is published).
    pub latest: String,
    pub update_available: bool,
    /// Release page to open in the browser.
    pub url: String,
    /// Release notes (Markdown) of the latest release.
    pub notes: String,
    /// RFC 3339 publication time of the latest release.
    pub published_at: Option<String>,
}

/// Subset of the GitHub release payload we use.
#[derive(Debug, Clone, Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    #[serde(default)]
    pub html_url: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
}

/// A pre-release identifier (`alpha`, `1`, `rc`…).
#[derive(Debug, Clone, PartialEq, Eq)]
enum PreRelease {
    Numeric(u64),
    Alpha(String),
}

impl PartialOrd for PreRelease {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PreRelease {
    /// SemVer §11.4: numeric identifiers compare numerically and always
    /// have lower precedence than alphanumeric ones, which compare in
    /// ASCII order.
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Numeric(a), Self::Numeric(b)) => a.cmp(b),
            (Self::Numeric(_), Self::Alpha(_)) => Ordering::Less,
            (Self::Alpha(_), Self::Numeric(_)) => Ordering::Greater,
            (Self::Alpha(a), Self::Alpha(b)) => a.cmp(b),
        }
    }
}

/// A strictly parsed SemVer 2.0.0 version. Build metadata is accepted but
/// ignored for precedence, as the spec requires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pre: Vec<PreRelease>,
}

impl Version {
    /// Parse `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`, optionally prefixed
    /// with `v`/`V` (the usual git tag style). Leading zeros, empty
    /// identifiers and non-ASCII characters are rejected.
    pub fn parse(input: &str) -> Result<Self, AetherError> {
        let invalid =
            |why: &str| AetherError::InvalidInput(format!("invalid version \"{input}\": {why}"));
        let trimmed = input.trim();
        let raw = trimmed
            .strip_prefix('v')
            .or_else(|| trimmed.strip_prefix('V'))
            .unwrap_or(trimmed);
        if raw.is_empty() {
            return Err(invalid("empty"));
        }

        let (without_build, build) = match raw.split_once('+') {
            Some((v, b)) => (v, Some(b)),
            None => (raw, None),
        };
        if let Some(build) = build {
            if build.split('.').any(|id| !is_valid_identifier(id)) {
                return Err(invalid("malformed build metadata"));
            }
        }

        let (core, pre) = match without_build.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (without_build, None),
        };

        let parts: Vec<&str> = core.split('.').collect();
        if parts.len() != 3 {
            return Err(invalid("expected MAJOR.MINOR.PATCH"));
        }
        let number = |s: &str| -> Result<u64, AetherError> {
            if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid("version numbers must be digits"));
            }
            if s.len() > 1 && s.starts_with('0') {
                return Err(invalid("leading zeros are not allowed"));
            }
            s.parse::<u64>().map_err(|_| invalid("number out of range"))
        };

        let pre = match pre {
            None => Vec::new(),
            Some(pre) => pre
                .split('.')
                .map(|id| {
                    if !is_valid_identifier(id) {
                        return Err(invalid("malformed pre-release identifier"));
                    }
                    if id.bytes().all(|b| b.is_ascii_digit()) {
                        number(id).map(PreRelease::Numeric)
                    } else {
                        Ok(PreRelease::Alpha(id.to_owned()))
                    }
                })
                .collect::<Result<Vec<_>, _>>()?,
        };

        Ok(Self {
            major: number(parts[0])?,
            minor: number(parts[1])?,
            patch: number(parts[2])?,
            pre,
        })
    }
}

fn is_valid_identifier(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then(self.minor.cmp(&other.minor))
            .then(self.patch.cmp(&other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                // A release outranks any of its pre-releases (§11.3).
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => self.pre.cmp(&other.pre),
            })
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.pre.is_empty() {
            let pre: Vec<String> = self
                .pre
                .iter()
                .map(|p| match p {
                    PreRelease::Numeric(n) => n.to_string(),
                    PreRelease::Alpha(s) => s.clone(),
                })
                .collect();
            write!(f, "-{}", pre.join("."))?;
        }
        Ok(())
    }
}

/// The release link from the API response, if it is a plain
/// `https://github.com/EkexDon/AETHER-OS/…` URL (exact host, no
/// credentials, no custom port, the project's path prefix). The UI opens
/// this URL in the browser, so anything else falls back to the releases
/// page.
pub fn trusted_release_url(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    let prefix_ok = url
        .path()
        .get(..REPO_PATH_PREFIX.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(REPO_PATH_PREFIX));
    (url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && prefix_ok)
        .then(|| url.to_string())
}

/// Compare `current` with a GitHub release and build the [`UpdateInfo`].
pub fn evaluate_release(current: &str, release: &GithubRelease) -> Result<UpdateInfo, AetherError> {
    let current_version = Version::parse(current)?;
    let latest_version = Version::parse(&release.tag_name)?;
    Ok(UpdateInfo {
        current: current_version.to_string(),
        latest: latest_version.to_string(),
        update_available: latest_version > current_version,
        url: release
            .html_url
            .as_deref()
            .and_then(trusted_release_url)
            .unwrap_or_else(|| RELEASES_PAGE_URL.to_owned()),
        notes: release.body.clone().unwrap_or_default(),
        published_at: release.published_at.clone(),
    })
}

/// Check GitHub for a newer release than `current`.
///
/// Offline, timeouts, rate limits and malformed responses all surface as a
/// readable [`AetherError::Network`]; a repository without any published
/// release reports "up to date".
pub async fn check_for_updates(current: &str) -> Result<UpdateInfo, AetherError> {
    check_for_updates_at(LATEST_RELEASE_URL, current).await
}

/// [`check_for_updates`] against an explicit endpoint (tests use a local
/// server).
pub async fn check_for_updates_at(
    endpoint: &str,
    current: &str,
) -> Result<UpdateInfo, AetherError> {
    // Validate before any network traffic so a broken build version is
    // reported as such, not as a network problem.
    let current_version = Version::parse(current)?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(format!(
            "AETHER-OS/{current_version} (+https://github.com/EkexDon/AETHER-OS)"
        ))
        .build()
        .map_err(|e| AetherError::Network(format!("cannot create HTTP client: {e}")))?;

    let response = client
        .get(endpoint)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                AetherError::Network("update check timed out — are you offline?".to_owned())
            } else {
                AetherError::Network(format!(
                    "could not reach GitHub to check for updates — are you offline? ({e})"
                ))
            }
        })?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        // No release has been published yet: nothing newer exists.
        return Ok(UpdateInfo {
            current: current_version.to_string(),
            latest: current_version.to_string(),
            update_available: false,
            url: RELEASES_PAGE_URL.to_owned(),
            notes: String::new(),
            published_at: None,
        });
    }
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        return Err(AetherError::Network(
            "GitHub rate limit reached — try the update check again later".to_owned(),
        ));
    }
    if !status.is_success() {
        return Err(AetherError::Network(format!(
            "GitHub answered the update check with HTTP {status}"
        )));
    }

    let too_large = || AetherError::Network("the update response is unexpectedly large".to_owned());
    if response
        .content_length()
        .is_some_and(|len| len > MAX_RESPONSE_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AetherError::Network(format!("unexpected update response: {e}")))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(too_large());
        }
    }
    let release: GithubRelease = serde_json::from_slice(&body)
        .map_err(|e| AetherError::Network(format!("unexpected update response: {e}")))?;
    evaluate_release(&current_version.to_string(), &release)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|e| panic!("{s} must parse: {e}"))
    }

    #[test]
    fn parses_plain_prefixed_and_extended_versions() {
        assert_eq!(v("1.2.3").to_string(), "1.2.3");
        assert_eq!(v("v0.2.0").to_string(), "0.2.0");
        assert_eq!(v("V10.20.30").to_string(), "10.20.30");
        assert_eq!(v("1.0.0-alpha.1").to_string(), "1.0.0-alpha.1");
        assert_eq!(v("1.0.0+build.5").to_string(), "1.0.0");
        assert_eq!(v("1.0.0-rc.1+sha.abc").to_string(), "1.0.0-rc.1");
        assert_ne!(v("1.0.0-beta"), v("1.0.0"));
    }

    #[test]
    fn rejects_malformed_versions() {
        for bad in [
            "",
            "v",
            "1",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.02.3",
            "1.2.03",
            "1.2.x",
            "a.b.c",
            "1.2.3-",
            "1.2.3-alpha..1",
            "1.2.3-01",
            "1.2.3+",
            "1.2.3+a..b",
            "1.2.3-αβ",
            "-1.2.3",
            "1.2.3 beta",
        ] {
            assert!(Version::parse(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn orders_versions_by_semver_precedence() {
        // The canonical example chain from SemVer §11.
        let chain = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1",
            "1.1.0",
            "2.0.0",
        ];
        for pair in chain.windows(2) {
            assert!(v(pair[0]) < v(pair[1]), "{} < {}", pair[0], pair[1]);
        }
        assert_eq!(v("1.0.0+a").cmp(&v("1.0.0+b")), Ordering::Equal);
        assert!(v("0.10.0") > v("0.9.9"), "numeric, not lexical");
    }

    fn release(tag: &str) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_owned(),
            html_url: Some(format!(
                "https://github.com/EkexDon/AETHER-OS/releases/tag/{tag}"
            )),
            body: Some("## Changes\n- faster".to_owned()),
            published_at: Some("2026-09-01T10:00:00Z".to_owned()),
        }
    }

    #[test]
    fn evaluates_newer_equal_and_older_releases() {
        let newer = evaluate_release("0.1.0", &release("v0.2.0")).expect("newer");
        assert!(newer.update_available);
        assert_eq!(newer.latest, "0.2.0");
        assert!(newer.url.ends_with("/tag/v0.2.0"));
        assert_eq!(newer.notes, "## Changes\n- faster");

        assert!(
            !evaluate_release("0.2.0", &release("v0.2.0"))
                .expect("same")
                .update_available
        );
        assert!(
            !evaluate_release("0.3.0", &release("v0.2.0"))
                .expect("older")
                .update_available
        );
        assert!(
            evaluate_release("1.0.0-rc.1", &release("v1.0.0"))
                .expect("rc")
                .update_available,
            "a final release supersedes its release candidate"
        );
    }

    #[test]
    fn untrusted_release_urls_fall_back_to_the_releases_page() {
        for bad in [
            "https://evil.example/phish",
            "https://github.com/someone-else/AETHER-OS/releases/tag/v9",
            "https://github.com/EkexDon/AETHER-OS-fake/releases",
            "https://github.com.evil.example/EkexDon/AETHER-OS/releases",
            "https://user@github.com/EkexDon/AETHER-OS/releases",
            "https://github.com:8443/EkexDon/AETHER-OS/releases",
            "http://github.com/EkexDon/AETHER-OS/releases",
            "javascript:alert(1)//github.com/EkexDon/AETHER-OS/",
        ] {
            let mut r = release("v9.0.0");
            r.html_url = Some(bad.to_owned());
            assert_eq!(
                evaluate_release("0.1.0", &r).expect("eval").url,
                RELEASES_PAGE_URL,
                "{bad}"
            );
        }
        assert_eq!(
            trusted_release_url("https://github.com/EkexDon/AETHER-OS/releases/tag/v0.2.0")
                .as_deref(),
            Some("https://github.com/EkexDon/AETHER-OS/releases/tag/v0.2.0")
        );
    }

    #[test]
    fn invalid_release_tags_are_reported() {
        let err = evaluate_release("0.1.0", &release("nightly")).expect_err("bad tag");
        assert!(err.to_string().contains("invalid version"));
    }

    /// Serve exactly one canned HTTP response on a random local port.
    fn serve_once(status_line: &'static str, body: &'static str) -> String {
        serve_once_owned(status_line, body.to_owned())
    }

    fn serve_once_owned(status_line: &'static str, body: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{addr}/releases/latest")
    }

    #[tokio::test]
    async fn fetches_and_evaluates_the_latest_release() {
        let url = serve_once(
            "200 OK",
            r#"{"tag_name":"v0.3.1","html_url":"https://github.com/EkexDon/AETHER-OS/releases/tag/v0.3.1","body":"notes","published_at":"2026-09-20T08:00:00Z"}"#,
        );
        let info = check_for_updates_at(&url, "0.1.0").await.expect("check");
        assert!(info.update_available);
        assert_eq!(info.latest, "0.3.1");
        assert_eq!(info.published_at.as_deref(), Some("2026-09-20T08:00:00Z"));
    }

    #[tokio::test]
    async fn oversized_responses_are_refused() {
        let notes = "x".repeat(MAX_RESPONSE_BYTES + 1);
        let url = serve_once_owned(
            "200 OK",
            format!(r#"{{"tag_name":"v0.3.1","body":"{notes}"}}"#),
        );
        let err = check_for_updates_at(&url, "0.1.0")
            .await
            .expect_err("too large");
        assert!(err.to_string().contains("unexpectedly large"), "{err}");
    }

    #[tokio::test]
    async fn missing_release_means_up_to_date() {
        let url = serve_once("404 Not Found", r#"{"message":"Not Found"}"#);
        let info = check_for_updates_at(&url, "0.1.0").await.expect("check");
        assert!(!info.update_available);
        assert_eq!(info.latest, "0.1.0");
        assert_eq!(info.url, RELEASES_PAGE_URL);
    }

    #[tokio::test]
    async fn rate_limits_and_server_errors_are_readable() {
        let url = serve_once("403 Forbidden", r#"{"message":"API rate limit exceeded"}"#);
        let err = check_for_updates_at(&url, "0.1.0").await.expect_err("403");
        assert!(err.to_string().contains("rate limit"));

        let url = serve_once("500 Internal Server Error", "{}");
        let err = check_for_updates_at(&url, "0.1.0").await.expect_err("500");
        assert!(err.to_string().contains("HTTP 500"));
    }

    #[tokio::test]
    async fn offline_is_a_graceful_network_error() {
        // Bind and immediately drop a listener: the port is then closed.
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        let url = format!("http://127.0.0.1:{port}/releases/latest");
        let err = check_for_updates_at(&url, "0.1.0")
            .await
            .expect_err("offline");
        assert!(matches!(err, AetherError::Network(_)), "{err}");
        assert!(err.to_string().contains("offline"));
    }

    #[tokio::test]
    async fn invalid_current_version_is_rejected_before_any_request() {
        let err = check_for_updates_at("http://127.0.0.1:9/", "not-a-version")
            .await
            .expect_err("invalid current");
        assert!(matches!(err, AetherError::InvalidInput(_)));
    }
}
