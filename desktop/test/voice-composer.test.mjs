import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { allowsMicrophone } from "../main/media-permissions.mjs";
const require = createRequire(import.meta.url);
const { createRecorder, LIMITS } = require("../../docs/voice-composer.js");
const wait = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  let time = 0, stopped = 0, recorder, timeout, output = [], errors = [], states = [], calls = [];
  class Recorder {
    static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
    constructor(_stream, { mimeType }) { this.mimeType = mimeType; recorder = this; this.state = "inactive"; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable({ data: new Blob(["audio"], { type: this.mimeType }) }); void this.onstop(); }
  }
  const stream = { getTracks: () => [{ stop() { stopped++; } }] };
  const options = { Recorder, mediaDevices: { getUserMedia: async options => { assert.deepEqual(options, { audio: true, video: false }); return stream; } },
    now: () => time, setTimeout: (fn, duration) => { assert.equal(duration, 60000); timeout = fn; }, clearTimeout: () => {},
    toDataUrl: async blob => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`,
    transcribe: async (payload, signal) => { calls.push({ payload, signal }); return { text: "Draft transcript" }; }, onTranscript: text => output.push(text),
    onError: error => errors.push(error.code), onState: state => states.push(state), ...overrides };
  const instance = createRecorder(options);
  return { instance, options, output, errors, states, calls, stream, get stopped() { return stopped; }, get recorder() { return recorder; }, advance: ms => time += ms, expire: () => timeout() };
}

test("recording is bounded, stops tracks, and returns editable text without submitting", async () => {
  const f = fixture(); await f.instance.start(); f.advance(1000); f.instance.stop(); await wait();
  assert.deepEqual(f.output, ["Draft transcript"]); assert.equal(f.stopped, 1); assert.equal(f.calls[0].payload.audio.durationMs, 1000);
  assert.match(f.calls[0].payload.audio.dataUrl, /^data:audio\/webm;base64,/); assert.deepEqual(f.states, ["requesting", "recording", "transcribing", "idle"]);
  await f.instance.start(); f.advance(LIMITS.maxDurationMs); f.expire(); await wait(); assert.equal(f.calls[1].payload.audio.durationMs, 60000);
});

test("late microphone permission cannot start capture after cancellation", async () => {
  let resolve;
  const f = fixture({ mediaDevices: { getUserMedia: () => new Promise(done => { resolve = done; }) } });
  const pending = f.instance.start(); f.instance.cancel(); resolve(f.stream); await pending;
  assert.equal(f.stopped, 1); assert.equal(f.instance.state, "idle"); assert.equal(f.recorder, undefined); assert.deepEqual(f.output, []);
});

test("startup guards prevent microphone requests without disabling stop", async () => {
  let allowed = false, requests = 0;
  const f = fixture({ canStart: () => allowed });
  const acquire = f.options.mediaDevices.getUserMedia;
  f.options.mediaDevices.getUserMedia = options => { requests++; return acquire(options); };
  await f.instance.start(); assert.equal(requests, 0); assert.equal(f.instance.state, "idle");
  allowed = true; await f.instance.start(); assert.equal(requests, 1);
  allowed = false; f.advance(1000); f.instance.stop(); await wait();
  assert.deepEqual(f.output, ["Draft transcript"]); assert.equal(f.stopped, 1);
  const stale = fixture({ isCurrent: () => false, mediaDevices: { getUserMedia: () => { throw Error("must not request a stale composer's device"); } } });
  await stale.instance.start(); assert.deepEqual(stale.errors, []); assert.equal(stale.instance.state, "idle");
});

test("navigation and cancel abort transcription and discard delayed results", async () => {
  let resolve, requestSignal;
  const signal = new AbortController();
  const f = fixture({ signal: signal.signal, transcribe: (_payload, s) => { requestSignal = s; return new Promise(done => { resolve = done; }); } });
  await f.instance.start(); f.advance(1000); f.instance.stop(); await wait();
  signal.abort(); assert.equal(requestSignal.aborted, true); resolve({ text: "Do not enter next project" }); await wait();
  assert.deepEqual(f.output, []); assert.equal(f.instance.state, "idle"); assert.equal(f.stopped, 1);
});

test("short, oversized, unsupported and failed recordings do not silently send text", async () => {
  const f = fixture(); await f.instance.start(); f.instance.stop(); await wait(); assert.deepEqual(f.errors, ["AUDIO_TOO_SHORT"]); assert.deepEqual(f.calls, []);
  await f.instance.start(); f.recorder.ondataavailable({ data: new Blob([new Uint8Array(LIMITS.maxBytes + 1)]) }); assert.equal(f.errors.at(-1), "AUDIO_TOO_LARGE"); assert.equal(f.instance.state, "idle");
  const denied = fixture({ mediaDevices: { getUserMedia: async () => { throw Object.assign(Error(), { name: "NotAllowedError" }); } } });
  await denied.instance.start(); assert.equal(denied.errors[0], "AUDIO_PERMISSION_DENIED");
  const fail = fixture({ transcribe: async () => { throw Object.assign(Error(), { code: "AUDIO_PROVIDER_FAILED" }); } }); await fail.instance.start(); fail.advance(1000); fail.instance.stop(); await wait(); assert.deepEqual(fail.errors, ["AUDIO_PROVIDER_FAILED"]); assert.deepEqual(fail.output, []);
});

test("only the trusted desktop main frame can request audio-only capture", () => {
  const desktopUrl = "file:///BioDesign/docs/desktop.html", webContents = { getURL: () => desktopUrl }, mainWindow = { isDestroyed: () => false, webContents };
  const base = { webContents, permission: "media", mainWindow, desktopUrl, phase: "request", details: { isMainFrame: true, requestingUrl: desktopUrl, mediaTypes: ["audio"] } };
  assert.equal(allowsMicrophone(base), true);
  for (const change of [{ permission: "display-capture" }, { webContents: { getURL: () => desktopUrl } }, { details: { ...base.details, isMainFrame: false } }, { details: { ...base.details, requestingUrl: "file:///different.html" } }, { details: { ...base.details, mediaTypes: ["audio", "video"] } }]) assert.equal(allowsMicrophone({ ...base, ...change }), false);
  assert.equal(allowsMicrophone({ ...base, phase: "check", details: { isMainFrame: true, requestingUrl: desktopUrl, mediaType: "audio" } }), true);
  assert.equal(allowsMicrophone({ ...base, phase: "check", details: { isMainFrame: true, mediaType: "unknown" } }), false);
});
