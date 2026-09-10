"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { LiteratureApiClient, LiteratureModule } = require("../../docs/literature-module.js");
const contract = { schemaVersion: 2, promptVersion: "card-v2", modelSignature: "a".repeat(64),
  generationStrategy: "text-map-reduce-v1" };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const requests = [], workspace = { workspaceId: "workspace-a" };
  let headers = { Authorization: "Bearer fixture-a" };
  const api = new LiteratureApiClient({ baseUrl: "https://fc.test", getHeaders: () => headers,
    fetch: (url, options) => new Promise(resolve => requests.push({ url, ...options,
      finish(data = contract, status = 200) { resolve(new Response(JSON.stringify({ ok: true, ...data }), { status })); },
    })),
  });
  const read = (context = {}, signal, scope = workspace) => api.getPaperCardConfiguration(signal,
    { turnId: "turn-a", model: "default", ...context }, scope);
  async function fresh(context, signal, scope) {
    const count = requests.length, pending = read(context, signal, scope);
    await tick();
    assert.equal(requests.length, count + 1);
    requests.at(-1).finish(); return pending;
  }
  return { api, workspace, requests, read, fresh, setHeaders(value) { headers = value; } };
}

test("concurrent and sequential configuration consumers share one request only within the initiating turn", async () => {
  const f = fixture();
  const first = f.read(), child = f.read({ turnId: "child-task", configurationTurnId: "turn-a" });
  await tick(); assert.equal(f.requests.length, 1);
  f.requests[0].finish();
  const [a, b] = await Promise.all([first, child]);
  assert.deepEqual(a, b); assert.notEqual(a, b);
  a.modelSignature = "mutated-by-consumer";
  assert.equal((await f.read()).modelSignature, contract.modelSignature);
  assert.equal(f.requests.length, 1);
  const next = f.read({ turnId: "turn-b" }); await tick();
  assert.equal(f.requests.length, 2);
  f.requests[1].finish({ ...contract, modelSignature: "b".repeat(64) });
  assert.equal((await next).modelSignature, "b".repeat(64));
});

test("models, workspace instances, authentication headers, and backend URLs isolate configuration", async () => {
  const f = fixture();
  for (const model of ["default", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", undefined]) {
    await f.fresh({ model });
    assert.equal(f.requests.at(-1).headers["X-BioDesign-Chat-Model"], model);
    await f.read({ model });
  }
  assert.equal(f.requests.length, 3, "Agent Command remains separate from explicit default selection");
  await f.fresh({}, undefined, { workspaceId: f.workspace.workspaceId });
  f.setHeaders({ Authorization: "Bearer fixture-b" });
  await f.fresh();
  assert.equal(f.requests.at(-1).headers.Authorization, "Bearer fixture-b");
  f.setHeaders({ Authorization: "Bearer fixture-a" });
  await f.fresh();
  f.api.baseUrl = "https://other-fc.test";
  await f.fresh();
  assert.equal(f.requests.length, 7);
  assert.equal(f.requests.at(-1).url, "https://other-fc.test/api/literature/config");
});

test("authentication changes during pending setup do not share headers or overwrite the new context", async () => {
  const f = fixture();
  const previous = f.read();
  f.setHeaders({ Authorization: "Bearer fixture-b" });
  const current = f.read(); await tick();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].headers.Authorization, "Bearer fixture-a");
  assert.equal(f.requests[1].headers.Authorization, "Bearer fixture-b");
  f.requests[1].finish({ ...contract, modelSignature: "b".repeat(64) }); await current;
  f.requests[0].finish(); await previous;
  assert.equal((await f.read()).modelSignature, "b".repeat(64));
  assert.equal(f.requests.length, 2);
});

test("failed and invalid configurations are evicted so the same turn can retry", async () => {
  const f = fixture();
  const first = f.read(), second = f.read();
  const failures = [first, second].map(pending => assert.rejects(pending, { code: "CONFIG_UNAVAILABLE" }));
  await tick(); assert.equal(f.requests.length, 1);
  f.requests[0].finish({ ok: false, error: "CONFIG_UNAVAILABLE" }, 503);
  await Promise.all(failures);
  const invalid = f.read(); await tick();
  f.requests.at(-1).finish({ ...contract, modelSignature: "invalid" }); await invalid;
  await f.fresh();
  assert.equal(f.requests.length, 3);
  assert.equal((await f.read()).modelSignature, contract.modelSignature);
});

test("cancelling one configuration consumer leaves other consumers and the successful result usable", async () => {
  const f = fixture();
  const controller = new AbortController();
  const cancelled = f.read({}, controller.signal), survivor = f.read();
  const rejected = assert.rejects(cancelled, { code: "OPERATION_ABORTED" });
  await tick(); controller.abort(); await rejected;
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal.aborted, false);
  f.requests[0].finish(); await survivor;
  await f.read();
  await assert.rejects(f.read({}, controller.signal), { code: "OPERATION_ABORTED" });
  assert.equal(f.requests.length, 1);
});

test("cancelling all configuration consumers aborts and evicts pending work, including late response races", async () => {
  const f = fixture();
  const controllers = [new AbortController(), new AbortController()];
  const rejected = controllers.map(controller => assert.rejects(f.read({}, controller.signal), { code: "OPERATION_ABORTED" }));
  await tick(); controllers.forEach(controller => controller.abort()); await Promise.all(rejected);
  assert.equal(f.requests[0].signal.aborted, true);
  const retry = f.read(); await tick();
  assert.equal(f.requests.length, 2);
  // The mock deliberately returns a response despite abort; it cannot poison retry.
  f.requests[0].finish({ ...contract, modelSignature: "c".repeat(64) }); await tick();
  const joinedRetry = f.read(); await tick();
  assert.equal(f.requests.length, 2);
  f.requests[1].finish(); await Promise.all([retry, joinedRetry]);
  assert.equal((await f.read()).modelSignature, contract.modelSignature);
});

test("calls without a turn or workspace remain fresh; the module adapter retains the workspace scope", async () => {
  const f = fixture();
  await f.fresh({ turnId: undefined }); await f.fresh({ turnId: undefined });
  await f.fresh({}, undefined, null); await f.fresh({}, undefined, null);
  const literature = new LiteratureModule({ workspace: {}, api: f.api });
  const configuration = literature.preparation.getPaperCardConfiguration;
  const context = { turnId: "adapter-turn", model: "default" };
  const first = configuration(undefined, context, f.workspace), second = configuration(undefined, context, f.workspace);
  await tick(); assert.equal(f.requests.length, 5);
  f.requests.at(-1).finish(); await Promise.all([first, second]);
});
