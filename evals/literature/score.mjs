// Retrieval yield from host receipts. Every number comes from host-verified
// outcomes; nothing is inferred from model prose.
const ratio = (a, b) => b ? a / b : null;
export function scoreRetrieval(rows) {
  const saved = rows.filter(row => ['downloaded', 'already_present'].includes(row.status));
  const count = (key, value) => rows.filter(row => row[key] === value).length;
  const times = rows.map(row => row.ms).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))] : null;
  return {
    papers: rows.length, saved: saved.length, saved_rate: ratio(saved.length, rows.length),
    by_status: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, count('status', status)])),
    by_route: Object.fromEntries([...new Set(saved.map(row => row.route))].map(route => [route, saved.filter(row => row.route === route).length])),
    by_version: Object.fromEntries([...new Set(saved.map(row => row.version))].map(version => [version, saved.filter(row => row.version === version).length])),
    quarantined: count('status', 'downloaded_unverified'), waiting_for_user: count('status', 'needs_login'),
    median_ms: percentile(0.5), p90_ms: percentile(0.9), total_ms: times.reduce((sum, ms) => sum + ms, 0),
  };
}
