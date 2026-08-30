export function normalizeArchiveEntry(value) {
  const relative = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  return `/${relative}`;
}

export function archiveEntryForExtraction(value) {
  return String(value || "").replace(/^[/\\]+/, "");
}
