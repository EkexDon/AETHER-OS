import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Node ≥ 25 enables the built-in Web Storage API by default and warns
// ("`--localstorage-file` was provided without a valid path") as soon as
// jsdom's environment setup touches `globalThis.localStorage`. The tests use
// jsdom's own storage, so turn Node's off in the workers — but only on Node
// versions that know the flag, older ones would refuse to start.
const nodeStorageFlags = process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage")
  ? ["--no-experimental-webstorage"]
  : [];

export default defineConfig({
  plugins: [react() as any],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: { execArgv: nodeStorageFlags },
      threads: { execArgv: nodeStorageFlags },
    },
  },
});
