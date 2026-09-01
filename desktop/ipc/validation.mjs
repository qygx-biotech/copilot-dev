import path from "node:path";
import retrievalContract from "../../shared/retrieval-contract.js";

export const KNOWLEDGE_COLLECTIONS = retrievalContract.RETRIEVAL_COLLECTIONS;

const COLLECTION_SET = new Set(KNOWLEDGE_COLLECTIONS);

export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

export function assertRecord(value, label = "payload") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("INVALID_PAYLOAD", `${label} must be an object.`);
  }
  return value;
}

export function assertOnlyKeys(value, allowed, label = "payload") {
  assertRecord(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ValidationError("UNKNOWN_FIELD", `${label}.${key} is not allowed.`);
    }
  }
  return value;
}

export function assertRelativePath(value, options = {}) {
  const label = options.label || "relativePath";
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) {
    throw new ValidationError("INVALID_PATH", `${label} must be a non-empty project-relative path.`);
  }
  if (value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new ValidationError("INVALID_PATH", `${label} must use relative POSIX path syntax.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ValidationError("INVALID_PATH", `${label} cannot contain empty, dot, or parent segments.`);
  }
  return value;
}

export function assertWorkspaceId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) {
    throw new ValidationError("INVALID_WORKSPACE_ID", "workspaceId is invalid.");
  }
  return value;
}

export function assertCollections(value, options = {}) {
  if (value === undefined && options.optional) return [];
  if (!Array.isArray(value) || value.length > KNOWLEDGE_COLLECTIONS.length) {
    throw new ValidationError("INVALID_COLLECTIONS", "collections must be a bounded array.");
  }
  const collections = [...new Set(value.map(String))];
  if (collections.some((collection) => !COLLECTION_SET.has(collection))) {
    throw new ValidationError("QMD_COLLECTION_NOT_ALLOWED", "A knowledge collection is not allowed.");
  }
  return collections;
}

export function boundedString(value, label, maximum, options = {}) {
  if (typeof value !== "string" || (!options.allowEmpty && !value.trim()) || value.length > maximum) {
    throw new ValidationError("INVALID_STRING", `${label} must be at most ${maximum} characters.`);
  }
  return value;
}

export function boundedInteger(value, label, minimum, maximum, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ValidationError("INVALID_NUMBER", `${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

export function sanitizeError(error) {
  const message = String(error?.message || "Desktop operation failed")
    .replace(/(bearer|token|password|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 1000);
  return {
    code: String(error?.code || error?.name || "DESKTOP_OPERATION_FAILED").slice(0, 100),
    message,
  };
}
