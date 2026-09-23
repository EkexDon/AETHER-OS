/**
 * Address bar input → the URL the embedded browser may load. Mirrors
 * `validate_webview_url` in Rust: only `http`/`https` pages with a host
 * and `about:blank`; everything else (`file:`, `javascript:`, `data:`,
 * other `about:` pages, app schemes) is refused with a readable reason.
 * Plain words become a DuckDuckGo search, bare hosts get `https://`
 * (`http://` for localhost and IP addresses with a port).
 */

/** Result of {@link resolveBrowserInput}. */
export type BrowserInput = { kind: "empty" } | { kind: "url"; url: string } | { kind: "refused"; reason: string };

const LOCAL = /^(?:localhost|127(?:\.\d{1,3}){3}|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?(?:[/?#]|$)/i;

/** Decide what the address bar should load for `input`. */
export function resolveBrowserInput(input: string): BrowserInput {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };
  if (/^about:blank$/i.test(trimmed)) return { kind: "url", url: "about:blank" };
  if (LOCAL.test(trimmed)) return checkHttp(`http://${trimmed}`);
  // A scheme is letters followed by ":" — but "example.com:8080" is a host with a port.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") return checkHttp(trimmed);
  if (scheme === "about") return { kind: "refused", reason: "Only about:blank can be opened here. Enter an http or https address." };
  if (scheme) return { kind: "refused", reason: `“${scheme}:” addresses cannot be opened in the browser — only http and https pages.` };
  if (/\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(trimmed) && !/\s/.test(trimmed)) return checkHttp(`https://${trimmed}`);
  return { kind: "url", url: `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}` };
}

function checkHttp(raw: string): BrowserInput {
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
      return { kind: "refused", reason: "Enter a web address with a host name, e.g. https://example.com." };
    }
    return { kind: "url", url: url.toString() };
  } catch {
    return { kind: "refused", reason: `“${raw}” is not a valid web address.` };
  }
}
