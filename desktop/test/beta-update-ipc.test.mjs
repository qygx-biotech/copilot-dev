import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import channels from "../ipc/channels.cjs";
import { registerIpcHandlers } from "../ipc/register-handlers.mjs";

function ipcFixture() {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  const webContents = {
    getURL: () => "file:///packaged/docs/index.html",
    send: () => {},
  };
  const window = {
    isDestroyed: () => false,
    webContents,
  };
  const sessionManager = new EventEmitter();
  let requests = 0;
  const controller = {
    async requestBetaUpdateCheck() {
      requests += 1;
      return { state: "checking" };
    },
  };
  const unregister = registerIpcHandlers({
    ipcMain,
    dialog: {},
    sessionManager,
    runtimeInfo: () => ({}),
    getWindow: () => window,
    getUpdaterController: () => controller,
  });
  return { controller, handlers, requests: () => requests, unregister, webContents };
}

test("the beta update IPC accepts only the current file renderer and no input", async () => {
  const state = ipcFixture();
  const handler = state.handlers.get(channels.betaUpdateCheck);
  const trustedEvent = {
    sender: state.webContents,
    senderFrame: { url: state.webContents.getURL() },
  };
  assert.deepEqual(await handler(trustedEvent, {}), { ok: true, value: { state: "checking" } });
  assert.equal(state.requests(), 1);

  const unexpectedInput = await handler(trustedEvent, { feedUrl: "https://example.com" });
  assert.equal(unexpectedInput.ok, false);
  assert.equal(state.requests(), 1);

  const untrusted = await handler({
    sender: { getURL: () => "https://example.com" },
    senderFrame: { url: "https://example.com" },
  }, {});
  assert.equal(untrusted.ok, false);
  assert.equal(untrusted.error.code, "UNTRUSTED_IPC_SENDER");
  assert.equal(state.requests(), 1);
  state.unregister();
});
