"use strict";

// Admission of an agent request body into the loop's desktop context:
// transcript, image, runtime-extension and permission checks. FC uses
// validImageBytes for image understanding.

const images = require("../chat-images.js");
const transcript = require("../conversation-transcript.js");
const runtimeExtensions = require("../runtime-extensions.js");
const genericSubagent = require("../generic-subagent.js");

function validImageBytes(image) {
  const info = images.dataUrlInfo(image.dataUrl);
  const bytes = Buffer.from(info.base64, "base64");
  if (bytes.toString("base64") !== info.base64) return false;
  if (info.mimeType === "image/png") return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (info.mimeType === "image/jpeg") return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  return bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}

const rejected = (error, message) => ({ error: { status: 400, body: { error, ...(message ? { message } : {}) } } });

// Returns { desktopContext } or { error: { status, body } }. `account` scopes
// archives; `childModel` is the configured model a child agent must keep.
function admitDesktopContext(body, { responseMode, originalRequest, localWorkspaceContext, account, signal, childModel }) {
  const desktopContext = { account, signal, originalRequest, enabled: responseMode !== "side_chat" && body.desktopTools?.version === 1,
    literature: responseMode !== "side_chat" && body.desktopTools?.version === 1 && body.desktopTools?.literatureVersion === 1,
    permission: ["workspace_write", "full_access"].includes(body.desktopTools?.permission) ? body.desktopTools.permission : "read_only",
    // Plan mode (Agent Work only): explore and propose, change nothing.
    collaborationMode: responseMode !== "side_chat" && body.desktopTools?.collaborationMode === "plan" ? "plan" : "default" };
  // Side Chat and Agent Work conversations both replay their canonical transcript.
  if (body.conversationTranscript !== undefined) {
    if (body.conversationTranscript?.version !== 1) return rejected("INVALID_CONVERSATION_TRANSCRIPT");
    desktopContext.conversationTranscript = transcript.normalize(body.conversationTranscript);
  }
  desktopContext.projectTools = localWorkspaceContext?.agentLoop?.version === 1 && (responseMode === "side_chat" || desktopContext.literature);
  if (body.images !== undefined) {
    try {
      desktopContext.images = images.validateImages(body.images);
      if (!desktopContext.images.every(validImageBytes)) throw new Error();
    } catch { return rejected("IMAGE_INVALID", "Invalid or oversized image attachment."); }
  }
  try {
    desktopContext.runtimeExtensions = runtimeExtensions.normalize(body.runtimeExtensions);
    desktopContext.runtimeInjections = runtimeExtensions.injections(body.runtimeInjections);
    if (body.runtimeRevokedTools !== undefined && (!Array.isArray(body.runtimeRevokedTools) || body.runtimeRevokedTools.length > 128 || body.runtimeRevokedTools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(name)))) throw new Error();
    desktopContext.runtimeRevokedTools = body.runtimeRevokedTools || [];

    if (desktopContext.runtimeExtensions && !desktopContext.projectTools) throw new Error();
    if (!desktopContext.runtimeExtensions && desktopContext.runtimeInjections.length) throw new Error();
    if (desktopContext.runtimeExtensions?.child) {
      const child = genericSubagent.normalizeChild(desktopContext.runtimeExtensions.child, {
        model: childModel, projectId: localWorkspaceContext?.project?.workspaceId });
      if (responseMode !== 'side_chat' || desktopContext.runtimeInjections.some(item => item.kind !== 'subagent') || desktopContext.runtimeExtensions.genericSubagents || desktopContext.runtimeExtensions.mcpTools.length) throw new Error();
      desktopContext.runtimeExtensions.child = child;
    }
  } catch { return rejected("INVALID_RUNTIME_EXTENSIONS"); }
  return { desktopContext };
}

module.exports = { admitDesktopContext, validImageBytes };
