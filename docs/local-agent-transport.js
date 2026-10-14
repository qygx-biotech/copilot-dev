(function exposeLocalAgentTransport(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignLocalAgentTransport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // One turn of the desktop agent loop, seen by the renderer as a sequence of
  // exchanges. Each exchange ends with the data of a step boundary (host tools
  // or a runtime checkpoint, which the renderer answers to continue) or with
  // the final result. The loop's state stays in the loop process.
  const failure = (code, message) => Object.assign(new Error(message), { code });

  // The event types the renderer's stream handler receives.
  const STREAM_EVENTS = new Set(["delta", "reset", "status", "sources", "transcript"]);

  function startSession({ agent, turnId, token, body, signal }) {
    // A stop is a cancellation, and an event handler's failure interrupts the
    // stream unless it is already a stream failure.
    const cancelled = error => signal?.aborted || error?.code === "OPERATION_ABORTED";
    const asStopped = error => cancelled(error) ? failure("OPERATION_ABORTED", "The request was cancelled.") : error;
    const asStreamFailure = error => cancelled(error) ? asStopped(error)
      : String(error?.code || "").startsWith("STREAM_") ? error : failure("STREAM_INTERRUPTED", "The response was interrupted. Please retry.");
    let handler = () => {};
    let pending = null;
    let boundaryId = null;
    let settled = false;
    // Events are handled in order, and fully, before an exchange resolves.
    let chain = Promise.resolve(), eventError = null;
    const settle = (method, value) => {
      chain = chain.then(() => {
        const waiting = pending; pending = null;
        if (eventError && method === "resolve") waiting?.reject(asStreamFailure(eventError));
        else if (method === "reject") waiting?.reject(eventError ? asStreamFailure(eventError) : asStopped(value));
        else waiting?.resolve(value);
      });
    };
    const unsubscribe = agent.onEvent(payload => {
      if (payload?.turnId !== turnId) return;
      const event = payload.event || {};
      if (event.type === "boundary") { boundaryId = event.boundaryId; settle("resolve", event.data); return; }
      if (!STREAM_EVENTS.has(event.type)) return;
      const current = handler;
      chain = chain.then(() => current(event)).catch(error => { eventError ||= error; });
    });
    // A failed turn ends with its failure result (the reply explains what is
    // incomplete and what was preserved); an evidence-recovery result follows
    // a reset.
    const finished = agent.start({ turnId, token, body }).then(
      value => {
        settled = true;
        if (value?.evidenceRecovery) {
          const current = handler;
          chain = chain.then(() => current({ type: "reset" })).catch(error => { eventError ||= error; });
        }
        settle("resolve", value); return value;
      },
      error => { settled = true; settle("reject", error); throw error; });
    finished.catch(() => {});
    const cancel = () => { void Promise.resolve(agent.cancel({ turnId })).catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    const wait = onEvent => {
      handler = onEvent || (() => {});
      if (settled) return finished.catch(error => { throw eventError ? asStreamFailure(eventError) : asStopped(error); });
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    };
    return {
      turnId,
      // Runs until the first boundary or the end of the turn.
      first: onEvent => wait(onEvent),
      // Whether the last exchange ended at a step boundary that can continue.
      atBoundary: () => boundaryId !== null,
      // Answers the pending boundary with the host's receipts, runtime input
      // and current workspace context, then runs until the next boundary or
      // the end.
      async next(reply, onEvent) {
        if (!boundaryId) throw failure("INVALID_TOOL_CONTINUATION", "No step boundary is pending.");
        const id = boundaryId;
        boundaryId = null;
        const waiting = wait(onEvent);
        try { await agent.respond({ turnId, boundaryId: id, reply }); }
        catch (error) {
          // The reply never reached the loop; this exchange will not resolve.
          pending = null;
          waiting.catch(() => {});
          throw error;
        }
        return waiting;
      },
      // Ends the turn when the renderer stops at a boundary (or cancels it).
      async close({ cancelTurn = false } = {}) {
        signal?.removeEventListener("abort", cancel);
        try {
          if (cancelTurn && !settled) cancel();
          else if (boundaryId) {
            const id = boundaryId;
            boundaryId = null;
            await agent.respond({ turnId, boundaryId: id, reply: null });
          }
          await finished;
        } catch { /* The exchange that observed the failure already reported it. */ }
        finally { unsubscribe(); }
      },
    };
  }

  return Object.freeze({ startSession });
});
