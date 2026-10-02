"use strict";

const ENDPOINT = "https://router.requesty.ai/v1/audio/transcriptions";
const LIMITS = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxDurationMs: 60000, maxTextCharacters: 32000, timeoutMs: 60000 });
const MIME = Object.freeze({ "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav" });
const MODELS = /^(?:openai\/(?:gpt-4o(?:-mini)?-transcribe|whisper-1))(?:-\d{4}-\d{2}-\d{2})?$/;
const result = (statusCode, code) => ({ statusCode, body: { error: code } });

function validateAudio(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["audio", "language"].includes(key))) throw new Error("invalid");
  const audio = body.audio;
  if (!audio || typeof audio !== "object" || Array.isArray(audio) || Object.keys(audio).some(key => !["dataUrl", "durationMs"].includes(key))
    || typeof audio.dataUrl !== "string" || audio.dataUrl.length > Math.ceil(LIMITS.maxBytes / 3) * 4 + 80
    || !Number.isFinite(audio.durationMs) || audio.durationMs < 300 || audio.durationMs > LIMITS.maxDurationMs + 1000
    || body.language !== undefined && (typeof body.language !== "string" || !/^[a-z]{2}$/.test(body.language))) throw new Error("invalid");
  const parsed = /^data:(audio\/(?:webm|ogg|mp4|wav));base64,([A-Za-z0-9+/]+={0,2})$/.exec(audio.dataUrl);
  if (!parsed) throw new Error("invalid");
  const bytes = Buffer.from(parsed[2], "base64");
  if (bytes.length < 16 || bytes.length > LIMITS.maxBytes || bytes.toString("base64") !== parsed[2]) throw new Error("invalid");
  const mimeType = parsed[1];
  const valid = mimeType === "audio/webm" ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : mimeType === "audio/ogg" ? bytes.toString("ascii", 0, 4) === "OggS"
    : mimeType === "audio/wav" ? bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE"
    : bytes.toString("ascii", 4, 8) === "ftyp";
  if (!valid) throw new Error("invalid");
  return { bytes, mimeType, extension: MIME[mimeType], language: body.language };
}

async function readBoundedJson(response) {
  if (Number(response.headers?.get("content-length") || 0) > 128 * 1024) throw new Error("large response");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) { await reader.cancel(); throw new Error("large response"); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

/** The account-scoped key comes from FC authentication. Audio is never written
 * to project/OSS storage and the renderer cannot select a provider or endpoint. */
async function transcribeAudio(body, { env, fetchImpl = fetch, signal } = {}) {
  let audio;
  try { audio = validateAudio(body); } catch { return result(400, "AUDIO_INVALID"); }
  if (String(env?.REQUESTY_TRANSCRIPTION_ENABLED || "").toLowerCase() === "false") return result(503, "AUDIO_DISABLED");
  const model = String(env?.REQUESTY_TRANSCRIPTION_MODEL || "openai/gpt-4o-mini-transcribe").trim();
  if (!MODELS.test(model) || !env?.REQUESTY_API_KEY) return result(503, "AUDIO_MODEL_NOT_CONFIGURED");
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) return result(499, "AUDIO_ABORTED");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, LIMITS.timeoutMs); timer.unref?.();
  try {
    const form = new FormData();
    form.append("file", new Blob([audio.bytes], { type: audio.mimeType }), `recording.${audio.extension}`);
    form.append("model", model);
    if (audio.language) form.append("language", audio.language);
    const response = await fetchImpl(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${env.REQUESTY_API_KEY}` }, body: form, signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return response.status === 429 ? result(429, "AUDIO_RATE_LIMITED")
        : response.status === 401 || response.status === 403 || response.status === 404 ? result(502, "AUDIO_MODEL_UNAVAILABLE") : result(502, "AUDIO_PROVIDER_FAILED");
    }
    const data = await readBoundedJson(response);
    if (signal?.aborted) return result(499, "AUDIO_ABORTED");
    if (controller.signal.aborted) return result(504, "AUDIO_TIMEOUT");
    if (typeof data.text !== "string" || !data.text.trim() || data.text.length > LIMITS.maxTextCharacters) return result(502, "AUDIO_EMPTY_OR_INCOMPLETE");
    return { statusCode: 200, body: { text: data.text.trim(), model } };
  } catch { return result(signal?.aborted ? 499 : controller.signal.aborted ? 504 : 502, signal?.aborted ? "AUDIO_ABORTED" : controller.signal.aborted ? "AUDIO_TIMEOUT" : "AUDIO_PROVIDER_FAILED"); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

module.exports = { transcribeAudio, validateAudio, LIMITS };
