import { EventEmitter } from "node:events";
import path from "node:path";

const failure = (code, message) => Object.assign(new Error(message), { code });

// Main-process side of the agent loop utility process. Owns turn promises and
// relays events and step boundaries; the service decides where a boundary is
// answered (the renderer that started the turn).
export class AgentLoopClient extends EventEmitter {
  constructor({ utilityProcess, modulePath }) {
    super();
    this.utilityProcess = utilityProcess;
    this.modulePath = modulePath;
    this.child = null;
    this.turns = new Map();
    this.closed = false;
  }

  start() {
    if (this.child) return;
    const safeEnvironment = {};
    for (const name of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TMPDIR", "TEMP", "TMP", "PATH", "SystemRoot"]) {
      if (process.env[name]) safeEnvironment[name] = process.env[name];
    }
    // No project root, credentials or provider configuration in the environment.
    this.child = this.utilityProcess.fork(this.modulePath, [], { serviceName: "BioDesign Agent Loop", stdio: "pipe", env: safeEnvironment });
    this.child.on("message", message => this.handleMessage(message));
    this.child.on("exit", code => {
      this.child = null;
      this.failAll(failure("AGENT_WORKER_EXITED", `The agent loop process exited with code ${code}.`));
      if (!this.closed) this.emit("crash", { code });
    });
    this.child.stderr?.on("data", bytes => this.emit("diagnostic", String(bytes).slice(0, 1000)));
  }

  failAll(error) {
    for (const turn of this.turns.values()) turn.reject(error);
    this.turns.clear();
  }

  post(message) {
    this.child?.postMessage(message);
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") return;
    const turn = this.turns.get(message.turnId);
    if (!turn) return;
    if (message.type === "event") turn.onEvent?.(message.event);
    else if (message.type === "boundary") void this.answerBoundary(turn, message);
    else if (message.type === "done") {
      this.turns.delete(message.turnId);
      if (message.ok) turn.resolve(message.result);
      else turn.reject(Object.assign(new Error(message.error?.message || "The agent turn failed."), message.error || { code: "AGENT_TURN_FAILED" }));
    }
  }

  // A failed or abandoned boundary cancels the turn rather than guessing a reply.
  async answerBoundary(turn, message) {
    let reply;
    try { reply = await turn.onBoundary(message.data); }
    catch { this.cancel(message.turnId); return; }
    if (this.turns.get(message.turnId) === turn) this.post({ type: "boundary-reply", turnId: message.turnId, boundaryId: message.boundaryId, reply });
  }

  runTurn({ turnId, token, baseUrl, body, archiveRoot }, { onEvent, onBoundary }) {
    if (this.closed) return Promise.reject(failure("AGENT_LOOP_CLOSED", "The agent loop is closed."));
    this.start();
    return new Promise((resolve, reject) => {
      this.turns.set(turnId, { resolve, reject, onEvent, onBoundary });
      this.post({ type: "start", turnId, token, baseUrl, body, archiveRoot });
    });
  }

  cancel(turnId) { this.post({ type: "cancel", turnId }); }
  steer(turnId, item) { this.post({ type: "steer", turnId, item }); }
  inject(turnId, item) { this.post({ type: "inject", turnId, item }); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.child) {
      const child = this.child;
      await Promise.race([new Promise(resolve => {
        const listener = message => { if (message?.type === "closed") { child.off?.("message", listener); resolve(); } };
        child.on("message", listener);
        this.post({ type: "close" });
      }), new Promise(resolve => setTimeout(resolve, 2000))]);
      child.kill();
      this.child = null;
    }
    this.failAll(failure("PROJECT_CLOSED", "The active project was closed."));
  }

  static modulePath(appPath) {
    return path.join(appPath, "desktop", "workers", "agent-loop-worker.mjs");
  }
}
