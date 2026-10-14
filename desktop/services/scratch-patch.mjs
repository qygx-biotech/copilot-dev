const fail = message => Object.assign(new Error(message), { code: 'INVALID_PATCH' });
// Codex patch grammar, with exact context matching. Ambiguous context is rejected
// rather than guessed; all files are validated before any write occurs.
// Production scratch callers execute this module inside the OS sandbox. The
// injected filesystem's path checks alone do not protect against rename races.
// Each target is checked as writable before it is read, and all before any write.
export async function applyPatch(fs, patch) {
  const lines = patch.replace(/\r\n/g, '\n').trimEnd().split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw fail('Expected patch markers.');
  const changes = [], seen = new Set();
  while (lines.length) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines.shift());
    if (!match) throw fail('Expected file header.');
    const [, action, name] = match; fs.candidate(name); fs.assertWritable?.(name);
    if (seen.has(name)) throw fail('Repeated file target.'); seen.add(name);
    const exists = await fs.exists(name), before = exists ? await fs.readText(name) : null;
    if ((action === 'Add') === exists) throw fail('Target existence does not match operation.');
    let target = name;
    if (action === 'Update' && lines[0]?.startsWith('*** Move to: ')) {
      target = lines.shift().slice(13); fs.candidate(target); fs.assertWritable?.(target);
      if (seen.has(target) || await fs.exists(target)) throw fail('Move target exists.'); seen.add(target);
    }
    const body = []; while (lines.length && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[0])) body.push(lines.shift());
    let after = null;
    if (action === 'Add') {
      if (!body.length || body.some(line => !line.startsWith('+'))) throw fail('Add lines must start with +.');
      after = body.map(line => line.slice(1)).join('\n') + '\n';
    } else if (action === 'Delete') { if (body.length) throw fail('Delete must not have hunks.'); }
    else {
      const original = before.replace(/\r\n/g, '\n').split('\n'); if (original.at(-1) === '') original.pop();
      let cursor = 0; const result = [];
      while (body.length) {
        let anchor = '';
        if (body[0].startsWith('@@')) { const marker = body.shift(); if (marker !== '@@' && !marker.startsWith('@@ ')) throw fail('Invalid hunk.'); anchor = marker.slice(3); }
        if (anchor) {
          const pos = original.findIndex((line, i) => i >= cursor && line === anchor);
          if (pos < 0) throw fail('Context anchor not found.'); result.push(...original.slice(cursor, pos + 1)); cursor = pos + 1;
        }
        const old = [], replacement = []; let eof = false;
        while (body.length && !body[0].startsWith('@@')) {
          const line = body.shift();
          if (line === '*** End of File') { eof = true; break; }
          if (!/^[ +\-]/.test(line)) throw fail('Invalid hunk line.');
          if (line[0] !== '+') old.push(line.slice(1)); if (line[0] !== '-') replacement.push(line.slice(1));
        }
        if (!old.length && !replacement.length) throw fail('Empty hunk.');
        const matches = [];
        for (let i = cursor; i <= original.length; i++) if ((!eof || i + old.length === original.length) && old.every((line, j) => original[i + j] === line)) matches.push(i);
        const pos = !old.length ? original.length : matches.length === 1 ? matches[0] : -1;
        if (pos < 0) throw fail('Hunk context missing or ambiguous.');
        result.push(...original.slice(cursor, pos), ...replacement); cursor = pos + old.length;
      }
      result.push(...original.slice(cursor)); after = result.join('\n') + '\n';
    }
    changes.push({ name, target, before, after, action });
  }
  if (!changes.length) throw fail('Empty patch.');
  const applied = [];
  try {
    for (const change of changes) {
      applied.push(change);
      if (change.after !== null) await fs.writeText(change.target, change.after);
      if (change.after === null || change.target !== change.name) await fs.remove(change.name);
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      if (change.before === null || change.target !== change.name) await fs.remove(change.target).catch(() => {});
      if (change.before !== null) await fs.writeText(change.name, change.before);
    }
    throw error;
  }
  return { applied: changes.map(({ action, name, target }) => ({ action: action.toLowerCase(), path: name, ...(target !== name ? { moved_to: target } : {}) })), scope: fs.scope || 'scratch', source_evidence: false };
}
