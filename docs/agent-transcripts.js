// The canonical transcript of each Agent Work conversation: every turn's user
// request, assistant steps, tool calls and tool results, in the same format and
// limits as Side Chat's (shared/conversation-transcript.js). The agent loop
// replays it on the next turn, so a follow-up keeps earlier instructions,
// results and tool history. Stored per conversation, outside state.json:
// .biodesign/chat/agents/<conversation>/agent-transcript.json.
(function expose(root, factory) {
  const api = factory(root?.BioDesignConversationTranscript || (typeof require === "function" ? require("../shared/conversation-transcript.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignAgentTranscripts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (transcriptApi) {
  "use strict";
  const VERSION = 1;
  const ID = /^[a-zA-Z0-9_-]{1,200}$/;
  const fail = (code, message = code) => Object.assign(new Error(message), { code });
  const missing = error => ["FILE_NOT_FOUND", "NOT_FOUND", "ENOENT"].includes(error?.code) || error?.name === "NotFoundError";

  // The transcript's turn for a visible user message: its own ID, or the turn
  // it was queued into.
  const turnIdOf = message => message?.injection?.turnId || message?.id;

  class AgentTranscripts {
    constructor({ workspace }) {
      this.workspace = workspace;
      this.queues = new Map();
    }

    directory(conversationId) {
      if (typeof conversationId !== "string" || !ID.test(conversationId)) throw fail("INVALID_AGENT_CONVERSATION");
      return `.biodesign/chat/agents/${conversationId}`;
    }
    path(conversationId) { return `${this.directory(conversationId)}/agent-transcript.json`; }

    // One write at a time per conversation; transcript checkpoints stream often.
    serialized(conversationId, action) {
      const previous = this.queues.get(conversationId) || Promise.resolve();
      const next = previous.then(action, action);
      const settled = next.catch(() => {});
      this.queues.set(conversationId, settled);
      settled.then(() => { if (this.queues.get(conversationId) === settled) this.queues.delete(conversationId); });
      return next;
    }

    // The stored transcript, or null when none was saved yet. A file that
    // cannot be read or parsed is reported, never silently replaced.
    async read(conversationId) {
      let stored;
      try { stored = await this.workspace.readJson(this.path(conversationId)); }
      catch (error) { if (missing(error)) return null; throw error; }
      if (stored?.version !== VERSION || stored.transcript?.version !== transcriptApi.VERSION) throw fail("INVALID_AGENT_TRANSCRIPT", "The Agent Work transcript file is not valid.");
      return transcriptApi.normalize(stored.transcript);
    }

    async write(conversationId, transcript) {
      await this.workspace.ensureDirectory(this.directory(conversationId));
      await this.workspace.writeJson(this.path(conversationId), { version: VERSION, transcript: transcriptApi.normalize(transcript) });
    }

    // The transcript a new turn replays. Earlier visible messages without a
    // stored turn (conversations from before transcripts, or turns whose
    // transcript was lost) become text-only turns; tool history is never
    // invented. A revision discards the replaced turns.
    prepare(conversationId, { messages = [], discardedTurnIds = [] } = {}) {
      return this.serialized(conversationId, async () => {
        const stored = await this.read(conversationId);
        let transcript = transcriptApi.forConversation({ transcript: stored || undefined, messages });
        if (discardedTurnIds.length) transcript = transcriptApi.beforeRevision(transcript, discardedTurnIds);
        await this.write(conversationId, transcript);
        return transcript;
      });
    }

    // Saves a turn checkpoint from the agent loop.
    saveTurn(conversationId, turn) {
      const checkpoint = JSON.parse(JSON.stringify(turn));
      return this.serialized(conversationId, async () => {
        const transcript = transcriptApi.upsert(await this.read(conversationId), checkpoint);
        await this.write(conversationId, transcript);
        return transcript;
      });
    }

    // A forked conversation starts with the turns of the messages it keeps.
    copy(fromId, toId, keptMessages) {
      return this.serialized(toId, async () => {
        const source = await this.read(fromId);
        if (!source) return null;
        const kept = new Set((keptMessages || []).filter(message => message?.role === "user").map(turnIdOf));
        const keep = turn => kept.has(turn.turnId);
        const transcript = transcriptApi.normalize({ ...source, turns: source.turns.filter(keep), summaries: source.summaries.filter(keep), discardedTurnIds: [] });
        await this.write(toId, transcript);
        return transcript;
      });
    }

    remove(conversationId) {
      return this.serialized(conversationId, async () => {
        if (await this.workspace.fileExists(this.path(conversationId))) await this.workspace.removeFile(this.path(conversationId));
      });
    }
  }

  return { VERSION, AgentTranscripts, turnIdOf };
});
