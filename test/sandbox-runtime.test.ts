import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  buildRuntimeConfig,
  extractBlockedWritePath,
  supportsNodeEnvProxy,
} from "../src/sandbox-runtime.ts";

test("buildRuntimeConfig adds session allowances without mutating config", () => {
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, {
    domains: ["example.com"],
    readPaths: ["/read"],
    writePaths: ["/write"],
  });
  assert.equal(runtime.network?.allowedDomains?.includes("example.com"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/read"), true);
  assert.equal(runtime.filesystem?.allowWrite?.includes("/write"), true);
  assert.equal(DEFAULT_CONFIG.network?.allowedDomains?.includes("example.com"), false);
});

test("extractBlockedWritePath recognizes shell sandbox errors", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});

// Regression for pi-sandbox-d5m: the extension runs under its own vendored
// @oh-my-pi/pi-coding-agent copy whose global Settings singleton is never
// initialized, so the bash path's settings.getShellConfig() threw "Settings
// not initialized" for every command. runSandboxedUserBash must lazily
// Settings.init() before reading shell config. Run in a fresh subprocess so
// the singleton is genuinely uninitialized (the in-process test runner and
// Settings.init()'s global memoization make this unreproducible in-process),
// and use a nonexistent cwd so the call fails at the existsSync guard AFTER
// shell config resolves — never reaching the platform sandbox wrapper.
test("runSandboxedUserBash initializes Settings before reading shell config", () => {
  const runtimePath = fileURLToPath(new URL("../src/sandbox-runtime.ts", import.meta.url));
  const script =
    `import { runSandboxedUserBash } from ${JSON.stringify(runtimePath)};\n` +
    `try {\n` +
    `  await runSandboxedUserBash("echo hi", "/pi-sandbox-nonexistent-cwd");\n` +
    `  console.log("NO_THROW");\n` +
    `} catch (error) {\n` +
    `  console.log(error.message);\n` +
    `}\n`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  const message = result.stdout.trim();
  assert.doesNotMatch(message, /Settings not initialized/);
  assert.equal(message, "Working directory does not exist: /pi-sandbox-nonexistent-cwd");
});
