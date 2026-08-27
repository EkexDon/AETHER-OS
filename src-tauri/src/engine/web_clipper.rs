use scraper::{Html, Selector};
use serde::Serialize;

use crate::engine::error::AetherError;

/// Result of fetching and extracting a web page for clipping.
#[derive(Debug, Clone, Serialize)]
pub struct ClippedPage {
    pub url: String,
    pub title: String,
    /// Inner HTML of the extracted main content element.
    /// Converted to Markdown on the frontend (turndown).
    pub content_html: String,
    /// Plain-text excerpt for previews and AI summarization prompts.
    pub excerpt: String,
}

/// Fetches web pages and extracts their main content.
pub struct WebClipper {
    client: reqwest::Client,
}

impl WebClipper {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            )
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .unwrap_or_default();
        Self { client }
    }

    /// Fetch a URL and extract its main content.
    pub async fn clip(&self, url: &str) -> Result<ClippedPage, AetherError> {
        let url = normalize_url(url)?;
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| AetherError::Vault(format!("fetch failed: {e}")))?;

        if !response.status().is_success() {
            return Err(AetherError::Vault(format!(
                "fetch failed with status {}",
                response.status()
            )));
        }

        let final_url = response.url().to_string();
        let html = response
            .text()
            .await
            .map_err(|e| AetherError::Vault(format!("read body: {e}")))?;

        Ok(extract_content(&html, &final_url))
    }
}

/// Extract title, main content HTML and a plain-text excerpt from raw HTML.
/// Pure function — fully testable without network.
pub fn extract_content(html: &str, url: &str) -> ClippedPage {
    let document = Html::parse_document(html);

    let title = extract_title(&document);
    let content_html = extract_main_html(&document);
    let excerpt = {
        let fragment = Html::parse_fragment(&content_html);
        let text = fragment.root_element().text().collect::<Vec<_>>().join(" ");
        collapse_whitespace(&text).chars().take(400).collect()
    };

    ClippedPage {
        url: url.to_string(),
        title,
        content_html,
        excerpt,
    }
}

fn extract_title(document: &Html) -> String {
    // Prefer <title>, fall back to og:title, then <h1>
    if let Ok(sel) = Selector::parse("title") {
        if let Some(el) = document.select(&sel).next() {
            let t = el.text().collect::<String>().trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
    }
    if let Ok(sel) = Selector::parse("meta[property='og:title']") {
        if let Some(el) = document.select(&sel).next() {
            if let Some(content) = el.value().attr("content") {
                let t = content.trim().to_string();
                if !t.is_empty() {
                    return t;
                }
            }
        }
    }
    if let Ok(sel) = Selector::parse("h1") {
        if let Some(el) = document.select(&sel).next() {
            let t = el.text().collect::<String>().trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
    }
    "Untitled".to_string()
}

/// Readability-lite: prefer <article> / <main>; otherwise the element with
/// the most paragraph text; final fallback is <body>.
fn extract_main_html(document: &Html) -> String {
    let strip_selectors = ["script", "style", "noscript", "nav", "header", "footer", "iframe", "form"];

    for candidate in ["article", "main", "[role='main']"] {
        if let Ok(sel) = Selector::parse(candidate) {
            if let Some(el) = document.select(&sel).next() {
                let html = clean_html(&el.inner_html(), &strip_selectors);
                if text_len(&html) > 200 {
                    return html;
                }
            }
        }
    }

    // Text-density heuristic: the element containing the most <p> text wins.
    if let Ok(sel) = Selector::parse("div, section, body") {
        let mut best_html = String::new();
        let mut best_len = 0usize;
        if let Ok(p_sel) = Selector::parse("p") {
            for el in document.select(&sel) {
                let len: usize = el
                    .select(&p_sel)
                    .map(|p| p.text().collect::<String>().trim().len())
                    .sum();
                if len > best_len {
                    best_len = len;
                    best_html = el.inner_html();
                }
            }
        }
        if best_len > 0 {
            return clean_html(&best_html, &strip_selectors);
        }
    }

    if let Ok(sel) = Selector::parse("body") {
        if let Some(el) = document.select(&sel).next() {
            return clean_html(&el.inner_html(), &strip_selectors);
        }
    }

    String::new()
}

/// Remove boilerplate elements from an HTML fragment.
fn clean_html(html: &str, strip: &[&str]) -> String {
    let mut fragment = Html::parse_fragment(html);
    for tag in strip {
        if let Ok(sel) = Selector::parse(tag) {
            // Collect first — cannot mutate while selecting.
            let ids: Vec<_> = fragment.select(&sel).map(|e| e.id()).collect();
            for id in ids {
                if let Some(mut node) = fragment.tree.get_mut(id) {
                    node.detach();
                }
            }
        }
    }
    fragment.root_element().inner_html()
}

fn text_len(html: &str) -> usize {
    Html::parse_fragment(html)
        .root_element()
        .text()
        .collect::<String>()
        .trim()
        .len()
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Ensure the URL has a scheme; reject non-http(s) targets.
fn normalize_url(url: &str) -> Result<String, AetherError> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(AetherError::Vault("empty URL".into()));
    }
    // If a scheme is present, only http(s) is allowed.
    if trimmed.contains("://") {
        let parsed = url::Url::parse(trimmed)
            .map_err(|e| AetherError::Vault(format!("invalid URL: {e}")))?;
        return match parsed.scheme() {
            "http" | "https" => Ok(trimmed.to_string()),
            other => Err(AetherError::Vault(format!("unsupported scheme: {other}"))),
        };
    }
    let with_scheme = format!("https://{trimmed}");
    url::Url::parse(&with_scheme)
        .map_err(|e| AetherError::Vault(format!("invalid URL: {e}")))?;
    Ok(with_scheme)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_title_from_title_tag() {
        let html = "<html><head><title>My Article</title></head><body><article><p>Hello world this is a long paragraph of text that should be extracted as content because it has more than two hundred characters in total so it passes the threshold for the article extraction logic we implemented here.</p></article></body></html>";
        let page = extract_content(html, "https://example.com/a");
        assert_eq!(page.title, "My Article");
        assert!(page.content_html.contains("Hello world"));
        assert!(!page.excerpt.is_empty());
    }

    #[test]
    fn prefers_og_title_fallback() {
        let html = "<html><head><meta property='og:title' content='OG Title'></head><body><p>x</p></body></html>";
        let page = extract_content(html, "https://example.com");
        assert_eq!(page.title, "OG Title");
    }

    #[test]
    fn strips_boilerplate_from_content() {
        let long_text = "word ".repeat(80);
        let html = format!(
            "<html><body><article><script>alert(1)</script><nav>menu</nav><p>{long_text}</p><style>.x{{}}</style></article></body></html>"
        );
        let page = extract_content(&html, "https://example.com");
        assert!(!page.content_html.contains("alert(1)"));
        assert!(!page.content_html.contains("menu"));
        assert!(page.content_html.contains("word"));
    }

    #[test]
    fn text_density_fallback_when_no_article() {
        let filler = "lorem ipsum dolor sit amet ".repeat(30);
        let html = format!(
            "<html><body><div class='sidebar'><p>tiny</p></div><div class='content'><p>{filler}</p><p>{filler}</p></div></body></html>"
        );
        let page = extract_content(&html, "https://example.com");
        assert!(page.content_html.contains("lorem ipsum"));
    }

    #[test]
    fn normalize_url_adds_scheme_and_rejects_others() {
        assert_eq!(normalize_url("example.com").unwrap(), "https://example.com");
        assert_eq!(
            normalize_url("https://example.com/x").unwrap(),
            "https://example.com/x"
        );
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("").is_err());
    }

    #[test]
    fn excerpt_is_collapsed_and_capped() {
        let long = "a ".repeat(500);
        let html = format!("<html><body><article><p>{long}</p></article></body></html>");
        let page = extract_content(&html, "https://example.com");
        assert!(page.excerpt.len() <= 410); // 400 chars + slack
        assert!(!page.excerpt.contains("  "));
    }
}
