import crypto from "node:crypto";
import path from "node:path";
import { AgentLoopClient } from "../workers/agent-loop-client.mjs";
import { ValidationError } from "../ipc/validation.mjs";

export const AGENT_PROXY_URL_OVERRIDE = "BIODESIGN_AGENT_PROXY_URL";
// Context archives of local turns, inside the project's private state.
export const CONTEXT_ARCHIVE_PATH = ".biodesign/runtime/context-archives";

// Turns of the desktop agent loop. Each turn belongs to the window that started
// it: its events and step boundaries go only there, and only that window may
// answer, steer or cancel it. Tools run in the renderer's existing executors
// (runtime registry, project services, host workflows).
export class AgentLoopService {
  constructor({ sessionManager, utilityProcess, appPath, baseUrl, createClient, sendEvent }) {
    this.sessionManager = sessionManager;
    this.baseUrl = baseUrl;
    this.sendEvent = sendEvent;
    this.createClient = createClient || (() => new AgentLoopClient({ utilityProcess, modulePath: AgentLoopClient.modulePath(appPath) }));
    this.client = null;
    this.clientProject = null;
    this.turns = new Map();
    sessionManager.on?.("closed", () => { void this.closeClient(); });
  }

  ensureClient(active) {
    if (this.client && this.clientProject !== active) void this.closeClient();
    if (!this.client) {
      this.client = this.createClient();
      this.clientProject = active;
    }
    return this.client;
  }

  async closeClient() {
    const client = this.client;
    this.client = null;
    this.clientProject = null;
    for (const turnId of [...this.turns.keys()]) this.endBoundaries(turnId);
    await client?.close();
  }

  ownedTurn(sender, turnId) {
    const turn = this.turns.get(turnId);
    if (!turn || turn.sender !== sender) throw new ValidationError("TURN_NOT_FOUND", "No running turn matches this request.");
    return turn;
  }

  endBoundaries(turnId) {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    for (const pending of turn.boundaries.values()) pending.reject(Object.assign(new Error("The agent turn ended."), { code: "OPERATION_ABORTED" }));
    turn.boundaries.clear();
  }

  async start(sender, { turnId, token, body }) {
    const active = this.sessionManager.requireActive();
    if (this.turns.has(turnId)) throw new ValidationError("TURN_ALREADY_RUNNING", "This turn is already running.");
    const client = this.ensureClient(active);
    const turn = { sender, client, boundaries: new Map() };
    this.turns.set(turnId, turn);
    const cancelOnDestroy = () => this.cancelTurn(turnId);
    sender.once?.("destroyed", cancelOnDestroy);
    const deliver = event => { if (!sender.isDestroyed?.()) this.sendEvent(sender, { turnId, event }); };
    try {
      return await client.runTurn({ turnId, token, baseUrl: this.baseUrl, body,
        archiveRoot: path.join(active.filesystem.root, CONTEXT_ARCHIVE_PATH) }, {
        onEvent: deliver,
        // The renderer answers through respond(); the loop waits in place.
        onBoundary: data => new Promise((resolve, reject) => {
          const boundaryId = crypto.randomUUID();
          turn.boundaries.set(boundaryId, { resolve, reject });
          deliver({ type: "boundary", boundaryId, data });
        }),
      });
    } finally {
      sender.removeListener?.("destroyed", cancelOnDestroy);
      this.endBoundaries(turnId);
      this.turns.delete(turnId);
    }
  }

  cancelTurn(turnId) {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.endBoundaries(turnId);
    turn.client.cancel(turnId);
  }

  cancel(sender, { turnId }) {
    this.ownedTurn(sender, turnId);
    this.cancelTurn(turnId);
    return { cancelled: true };
  }

  respond(sender, { turnId, boundaryId, reply }) {
    const turn = this.ownedTurn(sender, turnId);
    const pending = turn.boundaries.get(boundaryId);
    if (!pending) throw new ValidationError("BOUNDARY_NOT_FOUND", "No pending step boundary matches this reply.");
    turn.boundaries.delete(boundaryId);
    pending.resolve(reply);
    return { accepted: true };
  }

  steer(sender, { turnId, item }) {
    this.ownedTurn(sender, turnId).client.steer(turnId, item);
    return { queued: true };
  }

  inject(sender, { turnId, item }) {
    this.ownedTurn(sender, turnId).client.inject(turnId, item);
    return { queued: true };
  }
}
