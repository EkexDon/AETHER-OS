/**
 * Manifest validation mirroring `parse_manifest` in
 * `src-tauri/src/engine/plugins.rs`. The Rust backend is authoritative; this
 * copy lets the browser preview (mock backend) behave the same way and lets
 * the UI explain problems without a round trip.
 */
import type { PluginManifest, PluginSettingSpec, PluginSettingValue } from "../../types";
import { permissionProblem } from "./permissions";

const MANIFEST_FIELDS = new Set([
  "id",
  "name",
  "version",
  "description",
  "author",
  "main",
  "minAppVersion",
  "permissions",
  "settings",
]);
const SETTING_FIELDS = new Set(["key", "type", "label", "description", "default", "options", "min", "max"]);
const SETTING_TYPES = new Set(["string", "number", "boolean", "select"]);
const RESERVED_IDS = new Set(["state.json"]);

/** A parsed SemVer version (build metadata dropped). */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
}

const IDENT = /^[0-9A-Za-z-]+$/;
const NUM = /^(0|[1-9][0-9]*)$/;

/** Parse a strict SemVer 2.0 string (no `v` prefix); `null` when invalid. */
export function parseSemver(value: string): SemVer | null {
  if (typeof value !== "string" || value.trim() !== value || !value) return null;
  const [withoutBuild, build, ...rest] = value.split("+");
  if (rest.length > 0 || (build !== undefined && build.split(".").some((p) => !IDENT.test(p)))) return null;
  const dash = withoutBuild.indexOf("-");
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const preRaw = dash === -1 ? null : withoutBuild.slice(dash + 1);
  const parts = core.split(".");
  if (parts.length !== 3 || parts.some((p) => !NUM.test(p))) return null;
  const pre: (string | number)[] = [];
  if (preRaw !== null) {
    for (const id of preRaw.split(".")) {
      if (!IDENT.test(id)) return null;
      if (/^[0-9]+$/.test(id)) {
        if (!NUM.test(id)) return null;
        pre.push(Number(id));
      } else {
        pre.push(id);
      }
    }
  }
  return { major: Number(parts[0]), minor: Number(parts[1]), patch: Number(parts[2]), pre };
}

/** SemVer precedence: negative when `a < b`, 0 when equal, positive when `a > b`. */
export function compareSemver(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.pre.length === 0 || b.pre.length === 0) return (a.pre.length === 0 ? 1 : 0) - (b.pre.length === 0 ? 1 : 0);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

/** Why a plugin id is invalid, or `null` (same rules as Rust). */
export function pluginIdProblem(id: string): string | null {
  if (id.length < 3 || id.length > 64) return "must be 3–64 characters long";
  if (!/^[a-z0-9._-]+$/.test(id)) return "use lowercase letters, digits, '.', '-' or '_'";
  if (/^[._-]|[._-]$/.test(id)) return "must start and end with a letter or digit";
  if (/[._-]{2}/.test(id)) return "separators must not follow each other";
  if (RESERVED_IDS.has(id)) return "reserved name";
  return null;
}

function fail(why: string): never {
  throw new Error(`invalid plugin manifest: ${why}`);
}

function text(field: string, value: unknown, min: number, max: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") fail(`${field} must be a string`);
  const length = [...value.trim()].length;
  if (length < min || [...value].length > max) fail(`${field} must be ${min}–${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${field} must not contain control characters`);
  return value;
}

function mainProblem(main: string): string | null {
  if (!main || main.length > 128) return "main must be 1–128 characters";
  if (/[\\:\0]/.test(main) || main.startsWith("/")) return "main must be a relative path inside the plugin folder";
  if (main.split("/").some((s) => !s || s === "." || s === ".." || s.startsWith("."))) {
    return "main must not contain empty, '.', '..' or hidden segments";
  }
  if (!/\.m?js$/.test(main)) return "main must be a .js or .mjs file";
  return null;
}

/** Why `value` is not acceptable for `spec`, or `null` when it is. */
export function settingValueProblem(spec: PluginSettingSpec, value: unknown): string | null {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return "must be a string";
      return [...value].length > 10_000 ? "must be at most 10000 characters" : null;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a finite number";
      const min = spec.min ?? null;
      const max = spec.max ?? null;
      if ((min !== null && value < min) || (max !== null && value > max)) {
        return `must be between ${min ?? "-∞"} and ${max ?? "∞"}`;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "select":
      return typeof value === "string" && (spec.options ?? []).some((o) => o.value === value)
        ? null
        : "must be one of the listed options";
  }
}

/** The value a setting has before the user changes it. */
export function defaultSettingValue(spec: PluginSettingSpec): PluginSettingValue {
  if (spec.default !== undefined && spec.default !== null) return spec.default;
  switch (spec.type) {
    case "string":
      return "";
    case "number":
      return spec.min ?? 0;
    case "boolean":
      return false;
    case "select":
      return spec.options?.[0]?.value ?? "";
  }
}

function validateSetting(raw: unknown): PluginSettingSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("each setting must be an object");
  const obj = raw as Record<string, unknown>;
  for (const field of Object.keys(obj)) if (!SETTING_FIELDS.has(field)) fail(`unknown field \`${field}\` in setting`);
  const key = obj.key;
  if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
    fail(`setting key "${String(key)}" must start with a letter and use only letters, digits or '_' (max 64)`);
  }
  if (typeof obj.type !== "string" || !SETTING_TYPES.has(obj.type)) fail(`settings.${key}: unknown type`);
  const spec: PluginSettingSpec = {
    key,
    type: obj.type as PluginSettingSpec["type"],
    label: text(`settings.${key}.label`, obj.label, 1, 80),
    description: obj.description == null ? null : text(`settings.${key}.description`, obj.description, 0, 300),
    default: (obj.default ?? null) as PluginSettingValue | null,
    options: [],
    min: obj.min == null ? null : (obj.min as number),
    max: obj.max == null ? null : (obj.max as number),
  };
  const hasBounds = spec.min !== null || spec.max !== null;
  if (spec.type === "number") {
    if ((spec.min !== null && !Number.isFinite(spec.min)) || (spec.max !== null && !Number.isFinite(spec.max))) {
      fail(`settings.${key}: min/max must be finite`);
    }
    if (spec.min !== null && spec.max !== null && spec.min! > spec.max!) fail(`settings.${key}: min is larger than max`);
  } else if (hasBounds) {
    fail(`settings.${key}: min/max are only allowed for number settings`);
  }
  const options = obj.options ?? [];
  if (!Array.isArray(options)) fail(`settings.${key}: options must be an array`);
  if (spec.type === "select") {
    if (options.length === 0 || options.length > 50) fail(`settings.${key}: a select needs 1–50 options`);
    const seen = new Set<string>();
    for (const option of options as Record<string, unknown>[]) {
      const value = text(`settings.${key}.options.value`, option?.value, 1, 100);
      const label = text(`settings.${key}.options.label`, option?.label, 1, 80);
      if (seen.has(value)) fail(`settings.${key}: duplicate option "${value}"`);
      seen.add(value);
      spec.options!.push({ value, label });
    }
  } else if (options.length > 0) {
    fail(`settings.${key}: options are only allowed for select settings`);
  }
  if (spec.default !== null) {
    const problem = settingValueProblem(spec, spec.default);
    if (problem) fail(`settings.${key}.default ${problem}`);
  }
  return spec;
}

/**
 * Parse and validate a manifest (JSON text or an already parsed object).
 * `appVersion` is the running app version checked against `minAppVersion`.
 * Throws `Error("invalid plugin manifest: …")`.
 */
export function validateManifest(input: unknown, appVersion: string): PluginManifest {
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("expected a JSON object");
  const obj = raw as Record<string, unknown>;
  for (const field of Object.keys(obj)) if (!MANIFEST_FIELDS.has(field)) fail(`unknown field \`${field}\``);

  if (typeof obj.id !== "string") fail("id must be a string");
  const idProblem = pluginIdProblem(obj.id);
  if (idProblem) fail(`invalid plugin id "${obj.id}": ${idProblem}`);
  const name = text("name", obj.name, 1, 64);
  if (typeof obj.version !== "string" || !parseSemver(obj.version)) {
    fail(`version "${String(obj.version)}" must be a plain SemVer version like 1.0.0`);
  }
  const description = text("description", obj.description, 0, 500, "");
  const author = text("author", obj.author, 0, 100, "");
  const main = obj.main === undefined ? "main.js" : text("main", obj.main, 1, 128);
  const problem = mainProblem(main);
  if (problem) fail(problem);

  let minAppVersion: string | null = null;
  if (obj.minAppVersion !== undefined && obj.minAppVersion !== null) {
    const required = typeof obj.minAppVersion === "string" ? parseSemver(obj.minAppVersion) : null;
    if (!required) fail(`minAppVersion "${String(obj.minAppVersion)}" must be a plain SemVer version like 1.0.0`);
    const running = parseSemver(appVersion);
    if (running && compareSemver(required, running) > 0) {
      fail(`requires AETHER-OS ${obj.minAppVersion} or newer (this is ${appVersion})`);
    }
    minAppVersion = obj.minAppVersion as string;
  }

  const permissions = obj.permissions ?? [];
  if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string")) {
    fail("permissions must be an array of strings");
  }
  if (permissions.length > 32) fail("at most 32 permissions are allowed");
  const seen = new Set<string>();
  for (const permission of permissions as string[]) {
    const why = permissionProblem(permission);
    if (why) fail(why);
    if (seen.has(permission)) fail(`duplicate permission "${permission}"`);
    seen.add(permission);
  }

  const rawSettings = obj.settings ?? [];
  if (!Array.isArray(rawSettings)) fail("settings must be an array");
  if (rawSettings.length > 32) fail("at most 32 settings are allowed");
  const settings = rawSettings.map(validateSetting);
  const keys = new Set<string>();
  for (const spec of settings) {
    if (keys.has(spec.key)) fail(`duplicate setting key "${spec.key}"`);
    keys.add(spec.key);
  }

  return {
    id: obj.id,
    name,
    version: obj.version,
    description,
    author,
    main,
    minAppVersion,
    permissions: permissions as string[],
    settings,
  };
}
