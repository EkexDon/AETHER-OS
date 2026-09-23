import { describe, expect, it } from "vitest";
import { resolveBrowserInput } from "./browserUrl";

const url = (input: string) => {
  const r = resolveBrowserInput(input);
  return r.kind === "url" ? r.url : r.kind;
};

describe("resolveBrowserInput", () => {
  it("loads http(s) pages, bare hosts and local servers", () => {
    expect(url("https://tauri.app/docs")).toBe("https://tauri.app/docs");
    expect(url("tauri.app")).toBe("https://tauri.app/");
    expect(url("example.com:8080/x")).toBe("https://example.com:8080/x");
    expect(url("localhost:1420")).toBe("http://localhost:1420/");
    expect(url("127.0.0.1:8080/api")).toBe("http://127.0.0.1:8080/api");
    expect(url("about:blank")).toBe("about:blank");
  });

  it("searches plain words", () => {
    expect(url("rust ownership")).toBe("https://duckduckgo.com/?q=rust%20ownership");
  });

  it("refuses other schemes and about: pages like Rust does", () => {
    for (const input of ["about:config", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "tauri://localhost", "chrome://settings"]) {
      expect(resolveBrowserInput(input).kind, input).toBe("refused");
    }
    expect(resolveBrowserInput("about:config")).toMatchObject({ reason: expect.stringContaining("about:blank") });
    expect(resolveBrowserInput("   ").kind).toBe("empty");
    expect(resolveBrowserInput("https://").kind).toBe("refused");
  });
});
