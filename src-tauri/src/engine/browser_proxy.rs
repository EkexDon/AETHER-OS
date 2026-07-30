use std::io::Read;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::str::FromStr;

use tiny_http::{Header, Response, Server};

/// A simple HTTP proxy that strips anti-framing headers (X-Frame-Options, CSP)
/// so pages can be loaded in an iframe within the app.
pub struct BrowserProxy {
    running: Arc<AtomicBool>,
    port: u16,
}

impl BrowserProxy {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn start() -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let running_clone = running.clone();

        // Try ports starting at 9420
        let mut port = 9420u16;
        let listener = loop {
            match TcpListener::bind(format!("127.0.0.1:{}", port)) {
                Ok(l) => break l,
                Err(_) => {
                    port += 1;
                    if port > 9430 {
                        port = 9420;
                        break TcpListener::bind("127.0.0.1:9420").unwrap();
                    }
                }
            }
        };

        let actual_port = port;
        let server = Server::from_listener(listener, None)
            .expect("Failed to create proxy server");

        thread::spawn(move || {
            for request in server.incoming_requests() {
                if !running_clone.load(Ordering::Relaxed) {
                    break;
                }
                handle_request(request);
            }
        });

        BrowserProxy {
            running,
            port: actual_port,
        }
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

impl Drop for BrowserProxy {
    fn drop(&mut self) {
        self.stop();
    }
}

fn handle_request(request: tiny_http::Request) {
    // Parse URL from query string: /proxy?url=<encoded_url>
    let url = request
        .url()
        .split("?url=")
        .nth(1)
        .map(|s| percent_decode(s))
        .unwrap_or_default();

    if url.is_empty() {
        let _ = request.respond(Response::from_string("No URL provided").with_status_code(400));
        return;
    }

    // Fetch the page using ureq (blocking, simple)
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(15))
        .redirects(10)
        .build();

    let resp = match agent
        .get(&url)
        .set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .call()
    {
        Ok(r) => r,
        Err(ureq::Error::Status(_code, response)) => {
            // Non-2xx response — still serve it through the proxy
            response
        }
        Err(e) => {
            let _ = request.respond(
                Response::from_string(format!("Fetch error: {e}")).with_status_code(504),
            );
            return;
        }
    };

    let status_code = resp.status();
    let content_type = resp
        .header("content-type")
        .unwrap_or("text/html")
        .to_string();

    let mut headers: Vec<(String, String)> = Vec::new();

    // Copy safe headers, strip anti-framing ones
    for name in resp.headers_names() {
        let key_lower = name.to_lowercase();
        let val = resp.header(&name).unwrap_or("").to_string();
        match key_lower.as_str() {
            "x-frame-options" | "content-security-policy" | "content-security-policy-report-only"
            | "strict-transport-security" | "cross-origin-opener-policy"
            | "cross-origin-embedder-policy" | "cross-origin-resource-policy" => {
                continue;
            }
            "set-cookie" => {
                let rewritten = val.replace("Domain=", "Domain=127.0.0.1");
                headers.push(("Set-Cookie".to_string(), rewritten));
            }
            "location" => {
                let rewritten = format!("/proxy?url={}", percent_encode(&val));
                headers.push(("Location".to_string(), rewritten));
            }
            _ => {
                headers.push((name, val));
            }
        }
    }

    let mut body = Vec::new();
    if let Err(e) = resp.into_reader().read_to_end(&mut body) {
        let _ = request.respond(
            Response::from_string(format!("Read error: {e}")).with_status_code(500),
        );
        return;
    }

    // If HTML, inject base tag and frame detection bypass
    if content_type.contains("text/html") {
        body = inject_scripts(&body, &url);
    }

    // Build response
    let mut response = Response::from_data(body)
        .with_status_code(status_code)
        .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap());

    for (key, value) in &headers {
        if let Ok(h) = Header::from_bytes(key.as_bytes(), value.as_bytes()) {
            response = response.with_header(h);
        }
    }

    let _ = request.respond(response);
}

/// Inject a <base> tag and frame detection bypass script into HTML
fn inject_scripts(body: &[u8], url: &str) -> Vec<u8> {
    let html = String::from_utf8_lossy(body).to_string();

    let injection = format!(
        r#"<base href="{url}"><script>(function(){{try{{Object.defineProperty(window,'top',{{get:()=>window}});Object.defineProperty(window,'parent',{{get:()=>window}});Object.defineProperty(window,'self',{{get:()=>window}});}}catch(e){{}}}})();</script>"#,
        url = url.replace('"', "&quot;")
    );

    if let Some(pos) = html.find("<head>") {
        let mut result = String::with_capacity(html.len() + injection.len());
        result.push_str(&html[..pos + 6]);
        result.push_str(&injection);
        result.push_str(&html[pos + 6..]);
        result.into_bytes()
    } else if let Some(pos) = html.find("<head ") {
        let end = html[pos..].find('>').map(|e| pos + e + 1).unwrap_or(pos);
        let mut result = String::with_capacity(html.len() + injection.len());
        result.push_str(&html[..end]);
        result.push_str(&injection);
        result.push_str(&html[end..]);
        result.into_bytes()
    } else if let Some(pos) = html.find("<html") {
        let end = html[pos..].find('>').map(|e| pos + e + 1).unwrap_or(pos);
        let mut result = String::with_capacity(html.len() + injection.len());
        result.push_str(&html[..end]);
        result.push_str(&format!("<head>{}</head>", injection));
        result.push_str(&html[end..]);
        result.into_bytes()
    } else {
        format!("{}{}", injection, html).into_bytes()
    }
}

fn percent_decode(s: &str) -> String {
    let mut result = String::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                &std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00"),
                16,
            ) {
                result.push(byte as char);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            result.push(' ');
            i += 1;
            continue;
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}

fn percent_encode(s: &str) -> String {
    let mut result = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percent_decode() {
        assert_eq!(percent_decode("https%3A%2F%2Fexample.com"), "https://example.com");
        assert_eq!(percent_decode("hello+world"), "hello world");
    }

    #[test]
    fn test_percent_encode() {
        assert_eq!(percent_encode("https://example.com"), "https%3A%2F%2Fexample.com");
    }

    #[test]
    fn test_inject_scripts_adds_base_tag() {
        let html = b"<html><head><title>Test</title></head><body>Hello</body></html>";
        let result = inject_scripts(html, "https://example.com");
        let result_str = String::from_utf8_lossy(&result);
        assert!(result_str.contains("<base href=\"https://example.com\">"));
    }
}
