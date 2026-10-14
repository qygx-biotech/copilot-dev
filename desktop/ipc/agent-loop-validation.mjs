import { assertOnlyKeys, assertRecord, boundedString, ValidationError } from "./validation.mjs";

// Envelope checks for the agent loop IPC. The loop process admits the request
// content; these bounds keep oversized or malformed renderer payloads out of
// the main process and the loop process.
export const AGENT_LOOP_LIMITS = Object.freeze({
  requestBytes: 32 * 1024 * 1024, messages: 2000, tokenCharacters: 8192, injectionCharacters: 64000,
  boundaryResults: 64, boundaryInjections: 16, revokedTools: 128,
});
// The request fields the renderer sends at the start of a turn.
const BODY_KEYS = ["mode", "model", "runtimeExtensions", "runtimeInjections", "runtimeRevokedTools", "desktopTools",
  "images", "messages", "conversationTranscript", "originalRequest", "projectContext", "localWorkspaceContext", "callContext"];
const REPLY_KEYS = ["desktopToolResults", "runtimeInjections", "runtimeRevokedTools", "localWorkspaceContext"];
const TURN_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const INJECTION_ID = /^[\w:-]{1,128}$/;
const BOUNDARY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

const bounded = (value, label) => {
  if (Buffer.byteLength(JSON.stringify(value)) > AGENT_LOOP_LIMITS.requestBytes) throw new ValidationError("AGENT_REQUEST_TOO_LARGE", `${label} exceeds the size limit.`);
  return value;
};
const boundedArray = (value, label, maximum) => {
  if (value !== undefined && (!Array.isArray(value) || value.length > maximum)) throw new ValidationError("INVALID_ARRAY", `${label} must hold at most ${maximum} items.`);
};

export function assertTurnId(value) {
  if (typeof value !== "string" || !TURN_ID.test(value)) throw new ValidationError("INVALID_TURN_ID", "turnId is invalid.");
  return value;
}

function sessionToken(value) {
  if (typeof value !== "string" || value.length > AGENT_LOOP_LIMITS.tokenCharacters || !SESSION_TOKEN.test(value)) {
    throw new ValidationError("INVALID_SESSION_TOKEN", "A desktop session token is required.");
  }
  return value;
}

function chatBody(value) {
  const body = assertOnlyKeys(value, BODY_KEYS, "body");
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > AGENT_LOOP_LIMITS.messages ||
      body.messages.some(message => !message || typeof message !== "object" || Array.isArray(message) || typeof message.role !== "string")) {
    throw new ValidationError("INVALID_MESSAGES", `body.messages must hold 1–${AGENT_LOOP_LIMITS.messages} messages.`);
  }
  if (body.mode !== undefined && !["side_chat", "agent_instruction"].includes(body.mode)) throw new ValidationError("INVALID_MODE", "body.mode is invalid.");
  if (body.model !== undefined) boundedString(body.model, "body.model", 200);
  return bounded(body, "The agent request");
}

export function validateAgentStart(payload) {
  assertOnlyKeys(payload, ["projectId", "turnId", "token", "body"]);
  return { turnId: assertTurnId(payload.turnId), token: sessionToken(payload.token), body: chatBody(payload.body) };
}

export function validateAgentRespond(payload) {
  assertOnlyKeys(payload, ["projectId", "turnId", "boundaryId", "reply"]);
  if (typeof payload.boundaryId !== "string" || !BOUNDARY_ID.test(payload.boundaryId)) throw new ValidationError("INVALID_BOUNDARY_ID", "boundaryId is invalid.");
  let reply = null;
  if (payload.reply !== null) {
    reply = assertOnlyKeys(payload.reply, REPLY_KEYS, "reply");
    boundedArray(reply.desktopToolResults, "reply.desktopToolResults", AGENT_LOOP_LIMITS.boundaryResults);
    boundedArray(reply.runtimeInjections, "reply.runtimeInjections", AGENT_LOOP_LIMITS.boundaryInjections);
    boundedArray(reply.runtimeRevokedTools, "reply.runtimeRevokedTools", AGENT_LOOP_LIMITS.revokedTools);
    if (reply.localWorkspaceContext !== undefined) assertRecord(reply.localWorkspaceContext, "reply.localWorkspaceContext");
    bounded(reply, "The boundary reply");
  }
  return { turnId: assertTurnId(payload.turnId), boundaryId: payload.boundaryId, reply };
}

export function validateAgentCancel(payload) {
  assertOnlyKeys(payload, ["projectId", "turnId"]);
  return { turnId: assertTurnId(payload.turnId) };
}

function injection(payload, kind, extraKeys = []) {
  assertOnlyKeys(payload, ["projectId", "turnId", "id", "content", ...extraKeys]);
  if (typeof payload.id !== "string" || !INJECTION_ID.test(payload.id)) throw new ValidationError("INVALID_INJECTION_ID", "id is invalid.");
  boundedString(payload.content, "content", AGENT_LOOP_LIMITS.injectionCharacters);
  return { turnId: assertTurnId(payload.turnId), item: { id: payload.id, kind, content: payload.content,
    ...(payload.taskId === undefined ? {} : { taskId: boundedString(payload.taskId, "taskId", 128) }) } };
}

// User steering and delegated (subagent) results keep separate kinds, matching
// the existing runtime injection contract.
export const validateAgentSteer = payload => injection(payload, "user");
export const validateAgentInject = payload => injection(payload, "subagent", ["taskId"]);
