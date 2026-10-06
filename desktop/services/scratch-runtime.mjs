import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validatePng } from './runtime-image.mjs';
const fail = code => Object.assign(new Error(code), { code });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const OUTPUT_LIMIT = 262144;
// Bound serialized text, including JSON escaping; offsets count UTF-16 code units.
// A cursor is never placed inside a Unicode surrogate pair.
export function outputChunk(text, start = 0, budget = 16000) {
  if (!Number.isSafeInteger(start) || start < 0 || start > text.length || start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1]) && /[\uDC00-\uDFFF]/.test(text[start] || '')) throw fail('INVALID_OUTPUT_CURSOR');
  let end = start, size = 2;
  for (const character of text.slice(start)) {
    const cost = JSON.stringify(character).length - 2;
    if (size + cost > budget) break;
    size += cost; end += character.length;
  }
  return { text: text.slice(start, end), end };
}
const runner = fileURLToPath(new URL('../workers/code-cell.cjs', import.meta.url));
const fileRunner = new URL('../workers/scratch-files.cjs', import.meta.url);
const patchRunner = new URL('./scratch-patch.mjs', import.meta.url);
const quote = value => JSON.stringify(value);
// Deny by default. Neither project data, credentials, network, Mach IPC nor
// browser profiles are ambient resources. No child forks: one handle owns one
// OS process, so cancellation cannot leave detached descendants behind.
export function sandboxProfile(root, executable, worker = runner) {
  return `(version 1)(deny default)
(allow process-exec)(allow signal (target self))(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/bin") (subpath "/usr/bin") (subpath "/Library/Apple") (subpath "/private/var/db/dyld") (subpath "/dev/fd")
 (subpath "/opt/homebrew/Cellar") (subpath "/opt/homebrew/opt") (literal ${quote(executable)}) ${executable.includes(".app/") ? `(subpath ${quote(executable.split(".app/")[0] + ".app")})` : ""} (literal ${quote(worker)}) (subpath ${quote(root)}))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (subpath ${quote(root)}))`;
}
export class ScratchRuntime {
  constructor({ platform = process.platform, executable = process.env.BIODESIGN_SANDBOX_NODE || (process.versions.electron ? ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(existsSync) : process.execPath), preview } = {}) {
    this.platform = platform; this.executable = executable; this.preview = preview; this.sessions = new Map(); this.openings = new Map(); this.closed = false;
  }
  async available() {
    if (this.platform !== 'darwin' || !this.executable) return false;
    // Probe the actual runtime under the same policy used by tool calls.
    if (!this.probe) this.probe = (async () => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'biodesign-sandbox-probe-')));
      try {
        const executable = await realpath(this.executable);
        const child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxProfile(root, executable), executable, '-e', 'process.stdout.write("ready")'],
          { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], env: { HOME: root, TMPDIR: root, OPENSSL_CONF: '/dev/null', ELECTRON_RUN_AS_NODE: '1' } });
        return await new Promise(resolve => {
          let output = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
          child.stdout.on('data', bytes => { output += bytes.toString(); });
          child.on('error', () => { clearTimeout(timer); resolve(false); });
          child.on('close', code => { clearTimeout(timer); resolve(code === 0 && output === 'ready'); });
        });
      } finally { await rm(root, { recursive: true, force: true }); }
    })().catch(() => false);
    return this.probe;
  }
  async open(owner) {
    if (this.closed) throw fail('RUNTIME_CLOSED');
    if (this.openings.has(owner)) return this.openings.get(owner);
    const opening = (async () => {
      if (!(await this.available())) throw fail('SANDBOX_UNAVAILABLE');
      if (this.closed) throw fail('RUNTIME_CLOSED');
      if (this.sessions.has(owner)) return;
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'biodesign-scratch-')));
      try {
        if (this.closed) throw fail('RUNTIME_CLOSED');
        // No privileged ProjectFilesystem points into model-writable scratch.
        const fs = {
          readBinary: async path => Buffer.from((await this.fileOperation(owner, 'read', { path })).data, 'base64'),
          readText: async path => (await fs.readBinary(path)).toString('utf8'),
          writeBinary: (path, bytes) => this.fileOperation(owner, 'write', { path, data: Buffer.from(bytes).toString('base64') }),
          writeText: (path, text) => fs.writeBinary(path, Buffer.from(text)),
          exists: path => this.fileOperation(owner, 'exists', { path }),
        };
        this.sessions.set(owner, { root, fs, processes: new Map(), cells: new Map(), fileWorkers: new Set(), queue: Promise.resolve(), controller: new AbortController(), closed: false });
      } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
    })();
    this.openings.set(owner, opening);
    try { return await opening; } finally { this.openings.delete(owner); }
  }
  session(owner) { const s = this.sessions.get(owner); if (!s || s.closed) throw fail('RUNTIME_OWNER_EXPIRED'); return s; }
  withOwnerLock(owner, action) {
    const s = this.session(owner);
    const pending = s.queue.then(() => {
      if (this.closed || s.closed || this.sessions.get(owner) !== s) throw fail('RUNTIME_OWNER_EXPIRED');
      return action(s);
    });
    s.queue = pending.catch(() => {});
    return pending;
  }
  withFiles(owner, action) {
    return this.withOwnerLock(owner, async s => {
      // Never wait for a live cell: it might be waiting for a nested tool reply.
      if ([...s.processes.values(), ...s.cells.values()].some(p => !p.done)) throw fail('SCRATCH_BUSY');
      const files = {
        writeBinary: (path, bytes) => this.fileWorker(s, 'write', { path, data: Buffer.from(bytes).toString('base64') }),
      };
      return action(files, s.controller.signal, s);
    });
  }
  fileOperation(owner, operation, args) {
    return this.withFiles(owner, (_files, _signal, s) => this.fileWorker(s, operation, args));
  }
  async fileWorker(s, operation, args) {
    // Source is host-owned, including inside packaged ASARs. Only JSON data is
    // sent to stdin; neither user paths nor patches are interpolated into code.
    const [worker, patch, executable] = await Promise.all([readFile(fileRunner, 'utf8'), readFile(patchRunner, 'utf8'), realpath(this.executable)]);
    if (s.closed || this.closed) throw fail('RUNTIME_OWNER_EXPIRED');
    const source = `${worker}\n${patch.replace('export async function applyPatch', 'async function applyPatch')}\nrunFileWorker(applyPatch);`;
    const child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxProfile(s.root, executable), executable, '--max-old-space-size=128', '-e', source], {
      cwd: s.root, env: { HOME: s.root, TMPDIR: s.root, OPENSSL_CONF: '/dev/null', ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    s.fileWorkers.add(child);
    try {
      return await new Promise((resolve, reject) => {
        let output = '', error;
        const stop = code => { error ||= fail(code); child.kill('SIGKILL'); };
        const abort = () => stop('OPERATION_ABORTED');
        const timer = setTimeout(() => stop('SCRATCH_FILE_TIMEOUT'), 30000);
        s.controller.signal.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', bytes => { output += bytes; if (output.length > 15 * 1024 * 1024) stop('FILE_TOO_LARGE'); });
        child.stderr.resume();
        child.stdin.on('error', () => stop('SCRATCH_FILE_FAILED'));
        child.on('error', () => { error ||= fail('SCRATCH_FILE_FAILED'); });
        child.on('close', code => {
          clearTimeout(timer); s.controller.signal.removeEventListener('abort', abort);
          if (error) return reject(error);
          try { const result = JSON.parse(output); if (code !== 0 || !result.ok) throw fail(result.error || 'SCRATCH_FILE_FAILED'); resolve(result.value); }
          catch (e) { reject(e.code ? e : fail('SCRATCH_FILE_FAILED')); }
        });
        if (s.controller.signal.aborted) abort();
        else child.stdin.end(JSON.stringify({ operation, args }));
      });
    } finally { s.fileWorkers.delete(child); }
  }
  start(owner, command, args, options = {}) {
    return this.withOwnerLock(owner, s => this.startLocked(s, owner, command, args, options));
  }
  async startLocked(s, owner, command, args, { kind = 'process', timeout_ms = 60000 } = {}) {
    const map = kind === 'cell' ? s.cells : s.processes;
    const executable = await realpath(this.executable);
    if (s.closed || this.closed) throw fail('RUNTIME_OWNER_EXPIRED');
    if ([...s.processes.values(), ...s.cells.values()].filter(p => !p.done).length >= 4 || map.size >= 64) throw fail('EXECUTION_LIMIT');
    const child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxProfile(s.root, executable), command, ...args], {
      cwd: s.root, env: { PATH: '/usr/bin:/bin', HOME: s.root, TMPDIR: s.root, ELECTRON_RUN_AS_NODE: '1', OPENSSL_CONF: '/dev/null' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const id = `${kind}:${crypto.randomUUID()}`, p = { id, child, output: '', stderr: '', cursor: 0, stderrCursor: 0, done: false, calls: [], pending: new Map(), result: undefined, owner };
    map.set(id, p);
    child.stdin.on('error', error => { if (!p.done) { p.error = error.code || 'PROCESS_INPUT_FAILED'; child.kill('SIGKILL'); } });
    let protocol = '';
    const retain = (key, text, limit) => {
      if (p[`${key}_truncated`]) return;
      const combined = p[key] + text;
      let end = Math.min(combined.length, limit);
      if (end < combined.length && /[\uD800-\uDBFF]/.test(combined[end - 1] || '') && /[\uDC00-\uDFFF]/.test(combined[end] || '')) end--;
      if (end < combined.length) p[`${key}_truncated`] = true;
      p[key] = combined.slice(0, end);
    };
    const append = text => retain('output', text, OUTPUT_LIMIT);
    // Node's stream decoder retains incomplete UTF-8 sequences between chunks.
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', bytes => {
      if (kind === 'process') return append(bytes.toString());
      protocol += bytes.toString();
      if (protocol.length > 262144) { p.error = 'OUTPUT_LIMIT'; child.kill('SIGKILL'); return; }
      while (protocol.includes('\n')) {
        const i = protocol.indexOf('\n'), line = protocol.slice(0, i); protocol = protocol.slice(i + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'call') {
            if (p.pending.size >= 16 || p.calls.length >= 24 || typeof message.name !== 'string' || !message.args || typeof message.args !== 'object' || Array.isArray(message.args)) throw fail('CELL_TOOL_LIMIT');
            const call = { id: `${id}:${p.calls.length}`, name: message.name, args: message.args };
            if (JSON.stringify(call).length > 16000) throw fail('CELL_TOOL_LIMIT');
            if (p.pending.has(message.id)) throw fail('CELL_PROTOCOL');
            p.calls.push(call); p.pending.set(message.id, call);
          } else if (message.type === 'text') append((typeof message.value === 'string' ? message.value : JSON.stringify(message.value)) + '\n');
          else if (message.type === 'result') {
            const encoded = JSON.stringify(message.value);
            if (encoded?.length > 8000) {
              p.result_info = { value_delivery: 'output_json', value_output_start: p.output.length, value_characters: encoded.length };
              append(encoded);
            } else p.result = message.value;
          }
          else if (message.type === 'error') p.error = String(message.error).slice(0, 1000);
          else throw fail('CELL_PROTOCOL');
        } catch (error) { p.error = error.code || 'CELL_PROTOCOL'; child.kill('SIGKILL'); }
      }
    });
    child.stderr.on('data', bytes => retain('stderr', bytes, 16000));
    p.finished = new Promise(resolve => {
      const finish = code => { if (p.done) return; p.done = true; p.exit_code = code; clearTimeout(p.timer); resolve(); };
      child.on('error', error => { p.error = error.code || 'EXECUTION_FAILED'; finish(null); });
      child.on('close', (code, signal) => { if (signal && !p.error) p.error = `PROCESS_SIGNAL_${signal}`; finish(code); });
    });
    p.timer = setTimeout(() => { p.error = 'EXECUTION_TIMEOUT'; child.kill('SIGKILL'); }, Math.min(300000, Math.max(1, timeout_ms)));
    return p;
  }
  async poll(p, ms = 1000, cursors = {}) {
    const until = Date.now() + Math.min(10000, Math.max(0, ms));
    while (!p.done && !p.pending.size && Date.now() < until) await Promise.race([p.finished, delay(Math.min(20, until - Date.now()))]);
    const start = cursors.output_cursor ?? p.cursor, stderrStart = cursors.stderr_cursor ?? p.stderrCursor ?? 0;
    const output = outputChunk(p.output, start), stderr = outputChunk(p.stderr, stderrStart, 4000);
    p.cursor = output.end; p.stderrCursor = stderr.end;
    const calls = []; let callBytes = 0;
    for (const call of p.pending.values()) { const length = JSON.stringify(call).length; if (callBytes + length > 16000) break; calls.push(call); callBytes += length; }
    return { status: p.done ? p.error || p.exit_code ? 'failed' : 'completed' : 'running',
      ...(p.id.startsWith('cell:') ? { cell_id: p.id } : { process_id: p.id }), output: output.text, stderr: stderr.text,
      output_start: start, output_cursor: output.end, output_available: p.output.length, output_remaining: p.output.length - output.end,
      stderr_start: stderrStart, stderr_cursor: stderr.end, stderr_remaining: p.stderr.length - stderr.end,
      output_truncated: Boolean(p.output_truncated), stderr_truncated: Boolean(p.stderr_truncated),
      ...(p.done ? { exit_code: p.exit_code, ...(p.error ? { error: p.error } : {}), ...(p.result !== undefined ? { value: p.result } : {}), ...p.result_info } : {}),
      ...(!p.done && calls.length ? { tool_calls: calls } : {}) };
  }
  async call(owner, name, args) {
    const s = this.session(owner);
    if (name === 'exec_command') {
      const p = await this.start(owner, '/bin/sh', ['-c', args.cmd], args); return this.poll(p, args.yield_time_ms);
    }
    if (name === 'write_stdin') {
      const p = s.processes.get(args.process_id); if (!p) throw fail('PROCESS_NOT_FOUND');
      if (args.output_cursor !== undefined) outputChunk(p.output, args.output_cursor, 2);
      if (args.stderr_cursor !== undefined) outputChunk(p.stderr, args.stderr_cursor, 2);
      if (args.terminate) p.child.kill('SIGKILL');
      else if (args.chars && !p.done) p.child.stdin.write(args.chars);
      if (args.close_stdin) p.child.stdin.end();
      return this.poll(p, args.yield_time_ms, args);
    }
    if (name === 'run_code') {
      const p = await this.start(owner, await realpath(this.executable), ['--max-old-space-size=128', '-e', await readFile(runner, 'utf8')], { ...args, kind: 'cell' });
      p.child.stdin.write(JSON.stringify({ code: args.code }) + '\n'); return this.poll(p, args.yield_time_ms);
    }
    if (name === 'wait_code') {
      const p = s.cells.get(args.cell_id); if (!p) throw fail('CELL_NOT_FOUND');
      if (args.output_cursor !== undefined) outputChunk(p.output, args.output_cursor, 2);
      if (args.stderr_cursor !== undefined) outputChunk(p.stderr, args.stderr_cursor, 2);
      if (args.terminate) p.child.kill('SIGKILL');
      return this.poll(p, args.yield_time_ms, args);
    }
    if (name === 'apply_patch') {
      return this.fileOperation(owner, 'patch', { patch: args.patch });
    }
    if (name === 'view_image') {
      const bytes = Buffer.from(await s.fs.readBinary(args.path));
      const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' : null;
      if (!mime || bytes.length > 10 * 1024 * 1024) throw fail('INVALID_IMAGE');
      if (mime === 'image/png') validatePng(bytes);
      const content = this.preview ? this.preview(bytes) : bytes.length <= 24000 ? { type: 'image', mimeType: mime, data: bytes.toString('base64') } : null;
      if (!content) throw fail('IMAGE_DELIVERY_LIMIT');
      return { content: [content], path: args.path };
    }
    if (name === 'wait_for_environment') return { status: 'ready', environment: 'isolated_scratch', network: false, project_access: false, child_processes: false };
    throw fail('RUNTIME_TOOL_NOT_ALLOWED');
  }
  async reply(owner, cellId, results) {
    const p = this.session(owner).cells.get(cellId); if (!p || p.done) throw fail('CELL_NOT_FOUND');
    for (const result of results) {
      const found = [...p.pending].find(([, call]) => call.id === result.id); if (!found) throw fail('CELL_RECEIPT_MISMATCH');
      p.pending.delete(found[0]); p.child.stdin.write(JSON.stringify({ id: found[0], result: result.result }) + '\n');
    }
    return this.poll(p, 10);
  }
  async closeOwner(owner) {
    await this.openings.get(owner)?.catch(() => {});
    const s = this.sessions.get(owner); if (!s) return;
    s.closed = true;
    s.controller.abort();
    const ps = [...s.processes.values(), ...s.cells.values()];
    for (const p of ps) if (!p.done) p.child.kill('SIGKILL');
    await Promise.all([...ps.map(p => p.finished), s.queue]); await rm(s.root, { recursive: true, force: true }); this.sessions.delete(owner);
  }
  async close() { this.closed = true; await Promise.all([...this.openings.values()].map(p => p.catch(() => {}))); await Promise.all([...this.sessions.keys()].map(owner => this.closeOwner(owner))); }
}
