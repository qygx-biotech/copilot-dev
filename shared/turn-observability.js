(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioDesignTurnObservability = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 1;
  const LIMITS = Object.freeze({ rounds: 64, activities: 160, diffLines: 400, diffCharacters: 64000, diffCells: 160000 });
  const text = (value, limit = 200) => typeof value === 'string' ? value.slice(0, limit) : '';
  const number = value => Number.isFinite(value) && value >= 0 ? value : null;
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const copy = value => JSON.parse(JSON.stringify(value));
  const first = (...values) => values.find(value => number(value) !== null) ?? null;

  function normalizeTokens(raw) {
    const inputTokens = first(raw?.prompt_tokens, raw?.input_tokens);
    const outputTokens = first(raw?.completion_tokens, raw?.output_tokens);
    const cached = first(raw?.prompt_tokens_details?.cached_tokens, raw?.input_tokens_details?.cached_tokens, raw?.cached_tokens);
    const cachedTokens = cached !== null && inputTokens !== null && cached > inputTokens ? null : cached;
    return { inputTokens, outputTokens, cachedTokens,
      totalTokens: first(raw?.total_tokens, inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null) };
  }

  function createUsage(previous, { turnId = '', model = '', now = Date.now() } = {}) {
    const compatible = previous?.version === VERSION && (!turnId || previous.turnId === turnId);
    const prior = compatible ? previous : {};
    const keys = ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens'];
    return { version: VERSION, turnId: text(turnId || prior.turnId), model: text(model || prior.model),
      sequence: integer(prior.sequence) ?? 0, startedAt: number(prior.startedAt) ?? now, updatedAt: number(prior.updatedAt) ?? now,
      committedThrough: integer(prior.committedThrough) ?? integer(prior.sequence) ?? 0,
      seenSequences: Array.isArray(prior.seenSequences) ? prior.seenSequences.filter(value => integer(value) !== null).slice(-LIMITS.rounds) : [],
      generationMs: number(prior.generationMs) ?? 0,
      totals: Object.fromEntries(keys.map(key => [key, number(prior.totals?.[key])])),
      coverage: { requests: integer(prior.coverage?.requests) ?? 0, attempts: integer(prior.coverage?.attempts) ?? 0,
        ...Object.fromEntries(keys.map(key => [key, integer(prior.coverage?.[key]) ?? 0])) },
      rounds: Array.isArray(prior.rounds) ? prior.rounds.slice(-LIMITS.rounds).flatMap(round => {
        if (!round || !text(round.id) || integer(round.sequence) === null) return [];
        return [{ id: text(round.id), sequence: round.sequence, model: text(round.model), stage: text(round.stage, 100),
          startedAt: number(round.startedAt), endedAt: number(round.endedAt), durationMs: number(round.durationMs),
          ok: round.ok === true, attempts: Math.max(1, integer(round.attempts) || 1),
          ...Object.fromEntries(keys.map(key => [key, number(round[key])])) }];
      }) : [] };
  }

  // A monotonic request sequence is retained in the turn's continuation state.
  // Replayed stream snapshots replace prior snapshots; they are never summed.
  function recordUsage(state, { id, sequence = state.sequence + 1, model, stage, startedAt, endedAt = Date.now(), usage, ok, attempts = 1 }) {
    if (integer(sequence) === null || sequence <= state.committedThrough || state.seenSequences.includes(sequence) || !text(id)) return false;
    const tokens = normalizeTokens(usage);
    const durationMs = number(startedAt) !== null && endedAt >= startedAt ? endedAt - startedAt : null;
    const round = { id: text(id), sequence, model: text(model || state.model), stage: text(stage, 100),
      startedAt: number(startedAt), endedAt: number(endedAt), durationMs, ok: ok === true,
      attempts: Math.max(1, integer(attempts) || 1), ...tokens };
    state.sequence = Math.max(state.sequence, sequence); state.updatedAt = Math.max(state.updatedAt, endedAt);
    state.seenSequences.push(sequence);
    while (state.seenSequences.includes(state.committedThrough + 1)) {
      state.committedThrough++;
      state.seenSequences.splice(state.seenSequences.indexOf(state.committedThrough), 1);
    }
    state.coverage.requests++; state.coverage.attempts += round.attempts;
    state.generationMs += durationMs || 0;
    for (const [key, value] of Object.entries(tokens)) if (value !== null) {
      state.totals[key] = (state.totals[key] ?? 0) + value;
      state.coverage[key]++;
    }
    state.rounds.push(round); state.rounds.sort((a, b) => a.sequence - b.sequence); state.rounds = state.rounds.slice(-LIMITS.rounds);
    return true;
  }

  function usageSnapshot(state) {
    const result = copy(state);
    result.cacheHitRate = result.totals.inputTokens > 0 && result.totals.cachedTokens !== null &&
      result.coverage.cachedTokens === result.coverage.inputTokens
      ? result.totals.cachedTokens / result.totals.inputTokens : null;
    result.complete = result.coverage.requests > 0 && result.coverage.inputTokens === result.coverage.requests &&
      result.coverage.outputTokens === result.coverage.requests && result.coverage.attempts === result.coverage.requests;
    return result;
  }

  function normalizeActivity(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const stage = text(raw.stage, 100), callId = text(raw.callId || raw.toolCallId, 200);
    if (!stage) return null;
    const name = text(raw.capability || raw.tool || raw.name, 160);
    const kind = raw.kind === 'artifact' ? 'artifact' : callId || stage.startsWith('tool-') ? 'tool' : stage.startsWith('subagent-') ? 'subagent' : 'stage';
    const status = ['running', 'pending', 'completed', 'failed', 'cancelled', 'unknown'].includes(raw.status) ? raw.status
      : /failed|denied|error/.test(stage) ? 'failed' : /cancel|abort/.test(stage) ? 'cancelled'
        : /completed|created|success/.test(stage) ? 'completed' : /pending|handoff/.test(stage) ? 'pending' : 'running';
    const result = { id: text(raw.id || raw.artifact?.id || (callId ? 'tool:' + callId : `${stage}:${raw.step || raw.taskId || ''}`), 300), kind, stage, status,
      ...(callId ? { callId } : {}), ...(name ? { name } : {}),
      ...(integer(raw.step) !== null ? { step: raw.step } : {}),
      ...(number(raw.timestamp) !== null ? { timestamp: raw.timestamp } : {}),
      ...(number(raw.durationMs) !== null ? { durationMs: raw.durationMs } : {}) };
    if (raw.summary && typeof raw.summary === 'object') {
      const summary = raw.summary;
      result.summary = { ...(text(summary.code, 100) ? { code: text(summary.code, 100) } : {}),
        ...(text(summary.evidenceStatus, 100) ? { evidenceStatus: text(summary.evidenceStatus, 100) } : {}),
        ...(number(summary.sourceCount) !== null ? { sourceCount: summary.sourceCount } : {}),
        ...(number(summary.referenceCount) !== null ? { referenceCount: summary.referenceCount } : {}),
        ...(number(summary.resultCount) !== null ? { resultCount: summary.resultCount } : {}),
        // Files a project-mode call created, changed or deleted in output/.
        ...Object.fromEntries(['filesCreated', 'filesChanged', 'filesDeleted'].filter(key => integer(summary[key]) !== null).map(key => [key, summary[key]])),
        ...(Array.isArray(summary.sourceIds) ? { sourceIds: [...new Set(summary.sourceIds.map(value => text(value, 200)).filter(Boolean))].slice(0, 30) } : {}) };
    }
    return result;
  }

  function mergeActivity(list, raw) {
    const event = normalizeActivity(raw);
    if (!event) return list;
    const index = list.findIndex(item => item.id === event.id);
    if (index < 0) list.push(event);
    else {
      const previous = list[index];
      // Late/replayed running notifications cannot undo terminal receipts.
      if (['completed', 'failed', 'cancelled'].includes(previous.status) && ['running', 'pending'].includes(event.status)) return list;
      list[index] = { ...previous, ...event, ...(previous.summary || event.summary ? { summary: { ...previous.summary, ...event.summary } } : {}) };
    }
    if (list.length > LIMITS.activities) list.splice(0, list.length - LIMITS.activities);
    return list;
  }

  // LCS on a bounded changed region. Large texts never block the renderer;
  // the fallback explicitly marks its change counts as a replacement view.
  function diffLines(before, after, options = {}) {
    if (typeof before !== 'string' || typeof after !== 'string') throw new TypeError('Artifact diff requires before and after text.');
    const maxCharacters = Math.min(LIMITS.diffCharacters, options.maxCharacters || LIMITS.diffCharacters);
    const maxLines = Math.min(LIMITS.diffLines, options.maxLines || LIMITS.diffLines);
    const truncatedText = before.length > maxCharacters || after.length > maxCharacters;
    const split = value => value === '' ? [] : value.split('\n');
    const a = split(before.slice(0, maxCharacters)), b = split(after.slice(0, maxCharacters));
    let start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const left = a.slice(start, endA), right = b.slice(start, endB), rows = [];
    let added = 0, removed = 0, oldLine = start + 1, newLine = start + 1;
    const push = (type, content) => { if (type === 'add') added++; else if (type === 'remove') removed++;
      if (rows.length < maxLines) rows.push({ type, content, oldLine: type === 'add' ? null : oldLine, newLine: type === 'remove' ? null : newLine });
      if (type !== 'add') oldLine++; if (type !== 'remove') newLine++; };
    const replacement = (left.length + 1) * (right.length + 1) > LIMITS.diffCells;
    if (replacement) { left.forEach(line => push('remove', line)); right.forEach(line => push('add', line)); }
    else {
      const stride = right.length + 1, matrix = new Uint16Array((left.length + 1) * stride);
      for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--)
        matrix[i * stride + j] = left[i] === right[j] ? matrix[(i + 1) * stride + j + 1] + 1
          : Math.max(matrix[(i + 1) * stride + j], matrix[i * stride + j + 1]);
      let i = 0, j = 0;
      while (i < left.length || j < right.length) {
        if (i < left.length && j < right.length && left[i] === right[j]) { push('context', left[i]); i++; j++; }
        else if (i < left.length && (j === right.length || matrix[(i + 1) * stride + j] >= matrix[i * stride + j + 1])) push('remove', left[i++]);
        else push('add', right[j++]);
      }
    }
    return { added, removed, rows, unchanged: before === after, truncated: truncatedText || added + removed > maxLines || rows.length === maxLines && left.length + right.length > maxLines,
      replacement, countsComplete: !truncatedText, beforeLines: a.length, afterLines: b.length };
  }

  function normalizeDetails(raw) {
    if (!raw || raw.version !== VERSION || !text(raw.turnId)) return null;
    const safePath = path => typeof path === 'string' && path.length > 0 && path.length <= 600 &&
      !/^(?:[a-z]:|[/\\])|[\x00-\x1f]/i.test(path) && !path.split(/[/\\]/).some(part => part === '..' || part === '.');
    const result = { version: VERSION, turnId: text(raw.turnId), model: text(raw.model), startedAt: number(raw.startedAt) ?? 0,
      finishedAt: number(raw.finishedAt), activities: [], artifacts: [], turnUsage: null, childUsage: [] };
    // The turn's net changes to output/ in a project sandbox, as the host observed them.
    const changes = raw.outputChanges;
    if (changes && ['created', 'changed', 'deleted'].every(key => integer(changes[key]) !== null && changes[key] >= 0) && changes.created + changes.changed + changes.deleted > 0)
      result.outputChanges = { created: changes.created, changed: changes.changed, deleted: changes.deleted, complete: changes.complete === true, undoAvailable: changes.undoAvailable === true };
    for (const activity of (Array.isArray(raw.activities) ? raw.activities : []).slice(-LIMITS.activities)) mergeActivity(result.activities, activity);
    if (raw.turnUsage?.version === VERSION && raw.turnUsage.turnId === result.turnId)
      result.turnUsage = usageSnapshot(createUsage(raw.turnUsage, { turnId: result.turnId, model: result.model, now: result.startedAt }));
    for (const usage of (Array.isArray(raw.childUsage) ? raw.childUsage : []).slice(-8)) if (usage?.version === VERSION && text(usage.turnId)) {
      const normalized = usageSnapshot(createUsage(usage, { now: result.startedAt }));
      normalized.rounds = normalized.rounds.slice(-8); result.childUsage.push(normalized);
    }
    for (const artifact of (Array.isArray(raw.artifacts) ? raw.artifacts : []).slice(-20)) {
      if (artifact?.origin !== 'host-write' || !safePath(artifact.path) || !text(artifact.id)) continue;
      const item = { id: text(artifact.id), origin: 'host-write', path: artifact.path, timestamp: number(artifact.timestamp), durationMs: number(artifact.durationMs) };
      if (artifact.baselineUnavailable === true) item.baselineUnavailable = true;
      else if (artifact.diff && Array.isArray(artifact.diff.rows)) {
        const diff = artifact.diff;
        let remaining = LIMITS.diffCharacters;
        const rows = diff.rows.slice(0, LIMITS.diffLines).flatMap(row => {
          if (!row || !['add', 'remove', 'context'].includes(row.type) || remaining <= 0) return [];
          const content = text(row.content, remaining); remaining -= content.length + 1;
          return [{ type: row.type, content, oldLine: integer(row.oldLine), newLine: integer(row.newLine) }];
        });
        item.diff = { added: integer(diff.added), removed: integer(diff.removed), beforeLines: integer(diff.beforeLines), afterLines: integer(diff.afterLines),
          unchanged: diff.unchanged === true, replacement: diff.replacement === true, countsComplete: diff.countsComplete === true,
          truncated: diff.truncated === true || diff.rows.length !== rows.length || remaining <= 0, rows };
      } else continue;
      result.artifacts.push(item);
    }
    // Bound storage independently of transcript/context compaction. Nothing
    // here changes model context or source evidence retention.
    while (JSON.stringify(result).length > 200000) {
      if (result.artifacts.length) result.artifacts.shift();
      else if (result.activities.length) result.activities.shift();
      else if (result.childUsage.length) result.childUsage.shift();
      else break;
    }
    return result;
  }

  return { VERSION, LIMITS, normalizeTokens, createUsage, recordUsage, usageSnapshot, normalizeActivity, mergeActivity, diffLines, normalizeDetails };
});
