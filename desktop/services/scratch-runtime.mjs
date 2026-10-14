import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validatePng } from './runtime-image.mjs';
import { seatbeltArgs, projectPaths, projectPolicy, PROJECT_WRITABLE, PROJECT_HIDDEN, PROJECT_TASKS } from './sandbox-policy.mjs';
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
  // runtime: the downloaded execution runtime (desktop/services/execution-runtime.mjs);
  // its Node runs cells and file tools, and its Python is on PATH in project mode.
  constructor({ platform = process.platform, executable = process.env.BIODESIGN_SANDBOX_NODE || (process.versions.electron ? ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(existsSync) : process.execPath), preview, runtime = null } = {}) {
    this.platform = platform; this.executable = executable; this.preview = preview; this.runtime = runtime; this.sessions = new Map(); this.openings = new Map(); this.closed = false;
    this.probes = new Map();
  }
  // Probed per Node executable, so scratch becomes available once the runtime is installed.
  async available() {
    if (this.platform !== 'darwin') return false;
    const executable = await this.nodeExecutable().catch(() => null);
    if (!executable) return false;
    // Probe the actual runtime under the same policy used by tool calls.
    if (!this.probes.has(executable)) this.probes.set(executable, (async () => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'biodesign-sandbox-probe-')));
      try {
        const child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxProfile(root, executable), executable, '-e', 'process.stdout.write("ready")'],
          { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], env: { HOME: root, TMPDIR: root, OPENSSL_CONF: '/dev/null', ELECTRON_RUN_AS_NODE: '1' } });
        return await new Promise(resolve => {
          let output = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
          child.stdout.on('data', bytes => { output += bytes.toString(); });
          child.on('error', () => { clearTimeout(timer); resolve(false); });
          child.on('close', code => { clearTimeout(timer); resolve(code === 0 && output === 'ready'); });
        });
      } finally { await rm(root, { recursive: true, force: true }); }
    })().catch(() => false));
    return this.probes.get(executable);
  }
  async open(owner) {
    if (this.closed) throw fail('RUNTIME_CLOSED');
    if (this.openings.has(owner)) return this.openings.get(owner);
    const opening = (async () => {
      if (!(await this.available())) throw fail('SANDBOX_UNAVAILABLE');
      if (this.closed) throw fail('RUNTIME_CLOSED');
      if (this.sessions.has(owner)) { if (this.sessions.get(owner).mode !== 'scratch') throw fail('RUNTIME_OWNER_CONFLICT'); return; }
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
        this.sessions.set(owner, { mode: 'scratch', root, privateRoot: root, fs, processes: new Map(), cells: new Map(), fileWorkers: new Set(), queue: Promise.resolve(), controller: new AbortController(), closed: false });
      } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
    })();
    this.openings.set(owner, opening);
    try { return await opening; } finally { this.openings.delete(owner); }
  }
  // Probes /bin/sh under a project policy on a temporary project. Project mode
  // needs no Node executable for commands; file tools and cells still do.
  async projectAvailable() {
    if (this.platform !== 'darwin') return false;
    if (!this.projectProbe) this.projectProbe = (async () => {
      const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'biodesign-project-probe-')));
      try {
        const project = path.join(base, 'project'), privateRoot = path.join(base, 'private');
        await Promise.all([mkdir(project), mkdir(privateRoot)]);
        const policy = projectPolicy({ ...await projectPaths(project), privateRoot });
        const child = spawn('/usr/bin/sandbox-exec', seatbeltArgs(policy, '/bin/sh', ['-c', 'printf ready > output/probe && /bin/cat output/probe']),
          { cwd: project, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: privateRoot, TMPDIR: privateRoot } });
        return await new Promise(resolve => {
          let output = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
          child.stdout.on('data', bytes => { output += bytes.toString(); });
          child.on('error', () => { clearTimeout(timer); resolve(false); });
          child.on('close', code => { clearTimeout(timer); resolve(code === 0 && output === 'ready'); });
        });
      } finally { await rm(base, { recursive: true, force: true }); }
    })().catch(() => false);
    return this.projectProbe;
  }
  // Project mode: the project root is the working directory, readable except
  // .biodesign/; only output/ and a private HOME/TMPDIR folder are writable;
  // child processes are allowed; no network. Closing the owner removes only the
  // private folder, never project files.
  // readOnly (plan mode): nothing in the project is writable, output/ included.
  // task: a parallel Agent Work task writes only output/agent-tasks/<task>/.
  // Otherwise output/agent-tasks/ is read-only except ownTask's folder.
  async openProject(owner, { root, readOnly = false, task = null, ownTask = null }) {
    if (this.closed) throw fail('RUNTIME_CLOSED');
    if (this.openings.has(owner)) return this.openings.get(owner);
    const opening = (async () => {
      if (!(await this.projectAvailable())) throw fail('SANDBOX_UNAVAILABLE');
      if (this.closed) throw fail('RUNTIME_CLOSED');
      const paths = await projectPaths(root, { readOnly, task, ownTask });
      const existing = this.sessions.get(owner);
      if (existing) { if (existing.mode !== 'project' || existing.paths.project !== paths.project || existing.readOnly !== readOnly || existing.task !== task || existing.ownTask !== ownTask) throw fail('RUNTIME_OWNER_CONFLICT'); return; }
      const privateRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'biodesign-project-')));
      try {
        if (this.closed) throw fail('RUNTIME_CLOSED');
        const fs = {
          readBinary: async path => Buffer.from((await this.fileOperation(owner, 'read', { path })).data, 'base64'),
          readText: async path => (await fs.readBinary(path)).toString('utf8'),
          writeBinary: (path, bytes) => this.fileOperation(owner, 'write', { path, data: Buffer.from(bytes).toString('base64') }),
          writeText: (path, text) => fs.writeBinary(path, Buffer.from(text)),
          exists: path => this.fileOperation(owner, 'exists', { path }),
        };
        // Relative folders for the file worker and the turn's own reports.
        const tasks = `${PROJECT_WRITABLE}/${PROJECT_TASKS}`;
        const writable = readOnly ? null : task ? `${tasks}/${task}` : PROJECT_WRITABLE;
        const scope = readOnly || task ? { protected: [], reopened: [] } : { protected: [tasks], reopened: ownTask ? [`${tasks}/${ownTask}`] : [] };
        this.sessions.set(owner, { mode: 'project', readOnly, task, ownTask, writable, scope, root: paths.project, privateRoot, paths, fs, processes: new Map(), cells: new Map(), fileWorkers: new Set(), queue: Promise.resolve(), controller: new AbortController(), closed: false });
      } catch (error) { await rm(privateRoot, { recursive: true, force: true }); throw error; }
    })();
    this.openings.set(owner, opening);
    try { return await opening; } finally { this.openings.delete(owner); }
  }
  // sandbox-exec arguments and environment for one process of this session.
  async launch(s, command, args) {
    if (s.mode !== 'project') {
      const executable = await this.nodeExecutable();
      return { argv: ['-p', sandboxProfile(s.root, executable), command, ...args],
        env: { PATH: '/usr/bin:/bin', HOME: s.root, TMPDIR: s.root, ELECTRON_RUN_AS_NODE: '1', OPENSSL_CONF: '/dev/null' } };
    }
    const node = await this.nodeExecutable().catch(() => null), installed = this.runtime?.current();
    // Each session starts from the runtime's prebuilt Matplotlib font cache.
    if (installed && !s.matplotlibSeeded) {
      s.matplotlibSeeded = true;
      await cp(path.join(installed.root, '.cache', 'matplotlib'), path.join(s.privateRoot, 'matplotlib'), { recursive: true }).catch(() => {});
    }
    return { argv: seatbeltArgs(projectPolicy({ ...s.paths, privateRoot: s.privateRoot, executables: node && !installed ? [node] : [], runtimes: installed ? [installed.root] : [] }), command, args),
      // Rebuilt from an allowlist: nothing from the app's environment is inherited.
      env: { PATH: [...(installed ? [installed.pythonBin, installed.nodeBin] : []), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
        HOME: s.privateRoot, TMPDIR: s.privateRoot, LANG: 'en_US.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', MPLBACKEND: 'Agg', MPLCONFIGDIR: path.join(s.privateRoot, 'matplotlib'),
        ELECTRON_RUN_AS_NODE: '1', OPENSSL_CONF: '/dev/null' } };
  }
  // Project processes run in their own process group, so background jobs and
  // descendants end with the command, its cancellation or its timeout.
  // After the command exits the group is released, so a later terminate can
  // never signal a reused process-group ID.
  kill(p) {
    if (p.group && !p.groupReleased) { try { process.kill(-p.child.pid, 'SIGKILL'); } catch { /* The group has already exited. */ } }
    p.child.kill('SIGKILL');
  }
  // Code cells and file tools run on Node inside the sandbox: the execution
  // runtime's when installed, otherwise a configured system Node.
  async nodeExecutable() {
    const installed = this.runtime?.current() || await this.runtime?.load?.();
    if (installed?.node) return installed.node;
    if (this.executable) return realpath(this.executable).catch(() => { throw fail('CODE_RUNTIME_UNAVAILABLE'); });
    throw fail(this.runtime?.state === 'installing' ? 'RUNTIME_PREPARING' : 'CODE_RUNTIME_UNAVAILABLE');
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
    const [worker, patch, executable] = await Promise.all([readFile(fileRunner, 'utf8'), readFile(patchRunner, 'utf8'), this.nodeExecutable()]);
    if (s.closed || this.closed) throw fail('RUNTIME_OWNER_EXPIRED');
    const source = `${worker}\n${patch.replace('export async function applyPatch', 'async function applyPatch')}\nrunFileWorker(applyPatch);`;
    const { argv } = await this.launch(s, executable, ['--max-old-space-size=128', '-e', source]);
    const child = spawn('/usr/bin/sandbox-exec', argv, {
      cwd: s.root, env: { HOME: s.privateRoot, TMPDIR: s.privateRoot, OPENSSL_CONF: '/dev/null', ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
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
        else child.stdin.end(JSON.stringify({ operation, args, ...(s.mode === 'project' ? { scope: { writable: s.writable, hidden: PROJECT_HIDDEN, ...s.scope } } : {}) }));
      });
    } finally { s.fileWorkers.delete(child); }
  }
  start(owner, command, args, options = {}) {
    return this.withOwnerLock(owner, s => this.startLocked(s, owner, command, args, options));
  }
  async startLocked(s, owner, command, args, { kind = 'process', timeout_ms = 60000 } = {}) {
    const map = kind === 'cell' ? s.cells : s.processes;
    const { argv, env } = await this.launch(s, command, args);
    if (s.closed || this.closed) throw fail('RUNTIME_OWNER_EXPIRED');
    if ([...s.processes.values(), ...s.cells.values()].filter(p => !p.done).length >= 4 || map.size >= 64) throw fail('EXECUTION_LIMIT');
    const group = s.mode === 'project';
    const child = spawn('/usr/bin/sandbox-exec', argv, { cwd: s.root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: group });
    const id = `${kind}:${crypto.randomUUID()}`, p = { id, child, group, output: '', stderr: '', cursor: 0, stderrCursor: 0, done: false, calls: [], pending: new Map(), result: undefined, owner };
    map.set(id, p);
    // Background jobs end with the command that started them.
    if (group) child.on('exit', () => { this.kill(p); p.groupReleased = true; });
    child.stdin.on('error', error => { if (!p.done) { p.error = error.code || 'PROCESS_INPUT_FAILED'; this.kill(p); } });
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
      if (protocol.length > 262144) { p.error = 'OUTPUT_LIMIT'; this.kill(p); return; }
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
        } catch (error) { p.error = error.code || 'CELL_PROTOCOL'; this.kill(p); }
      }
    });
    child.stderr.on('data', bytes => retain('stderr', bytes, 16000));
    p.finished = new Promise(resolve => {
      const finish = code => { if (p.done) return; p.done = true; p.exit_code = code; clearTimeout(p.timer); resolve(); };
      child.on('error', error => { p.error = error.code || 'EXECUTION_FAILED'; finish(null); });
      child.on('close', (code, signal) => { if (signal && !p.error) p.error = `PROCESS_SIGNAL_${signal}`; finish(code); });
    });
    p.timer = setTimeout(() => { p.error = 'EXECUTION_TIMEOUT'; this.kill(p); }, Math.min(300000, Math.max(1, timeout_ms)));
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
      if (args.terminate) this.kill(p);
      else if (args.chars && !p.done) p.child.stdin.write(args.chars);
      if (args.close_stdin) p.child.stdin.end();
      return this.poll(p, args.yield_time_ms, args);
    }
    if (name === 'run_code') {
      const p = await this.start(owner, await this.nodeExecutable(), ['--max-old-space-size=128', '-e', await readFile(runner, 'utf8')], { ...args, kind: 'cell' });
      p.child.stdin.write(JSON.stringify({ code: args.code }) + '\n'); return this.poll(p, args.yield_time_ms);
    }
    if (name === 'wait_code') {
      const p = s.cells.get(args.cell_id); if (!p) throw fail('CELL_NOT_FOUND');
      if (args.output_cursor !== undefined) outputChunk(p.output, args.output_cursor, 2);
      if (args.stderr_cursor !== undefined) outputChunk(p.stderr, args.stderr_cursor, 2);
      if (args.terminate) this.kill(p);
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
    if (name === 'wait_for_environment') return s.mode === 'project'
      ? { status: 'ready', environment: 'project', network: false, project_access: 'read', writable: s.readOnly ? [] : [`${s.writable}/`, ...s.scope.reopened.map(folder => `${folder}/`)], ...(s.scope.protected.length ? { not_writable: s.scope.protected.map(folder => `${folder}/`) } : {}), hidden: [`${PROJECT_HIDDEN}/`], child_processes: true, ...(s.readOnly ? { read_only: true } : {}) }
      : { status: 'ready', environment: 'isolated_scratch', network: false, project_access: false, child_processes: false };
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
    for (const p of ps) if (!p.done) this.kill(p);
    // Only the session's private folder is removed; a project root never is.
    await Promise.all([...ps.map(p => p.finished), s.queue]); await rm(s.privateRoot, { recursive: true, force: true }); this.sessions.delete(owner);
  }
  async close() { this.closed = true; await Promise.all([...this.openings.values()].map(p => p.catch(() => {}))); await Promise.all([...this.sessions.keys()].map(owner => this.closeOwner(owner))); }
}
