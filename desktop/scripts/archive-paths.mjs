export function normalizeArchiveEntry(value) {
  const relative = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  return `/${relative}`;
}
