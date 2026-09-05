import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

test("Side Chat editor and citation navigation behave correctly in the sandboxed Electron renderer", {
  timeout: 60000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Requires an Electron display (run under xvfb in Linux CI)" : false,
}, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require("electron"), [fileURLToPath(new URL("./side-chat-fixture/main.cjs", import.meta.url))], { env, timeout: 55000, maxBuffer: 1024 * 1024 });
  const line = stdout.split("\n").find(line => line.startsWith("SIDE_CHAT_RESULT "));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice("SIDE_CHAT_RESULT ".length));
  assert.equal(result.failed.length, 0, JSON.stringify(result, null, 2));
  assert.ok(result.passed.length >= 12, JSON.stringify(result));
  console.log(`Electron renderer: ${result.passed.length} behavioral checks passed; screenshot: ${result.screenshot}`);
});
