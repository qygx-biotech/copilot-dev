// The real preload under a stub Electron module: failures cross contextBridge
// as plain objects, because the bridge drops an Error's code and status, and a
// synchronous throw loses them too.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadPreload(invoke) {
  let api = null;
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { if (name === "biodesignDesktop") api = value; } },
    ipcRenderer: { invoke, on() {}, removeListener() {} } };
  const source = await readFile(new URL("../preload/index.cjs", import.meta.url), "utf8");
  vm.runInNewContext(source, { require: name => { if (name !== "electron") throw new Error(`Unexpected module ${name}`); return electron; }, Object, Error, TypeError, Number, String });
  return api;
}
// The preload runs in its own realm, so compare by constructor name.
const isPlain = value => value?.constructor?.name === "Object";

test("desktop failures cross the bridge as plain objects carrying code and status", async () => {
  const calls = [];
  const api = await loadPreload(async (channel, payload) => {
    calls.push(channel);
    if (channel === "biodesign:project:activate") return { ok: true, value: { projectId: "project-1" } };
    if (channel === "biodesign:agent:start") return { ok: false, error: { code: "AUTH_REQUIRED", message: "Sign in again.", status: 401 } };
    if (channel === "biodesign:execution:run") return { ok: false, error: { code: "NO_OUTPUT_CHANGES", message: "NO_OUTPUT_CHANGES" } };
    throw new Error("No handler registered");
  });

  // Before a project is active, project calls reject (never throw synchronously).
  const early = api.execution.runWorkflow({ workflowId: "x", input: {} });
  assert.equal(typeof early.then, "function", "A rejection, not a synchronous throw");
  const noProject = await early.catch(error => error);
  assert.ok(isPlain(noProject));
  assert.deepEqual({ ...noProject }, { name: "DesktopError", code: "NO_ACTIVE_PROJECT", message: "Select a project folder first." });

  await api.project.activate({ projectId: "project-1" });
  assert.deepEqual({ ...await api.agent.start({ turnId: "t" }).catch(error => error) }, { name: "DesktopError", code: "AUTH_REQUIRED", message: "Sign in again.", status: 401 });
  assert.equal((await api.execution.runWorkflow({ workflowId: "runtime_advanced_undo", input: {} }).catch(error => error)).code, "NO_OUTPUT_CHANGES");
  assert.equal((await api.files.list({ projectId: "older-project" }).catch(error => error)).code, "PROJECT_MISMATCH");
  const transport = await api.jobs.list().catch(error => error);
  assert.deepEqual([transport.code, isPlain(transport)], ["DESKTOP_IPC_FAILED", true]);
});
