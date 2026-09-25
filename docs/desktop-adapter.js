// Frontend contract only: no provider transport, orchestration, or persistence.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BioDesignFrontend = api.createFrontendAdapter();
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";
  const roles = new Set(["side_chat", "agent_command"]);
  const navigation = new Set(['project.choose', 'project.activate', 'project.confirm', 'project.cancel', 'project.retry', 'chat.new', 'chat.open']);
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const clone = value => JSON.parse(JSON.stringify(value));

  function createFrontendAdapter() {
    let service = null, scheduled = false, epoch = 0;
    let snapshot = Object.freeze({ ready: false, project: null, conversations: [], agents: [], runs: {} });
    const listeners = new Set(), pending = new Map(), runs = new Map();
    const notify = () => { for (const listener of listeners) listener(); };
    function refresh() {
      scheduled = false;
      if (!service) return;
      const next = service.readSnapshot();
      snapshot = Object.freeze({ ...clone(next), ready: true,
        runs: Object.fromEntries([...runs].map(([key, run]) => [key, clone(run.state)])) });
      notify();
    }
    function invalidate() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(refresh);
    }
    function invalidateProject() {
      epoch++;
      for (const run of runs.values()) run.controller.abort();
      runs.clear();
      pending.clear();
      invalidate();
    }
    function assertProject(projectId) {
      const current = service?.readSnapshot().project?.id;
      if (!current || current !== projectId) throw fail("PROJECT_MISMATCH", "The project changed. Select the current conversation again.");
    }
    async function command(name, payload = {}) {
      if (!service?.commands[name]) throw fail("UNSUPPORTED_ACTION", "This action is not connected.");
      if (!navigation.has(name) || payload.projectId) assertProject(payload.projectId);
      if (name.startsWith('chat.') && !roles.has(payload.role)) throw fail('ROLE_MISMATCH', 'An explicit chat role is required.');
      if ((name === 'project.activate' || (name === 'project.choose' && payload.role !== undefined)) && !roles.has(payload.role)) throw fail('ROLE_MISMATCH', 'An explicit composer role is required.');
      // Targets are explicit; pane focus never grants authority or changes routing.
      if (name.startsWith("side.")) {
        if (payload.role !== "side_chat") throw fail("ROLE_MISMATCH", "A Side Chat target is required.");
        if (payload.agentPanelId && payload.agentPanelId !== service.readSnapshot().activeAgentId) throw fail("CONVERSATION_MISMATCH", "The Agent Work conversation changed.");
        if (["side.send", "side.edit", "side.copy", "side.fork"].includes(name) && payload.conversationId !== service.readSnapshot().activeConversationId) {
          throw fail("CONVERSATION_MISMATCH", "The conversation changed.");
        }
      }
      if (name.startsWith("agent.")) {
        if (payload.role !== "agent_command") throw fail("ROLE_MISMATCH", "An Agent Work target is required.");
        if (name !== "agent.new" && !service.readSnapshot().agents.some(item => item.id === payload.conversationId)) {
          throw fail("CONVERSATION_MISMATCH", "The Agent Work conversation changed.");
        }
      }
      const key = `${name}:${payload.conversationId || ""}`;
      if (pending.has(key)) return pending.get(key);
      const generation = epoch;
      const sideAgentId = name.startsWith('side.') ? service.readSnapshot().activeAgentId : null;
      const task = Promise.resolve().then(() => {
        if (generation !== epoch) throw fail("PROJECT_MISMATCH", "The project changed before this action started.");
        if (!navigation.has(name) || payload.projectId) assertProject(payload.projectId);
        if (name.startsWith('side.') && sideAgentId !== service.readSnapshot().activeAgentId) throw fail('CONVERSATION_MISMATCH', 'The Agent Work conversation changed before this action started.');
        return service.commands[name](payload);
      });
      pending.set(key, task);
      try { return await task; }
      finally { if (pending.get(key) === task) pending.delete(key); invalidate(); }
    }
    function beginTurn({ role, conversationId, model, permission = "read_only", sourcePaths = [], signal }) {
      if (!roles.has(role)) throw fail("ROLE_MISMATCH", "Unknown execution role.");
      const projectId = service?.readSnapshot().project?.id;
      assertProject(projectId);
      const key = `${role}:${conversationId}`, generation = epoch;
      if (runs.get(key)?.state.status === "running") throw fail("TURN_ACTIVE", "This conversation already has an active turn.");
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      const run = { controller, state: { projectId, role, conversationId, model,
        permission: role === "side_chat" ? "read_only" : permission,
        sourcePaths: [...sourcePaths], status: "running", steps: [], outputCharacters: 0 } };
      runs.set(key, run);
      const isCurrent = () => generation === epoch && service?.readSnapshot().project?.id === projectId && runs.get(key) === run;
      function event(value) {
        if (!isCurrent() || controller.signal.aborted) return;
        if (value.type === "delta") run.state.outputCharacters += String(value.text || "").length;
        if (value.type === "status" || value.stage) {
          const step = { stage: String(value.stage || "working"), capability: String(value.capability || ""), message: String(value.message || "") };
          if (JSON.stringify(run.state.steps.at(-1)) !== JSON.stringify(step)) run.state.steps = [...run.state.steps, step].slice(-40);
        }
        invalidate();
      }
      function finish(status = "completed", error = "") {
        signal?.removeEventListener("abort", abort);
        if (!isCurrent()) return;
        run.state.status = controller.signal.aborted ? "cancelled" : status;
        run.state.error = error;
        invalidate();
      }
      invalidate();
      return { signal: controller.signal, isCurrent, event, finish };
    }
    return Object.freeze({
      connect(next) { if (service) throw new Error("Frontend service is already connected."); service = next; refresh(); },
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      invalidate, invalidateProject, command, beginTurn,
      cancel({ projectId, role, conversationId }) {
        assertProject(projectId);
        // Cloud Side Chat is cancellable. Local Agent Work writes are not advertised as cancellable.
        if (role !== "side_chat") throw fail("CANCEL_UNSUPPORTED", "Agent Work cannot be stopped during a desktop operation.");
        runs.get(`${role}:${conversationId}`)?.controller.abort();
      },
    });
  }
  return { createFrontendAdapter };
});
