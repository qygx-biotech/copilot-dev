const bareReference = '(?:f[0-9]+)?e[0-9]+';
const exactReference = new RegExp(`^(?:(${bareReference})|\\[ref=(${bareReference})\\])$`);

export const referenceGuidance = 'Use a reference from the current snapshot only. For example, [ref=e45] means target: "e45"; [ref=f1e45] means target: "f1e45". Exact bracketed equivalents and surrounding whitespace are also accepted. CSS/XPath selectors and descriptive text are not accepted.';

export function normalizeSnapshotReference(value, { allowLatestDownload = false } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (allowLatestDownload && trimmed === 'latest_download') return trimmed;
  const match = exactReference.exec(trimmed);
  return match ? match[1] || match[2] : null;
}

export function referenceSchema({ allowLatestDownload = false } = {}) {
  return {
    type: 'string',
    pattern: `^\\s*(?:${bareReference}|\\[ref=${bareReference}\\]${allowLatestDownload ? '|latest_download' : ''})\\s*$`,
    description: referenceGuidance + (allowLatestDownload ? ' Article capture also accepts "latest_download" for an already observed download.' : ''),
  };
}

// Restrict the upstream MCP target schema to the host's snapshot-only policy.
export function restrictBrowserTool(tool) {
  if (!tool.inputSchema?.properties?.target) return tool;
  return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, target: referenceSchema() } } };
}

export function skippedReference(status, observation = {}, diagnostics) {
  const needsLogin = status === 'needs_login' || observation.status === 'needs_login';
  return {
    ...observation,
    status: needsLogin ? 'needs_login' : status,
    action_skipped: true,
    ...(observation.status ? { observation_status: observation.status } : {}),
    ...(observation.reason ? { observation_reason: observation.reason } : {}),
    reason: diagnostics?.reason || (status === 'invalid_reference' ? 'malformed_reference' : needsLogin ? 'needs_login' : 'reference_not_in_snapshot'),
    ...(diagnostics ? { diagnostics } : {}),
    message: needsLogin
      ? 'Requested action was skipped. Complete sign-in in the dedicated browser, then resume and inspect a fresh snapshot.'
      : status === 'invalid_reference'
        ? `Requested action was skipped because target has malformed reference syntax. ${referenceGuidance}`
        : `Requested action was skipped: ${diagnostics?.reason || 'reference_not_in_snapshot'}. The target may appear in the refreshed snapshot even though the preceding action was skipped. Inspect the observation and choose the next call; no action was replayed.`,
  };
}
