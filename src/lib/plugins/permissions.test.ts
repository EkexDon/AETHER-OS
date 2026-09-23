import { describe, expect, it } from "vitest";
import {
  STATIC_PERMISSIONS,
  PluginPermissionError,
  checkFetchUrl,
  describePermission,
  fetchHost,
  hasAnyFetchPermission,
  permissionProblem,
  requirePermission,
} from "./permissions";
import { NET_FETCH_ANY, PLUGIN_EVENTS, PLUGIN_METHODS, isPluginMethod } from "./api";
import { joinVaultPath, noteName, sanitizeVaultPath, toVaultRelative } from "./paths";

describe("permission vocabulary", () => {
  it("describes every static permission and net:fetch hosts", () => {
    for (const permission of STATIC_PERMISSIONS) {
      const info = describePermission(permission);
      expect(info.label).not.toBe(permission);
      expect(info.description.length).toBeGreaterThan(10);
    }
    expect(describePermission("net:fetch:api.github.com").label).toBe("Connect to api.github.com");
    expect(describePermission("system:shell").risk).toBe("high");
    expect(fetchHost("net:fetch:example.org")).toBe("example.org");
    expect(fetchHost("vault:read")).toBeNull();
  });

  it("validates permission strings like the Rust engine", () => {
    expect(permissionProblem("vault:read")).toBeNull();
    expect(permissionProblem("net:fetch:api.github.com")).toBeNull();
    for (const bad of [
      "vault:delete",
      "net:fetch:",
      "net:fetch:localhost",
      "net:fetch:10.0.0.1",
      "net:fetch:nas.local",
      "net:fetch:Example.com",
      "net:fetch:example.com/path",
    ]) {
      expect(permissionProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("host-side permission checks", () => {
  it("requirePermission throws a descriptive error for ungranted permissions", () => {
    expect(() => requirePermission("com.x", ["vault:read"], "vault:read")).not.toThrow();
    expect(() => requirePermission("com.x", ["vault:read"], "vault:write")).toThrow(PluginPermissionError);
    expect(() => requirePermission("com.x", [], "vault:write")).toThrow(
      'permission denied: plugin "com.x" has not been granted "vault:write"'
    );
  });

  it("every API method declares its permission and validates its arguments", () => {
    expect(PLUGIN_METHODS["vault.read"].permission).toBe("vault:read");
    expect(PLUGIN_METHODS["vault.write"].permission).toBe("vault:write");
    expect(PLUGIN_METHODS["notes.create"].permission).toBe("notes:create");
    expect(PLUGIN_METHODS["ai.query"].permission).toBe("ai:query");
    expect(PLUGIN_METHODS["clipboard.readText"].permission).toBe("clipboard:read");
    expect(PLUGIN_METHODS["net.fetch"].permission).toBe(NET_FETCH_ANY);
    expect(PLUGIN_METHODS["ui.toast"].permission).toBeNull();
    expect(isPluginMethod("vault.read")).toBe(true);
    expect(isPluginMethod("__proto__")).toBe(false);
    expect(isPluginMethod("toString")).toBe(false);

    expect(() => PLUGIN_METHODS["vault.read"].validate([42])).toThrow("path must be a string");
    expect(() => PLUGIN_METHODS["vault.read"].validate(["a.md", "extra"])).toThrow("at most 1 argument");
    expect(() => PLUGIN_METHODS["ui.toast"].validate(["hi", "warning"])).toThrow("toast kind");
    expect(() => PLUGIN_METHODS["ui.statusbar.set"].validate(["x".repeat(61)])).toThrow("longer than 60");
    expect(() => PLUGIN_METHODS["commands.register"].validate([{ id: "a b", title: "T" }])).toThrow("command id");
    expect(PLUGIN_METHODS["commands.register"].validate([{ id: "run", title: "Run" }])).toEqual([
      { id: "run", title: "Run", shortcut: null },
    ]);
    expect(PLUGIN_METHODS["ai.query"].validate(["hi"])).toEqual(["hi", []]);
    expect(PLUGIN_METHODS["ai.query"].timeoutMs).toBeGreaterThan(60_000);
  });

  it("gates events on permissions", () => {
    expect(PLUGIN_EVENTS["note:opened"]).toBe("vault:read");
    expect(PLUGIN_EVENTS["panel:action"]).toBe("ui:panel");
    expect(PLUGIN_EVENTS["settings:changed"]).toBeNull();
  });

  it("checkFetchUrl allows only https URLs on granted hosts", () => {
    const granted = ["ui:panel", "net:fetch:api.github.com"];
    expect(hasAnyFetchPermission(granted)).toBe(true);
    expect(hasAnyFetchPermission(["ui:panel"])).toBe(false);
    expect(checkFetchUrl(granted, "https://api.github.com/zen").hostname).toBe("api.github.com");
    expect(() => checkFetchUrl(granted, "http://api.github.com/zen")).toThrow("https://");
    expect(() => checkFetchUrl(granted, "https://github.com/")).toThrow("has not been granted");
    expect(() => checkFetchUrl(granted, "https://x.api.github.com/")).toThrow("has not been granted");
    expect(() => checkFetchUrl(granted, "https://api.github.com@evil.com/")).toThrow("credentials");
    expect(() => checkFetchUrl(granted, "https://api.github.com:444/")).toThrow("custom port");
    expect(() => checkFetchUrl(granted, "nope")).toThrow("invalid URL");
  });
});

describe("vault paths", () => {
  it("sanitizes plugin paths like the Rust engine", () => {
    expect(sanitizeVaultPath("daily//2026-09-22.md")).toBe("daily/2026-09-22.md");
    for (const bad of ["../x.md", "/abs.md", "a/../b.md", ".nopes/i.md", "C:/x.md", "a\\b.md", "note.txt", "", "./a.md"]) {
      expect(() => sanitizeVaultPath(bad), bad).toThrow("invalid vault path");
    }
  });

  it("converts between absolute and vault-relative paths", () => {
    expect(toVaultRelative("/v/daily/a.md", "/v")).toBe("daily/a.md");
    expect(toVaultRelative("/v/daily/a.md", "/v/")).toBe("daily/a.md");
    expect(toVaultRelative("/vault2/a.md", "/v")).toBeNull();
    expect(toVaultRelative("/v/a.md", null)).toBeNull();
    expect(joinVaultPath("/v/", "daily/a.md")).toBe("/v/daily/a.md");
    expect(joinVaultPath("C:\\Vault", "daily/a.md")).toBe("C:\\Vault\\daily\\a.md");
    expect(noteName("daily/2026-09-22.md")).toBe("2026-09-22");
  });
});
