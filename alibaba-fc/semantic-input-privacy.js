"use strict";

// Recognize path syntax, not a standalone double backslash: that is also a
// LaTeX row separator and occurs in JSON-escaped mathematical commands.
function privateMaterialReason(value) {
  const text = String(value || "");
  if (/(^|[\s("'`=:[{<>$：，‘“])(?:\/(?:Users|home|private|var|tmp|Volumes|etc|root|opt|usr|srv|mnt|proc|dev|Library|System|Applications|workspace|workspaces)\/|[A-Za-z]:[\\/]|file:\/\/)/i.test(text)) return "filesystem_path";
  // Extended Windows device/UNC paths, including their JSON-escaped forms.
  if (/(^|[\s("'`=:[{<>$：，‘“])\\{2,8}[?.]\\+(?:UNC\\+|[A-Za-z]:\\+)/i.test(text)) return "filesystem_path";
  // A UNC path requires both a server and a share. A JSON encoding doubles
  // BOTH the leading pair and the component separator (4:2, versus raw 2:1).
  // Escaped adjacent LaTeX commands instead have 2:2 and are not UNC paths.
  const unc = /(^|[\s("'`=:[{<>$：，‘“])(\\{2,8})([\p{L}\p{N}_.-]+)(\\+)([\p{L}\p{N}_$.-]+)(?=$|[\\/\s"'`),;\]}<>$。？！，”’]|\.[\p{L}\p{N}])/gu;
  for (const match of text.matchAll(unc)) {
    if ([2, 4, 8].includes(match[2].length) && match[4].length === match[2].length / 2) return "filesystem_path";
  }
  if (/\bAuthorization\s*(?:\\*["'])?\s*:\s*\S+/i.test(text)) return "authorization_header";
  if (/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/.test(text) ||
      /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*(?:\\*["'])?\s*[:=]\s*["']?[^\s"',}]+/i.test(text) ||
      /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)) return "credential";
  if (/data:application\/pdf;base64,|%PDF-\d\.\d|\bJVBERi0[A-Za-z0-9+/]{16,}/i.test(text)) return "private_pdf_data";
  return null;
}

module.exports = { privateMaterialReason };
