(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BioDesignVoiceComposer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";
  const LIMITS = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxDurationMs: 60000, minDurationMs: 300 });
  const MIME = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  const failure = code => Object.assign(new Error(code), { code });
  const dataUrl = blob => new Promise((resolve, reject) => {
    const reader = new root.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(failure("AUDIO_READ_FAILED"));
    reader.readAsDataURL(blob);
  });

  /** One recording owns one stream, abort controller, and generation. A delayed
   * permission grant or transcription result can never enter another composer. */
  function createRecorder(options) {
    const Recorder = options.Recorder || root.MediaRecorder;
    const media = options.mediaDevices || root.navigator?.mediaDevices;
    const now = options.now || (() => Date.now());
    const schedule = options.setTimeout || root.setTimeout.bind(root), clear = options.clearTimeout || root.clearTimeout.bind(root);
    let state = "idle", generation = 0, stream = null, recorder = null, timer = null, controller = null, destroyed = false;
    const current = token => !destroyed && token === generation && !options.signal?.aborted && options.isCurrent?.() !== false;
    const emit = value => { state = value; options.onState?.(state); };
    const release = () => { clear(timer); timer = null; for (const track of stream?.getTracks() || []) track.stop(); stream = null; };
    function cancel() {
      generation += 1;
      controller?.abort(); controller = null;
      const previous = recorder; recorder = null;
      if (previous && previous.state !== "inactive") { try { previous.stop(); } catch {} }
      release(); emit("idle");
    }
    function report(error) {
      options.onError?.(error?.code ? error : failure(error?.name === "NotAllowedError" ? "AUDIO_PERMISSION_DENIED" : error?.name === "NotFoundError" ? "AUDIO_DEVICE_NOT_FOUND" : "AUDIO_RECORDING_FAILED"));
    }
    async function start() {
      if (state !== "idle" || destroyed || options.signal?.aborted) return;
      // Validate the composer before requesting a device permission. A caller
      // may forbid new recordings while still allowing an active one to stop.
      if (options.canStart?.() === false || options.isCurrent?.() === false) return;
      if (!Recorder || !media?.getUserMedia) { report(failure("AUDIO_UNSUPPORTED")); return; }
      const mimeType = MIME.find(type => Recorder.isTypeSupported?.(type));
      if (!mimeType) { report(failure("AUDIO_UNSUPPORTED")); return; }
      const token = ++generation;
      emit("requesting");
      try {
        const acquired = await media.getUserMedia({ audio: true, video: false });
        if (!current(token)) { for (const track of acquired.getTracks()) track.stop(); if (token === generation) cancel(); return; }
        stream = acquired;
        const chunks = []; let bytes = 0, tooLarge = false;
        const capturedAt = now();
        const active = new Recorder(stream, { mimeType, audioBitsPerSecond: 64000 });
        recorder = active;
        active.ondataavailable = event => {
          if (!current(token) || !event.data?.size) return;
          bytes += event.data.size;
          if (bytes > LIMITS.maxBytes) { tooLarge = true; cancel(); report(failure("AUDIO_TOO_LARGE")); return; }
          chunks.push(event.data);
        };
        active.onerror = () => { if (current(token)) { cancel(); report(failure("AUDIO_RECORDING_FAILED")); } };
        active.onstop = async () => {
          if (!current(token)) return;
          const durationMs = Math.min(LIMITS.maxDurationMs, now() - capturedAt);
          recorder = null; release();
          if (tooLarge) return;
          if (durationMs < LIMITS.minDurationMs || !bytes) { emit("idle"); report(failure("AUDIO_TOO_SHORT")); return; }
          controller = new AbortController();
          const requestController = controller;
          emit("transcribing");
          try {
            const type = (active.mimeType || mimeType).split(";")[0];
            const blob = new Blob(chunks, { type });
            const payload = { audio: { dataUrl: await (options.toDataUrl || dataUrl)(blob), durationMs }, ...(options.language ? { language: options.language } : {}) };
            if (!current(token)) return;
            const result = await options.transcribe(payload, requestController.signal);
            if (!current(token)) return;
            const text = typeof result === "string" ? result : result?.text;
            if (typeof text !== "string" || !text.trim() || text.length > 32000) throw failure("AUDIO_EMPTY_OR_INCOMPLETE");
            options.onTranscript(text.trim());
          } catch (error) { if (current(token) && !requestController.signal.aborted) report(error); }
          finally { if (!destroyed && token === generation) { controller = null; emit("idle"); } }
        };
        active.start(250); emit("recording");
        timer = schedule(stop, LIMITS.maxDurationMs);
      } catch (error) { if (current(token)) { cancel(); report(error); } }
    }
    function stop() {
      if (state === "requesting") { cancel(); return; }
      if (state !== "recording" || !recorder) return;
      if (recorder.state === "inactive") return;
      clear(timer); timer = null;
      try { recorder.stop(); } catch (error) { cancel(); report(error); }
    }
    options.signal?.addEventListener("abort", cancel);
    return { start, stop, cancel, get state() { return state; }, destroy() { cancel(); destroyed = true; options.signal?.removeEventListener("abort", cancel); } };
  }

  function attach(input, options = {}) {
    const button = options.button;
    if (!input || !button || typeof options.transcribe !== "function") throw new TypeError("Voice input needs a composer, button, and transcription callback.");
    const original = { text: button.textContent, title: button.title, label: button.getAttribute("aria-label"), disabled: button.disabled };
    const labels = options.labels || { idle: "Record voice", requesting: "Cancel microphone request", recording: "Stop recording", transcribing: "Transcribing…" };
    const instance = createRecorder({ ...options,
      canStart: () => input.isConnected && !input.disabled && options.canStart?.() !== false,
      isCurrent: () => input.isConnected && options.isCurrent?.() !== false,
      onState(state) {
        button.textContent = labels[state] || labels.idle; button.title = labels[state] || labels.idle;
        button.setAttribute("aria-label", labels[state] || labels.idle); button.setAttribute("aria-pressed", String(state === "recording"));
        button.dataset.voiceState = state; button.disabled = state === "transcribing";
        options.onState?.(state);
      },
      onTranscript(text) {
        if (!input.isConnected || input.disabled || options.isCurrent?.() === false) return;
        const next = `${input.value}${input.value && !/\s$/.test(input.value) ? " " : ""}${text}`;
        if (input.maxLength >= 0 && next.length > input.maxLength) { options.onError?.(failure("AUDIO_COMPOSER_FULL")); return; }
        input.value = next; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus();
      },
    });
    const click = event => { event.preventDefault(); if (instance.state === "idle") void instance.start(); else instance.stop(); };
    const key = event => { if (event.key === "Escape" && instance.state !== "idle") { event.preventDefault(); instance.cancel(); } };
    const cancel = () => instance.cancel();
    button.addEventListener("click", click); input.addEventListener("keydown", key); root.addEventListener?.("pagehide", cancel);
    // Navigation may replace the composer without unloading the Electron page.
    const observer = root.MutationObserver ? new root.MutationObserver(() => { if (!input.isConnected && instance.state !== "idle") instance.cancel(); }) : null;
    observer?.observe(input.ownerDocument.documentElement, { childList: true, subtree: true });
    return { start: instance.start, stop: instance.stop, cancel, get state() { return instance.state; }, destroy() {
      observer?.disconnect(); instance.destroy(); button.removeEventListener("click", click); input.removeEventListener("keydown", key); root.removeEventListener?.("pagehide", cancel);
      button.textContent = original.text; button.title = original.title; button.disabled = original.disabled;
      if (original.label === null) button.removeAttribute("aria-label"); else button.setAttribute("aria-label", original.label);
      button.removeAttribute("aria-pressed"); delete button.dataset.voiceState;
    } };
  }
  return { LIMITS, createRecorder, attach };
});
