import { describe, expect, it } from "vitest";
import type { SystemProfile } from "../../types";
import {
  describePullStatus,
  detectOllamaIssue,
  embeddingModelOptions,
  formatBytes,
  isModelInstalled,
  isValidModelName,
  ollamaInstallCommand,
  pullPercent,
  recommendModel,
} from "./models";

const profile = (ram: number): SystemProfile => ({ total_ram_gb: ram, cpu_cores: 8, physical_cores: 8, arch: "aarch64", os: "macos" });
const online = { ollama_online: true, openrouter_configured: false, vault_connected: true };

describe("model helpers", () => {
  it("recommends a model per RAM tier", () => {
    expect(recommendModel(profile(4)).name).toBe("llama3.2:1b");
    expect(recommendModel(profile(8)).name).toBe("llama3.2:3b");
    expect(recommendModel(profile(16)).name).toBe("qwen2.5:7b");
    expect(recommendModel(profile(64)).name).toBe("qwen2.5:14b");
    expect(recommendModel(null).name).toBe("llama3.2:3b");
    expect(recommendModel(profile(16)).reason).toContain("16 GB");
  });

  it("matches installed models with or without :latest", () => {
    expect(isModelInstalled(["nomic-embed-text:latest"], "nomic-embed-text")).toBe(true);
    expect(isModelInstalled(["Llama3.2:3b"], "llama3.2:3b")).toBe(true);
    expect(isModelInstalled(["llama3.2:1b"], "llama3.2:3b")).toBe(false);
    expect(isModelInstalled(null, "x")).toBe(false);
  });

  it("validates model names like the backend", () => {
    expect(isValidModelName("hf.co/org/repo:Q4_K_M")).toBe(true);
    for (const bad of ["", "-x", "a b", "../x", "a//b"]) expect(isValidModelName(bad)).toBe(false);
  });

  it("formats progress", () => {
    expect(pullPercent({ completed: 50, total: 200 })).toBe(25);
    expect(pullPercent({ completed: null, total: null })).toBeNull();
    expect(pullPercent({ completed: 5, total: 0 })).toBeNull();
    expect(formatBytes(1_320_000_000)).toBe("1.3 GB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(describePullStatus({ status: "downloading sha256:abc", completed: 660_000_000, total: 1_320_000_000 })).toBe(
      "Downloading · 50% of 1.3 GB"
    );
    expect(describePullStatus({ status: "pulling manifest", completed: null, total: null })).toBe("Fetching the model manifest…");
    expect(describePullStatus({ status: "success", completed: null, total: null })).toBe("Ready");
    expect(describePullStatus({ status: "something new", completed: null, total: null })).toBe("Something new");
  });

  it("detects Ollama issues only when the facts are known", () => {
    expect(detectOllamaIssue(null, null, "ollama", "gemma2:2b")).toBeNull();
    expect(detectOllamaIssue({ ...online, ollama_online: false }, null, "ollama", "gemma2:2b")).toEqual({ kind: "offline" });
    expect(detectOllamaIssue(online, null, "ollama", "gemma2:2b")).toBeNull();
    expect(detectOllamaIssue(online, ["llama3.2:1b"], "ollama", "gemma2:2b")).toEqual({ kind: "model-missing", model: "gemma2:2b" });
    expect(detectOllamaIssue(online, ["llama3.2:1b"], "openrouter", "gemma2:2b")).toBeNull();
    expect(detectOllamaIssue(online, ["gemma2:2b"], "ollama", "gemma2:2b")).toBeNull();
  });

  it("suggests install commands per platform", () => {
    expect(ollamaInstallCommand("macos").install).toBe("brew install ollama");
    expect(ollamaInstallCommand(null).start).toBe("ollama serve");
    expect(ollamaInstallCommand("linux").install).toContain("install.sh");
    expect(ollamaInstallCommand("windows").install).toContain("winget");
  });

  it("suggests installed embedding models first, then other models, then known ones", () => {
    const options = embeddingModelOptions(["qwen2.5:7b", "mxbai-embed-large:latest", "all-minilm", "nomic-embed-text:latest"]);
    expect(options.map((o) => o.name)).toEqual([
      "all-minilm",
      "mxbai-embed-large:latest",
      "nomic-embed-text:latest",
      "qwen2.5:7b",
      "bge-m3",
      "snowflake-arctic-embed",
    ]);
    expect(options.filter((o) => o.installed)).toHaveLength(4);
    expect(embeddingModelOptions(null).map((o) => o.name)[0]).toBe("nomic-embed-text");
    expect(embeddingModelOptions(null).every((o) => !o.installed)).toBe(true);
  });
});
