import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

test("Apps, skills, MCP presets and model profiles use their real renderer workflows", {
  timeout: 60000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Requires an Electron display" : false,
}, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require("electron"), [fileURLToPath(new URL("./runtime-settings-fixture/main.cjs", import.meta.url))], { env, timeout: 55000, maxBuffer: 1024 * 1024 });
  const result = stdout.split("\n").find(line => line.startsWith("RUNTIME_SETTINGS_RESULT "));
  assert.ok(result, stdout);
  assert.equal(JSON.parse(result.slice("RUNTIME_SETTINGS_RESULT ".length)).passed, 12);
});
