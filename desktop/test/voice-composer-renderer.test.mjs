import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
test("voice controls insert editable text, do not send, and cancel detached composers", {
  timeout: 60000, skip: process.platform === "linux" && !process.env.DISPLAY ? "Requires an Electron display" : false,
}, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require("electron"), [fileURLToPath(new URL("./voice-composer-fixture/main.cjs", import.meta.url))], { env, timeout: 55000, maxBuffer: 1024 * 1024 });
  const line = stdout.split("\n").find(line => line.startsWith("VOICE_COMPOSER_RESULT "));
  assert.ok(line, stdout); assert.equal(JSON.parse(line.slice("VOICE_COMPOSER_RESULT ".length)).passed, 11);
});
