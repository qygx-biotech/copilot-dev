import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

test("Agent Work keeps independent chats, existing execution boundaries, and responsive scroll containment", {
  timeout: 60000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Requires an Electron display (run under xvfb in Linux CI)" : false,
}, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require("electron"), [fileURLToPath(new URL("./agent-work-fixture/main.cjs", import.meta.url))], { env, timeout: 55000, maxBuffer: 1024 * 1024 });
  const line = stdout.split("\n").find(line => line.startsWith("AGENT_WORK_RESULT "));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice("AGENT_WORK_RESULT ".length));
  assert.ok(result.passed.length >= 30, JSON.stringify(result));
  console.log(`Agent Work renderer: ${result.passed.length} behavioral checks passed; screenshots: ${result.screenshots.join(", ")}`);
});
