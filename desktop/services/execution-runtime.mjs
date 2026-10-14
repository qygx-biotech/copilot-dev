import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seatbeltArgs } from './sandbox-policy.mjs';
const fail = code => Object.assign(new Error(code), { code });

// The execution runtime used by sandboxed project commands: CPython 3.12 with a
// fixed scientific package set, plus Node for code cells and file tools. It is
// built by desktop/scripts/build-execution-runtime.mjs, published as a release
// asset, and pinned here by version, size and SHA-256 in
// desktop/runtime/execution-runtime.json. The app downloads it once, verifies it,
// and unpacks it under its data folder; nothing else is fetched or executed.
const MANIFEST = fileURLToPath(new URL('../runtime/execution-runtime.json', import.meta.url));
const MARKER = '.biodesign-runtime.json';
const HEX = /^[0-9a-f]{64}$/;
// The first load of each freshly unpacked native module is slow on macOS (code
// validation), and Matplotlib builds its font cache. Importing these once at
// install time moves that cost (tens of seconds) out of the first analysis.
const WARM_UP = `import importlib
for name in ['numpy', 'pandas', 'scipy.stats', 'scipy.optimize', 'scipy.signal', 'scipy.interpolate', 'scipy.integrate', 'scipy.linalg',
             'scipy.ndimage', 'scipy.spatial', 'scipy.fft', 'matplotlib.pyplot', 'matplotlib.font_manager', 'openpyxl', 'PIL.Image']:
    try: importlib.import_module(name)
    except Exception: pass`;

export async function loadRuntimeManifest(file = MANIFEST) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };

export class ExecutionRuntime extends EventEmitter {
  constructor({ root, manifest, target = `${process.platform}-${process.arch}`, fetchImpl = fetch,
    tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar' }) {
    super();
    this.root = root; this.manifest = manifest; this.target = target; this.fetch = fetchImpl; this.tar = tar;
    this.state = this.asset() ? 'not_installed' : 'unsupported';
    this.progress = { receivedBytes: 0, totalBytes: this.asset()?.size || 0 };
    this.installed = null; this.installing = null; this.controller = new AbortController(); this.error = null;
  }
  // The pinned archive for this platform, or null when none is published.
  asset() {
    const manifest = this.manifest, asset = manifest?.assets?.[this.target];
    if (manifest?.version !== 1 || typeof manifest.runtimeVersion !== 'string' || !/^[0-9A-Za-z.-]{1,40}$/.test(manifest.runtimeVersion) || !asset) return null;
    let url;
    try { url = new URL(`${manifest.baseUrl}/${asset.file}`); } catch { return null; }
    if (url.protocol !== 'https:' || !/^[\w.+-]{1,200}\.tar\.gz$/.test(asset.file) || !HEX.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0) return null;
    return { ...asset, url: url.href };
  }
  directory() { return path.join(this.root, `${this.manifest.runtimeVersion}-${this.asset().sha256.slice(0, 16)}`); }

  // A finished install: the marker matches the pinned archive and both executables exist.
  async load() {
    if (this.installed) return this.installed;
    if (!this.asset()) return null;
    try {
      // Canonical paths: the sandbox matches the kernel's resolved paths.
      const directory = await realpath(this.directory());
      const marker = JSON.parse(await readFile(path.join(directory, MARKER), 'utf8'));
      if (marker.sha256 !== this.asset().sha256) return null;
      const info = JSON.parse(await readFile(path.join(directory, 'BIODESIGN_RUNTIME.json'), 'utf8'));
      const python = path.join(directory, info.python.executable), node = path.join(directory, info.node.executable);
      for (const file of [python, node]) if (!inside(directory, file) || !(await lstat(file)).isFile() && !(await lstat(file)).isSymbolicLink()) return null;
      this.installed = { root: directory, python, node, pythonBin: path.dirname(python), nodeBin: path.dirname(node),
        pythonVersion: info.python.version, nodeVersion: info.node.version, runtimeVersion: info.runtimeVersion };
      this.state = 'ready';
      return this.installed;
    } catch { return null; }
  }
  // Synchronous view for process launches: the installed paths, or null.
  current() { return this.installed; }

  async status() {
    await this.load();
    return { state: this.state, ...(this.asset() ? { version: this.manifest.runtimeVersion, downloadBytes: this.asset().size } : {}),
      ...(this.state === 'installing' ? { phase: this.phase, receivedBytes: this.progress.receivedBytes } : {}),
      ...(this.state === 'failed' ? { error: this.error } : {}),
      ...(this.installed ? { python: this.installed.pythonVersion, node: this.installed.nodeVersion } : {}) };
  }

  // One install at a time. A waiter's signal ends only its wait; the download
  // continues for other turns and stops only when the runtime is closed.
  ensure({ signal } = {}) {
    if (!this.asset()) return Promise.reject(fail('RUNTIME_UNSUPPORTED'));
    this.installing ||= this.install().finally(() => { this.installing = null; });
    if (!signal) return this.installing;
    return new Promise((resolve, reject) => {
      const abort = () => reject(fail('OPERATION_ABORTED'));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      this.installing.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  async install() {
    if (await this.load()) return this.installed;
    const asset = this.asset(), downloads = path.join(this.root, '.downloads'), file = path.join(downloads, `${asset.sha256}.partial`);
    const staging = path.join(this.root, `.staging-${randomUUID()}`);
    this.state = 'installing'; this.phase = 'download'; this.error = null; this.progress = { receivedBytes: 0, totalBytes: asset.size };
    this.emit('progress', { ...this.progress });
    try {
      await mkdir(downloads, { recursive: true });
      await rm(file, { force: true });
      await this.download(asset, file);
      this.phase = 'unpack';
      await mkdir(staging);
      await this.extract(file, staging);
      // The archive describes itself; it must be the runtime this app pinned.
      const info = JSON.parse(await readFile(path.join(staging, 'BIODESIGN_RUNTIME.json'), 'utf8'));
      if (info.version !== 1 || info.runtimeVersion !== this.manifest.runtimeVersion || info.target !== this.target) throw fail('RUNTIME_ARCHIVE_INVALID');
      for (const executable of [info.python?.executable, info.node?.executable]) {
        const resolved = path.join(staging, String(executable));
        if (typeof executable !== 'string' || !inside(staging, resolved) || !inside(await realpath(staging), await realpath(resolved))) throw fail('RUNTIME_ARCHIVE_INVALID');
      }
      await writeFile(path.join(staging, MARKER), JSON.stringify({ sha256: asset.sha256, runtimeVersion: this.manifest.runtimeVersion, target: this.target }));
      await rm(this.directory(), { recursive: true, force: true });
      await rename(staging, this.directory());
      await this.removeOtherVersions();
      if (!(await this.load())) throw fail('RUNTIME_ARCHIVE_INVALID');
      // Reported as installing until the one-time warm-up has run.
      this.state = 'installing'; this.phase = 'prepare';
      await this.warm();
      this.state = 'ready'; this.phase = null;
      this.emit('ready', { ...this.installed });
      return this.installed;
    } catch (error) {
      this.state = 'failed'; this.error = this.controller.signal.aborted ? 'OPERATION_ABORTED' : /^[A-Z_]{3,60}$/.test(error.code || '') && !/^E[A-Z]+$/.test(error.code) ? error.code : 'RUNTIME_INSTALL_FAILED';
      throw fail(this.error);
    } finally {
      await rm(file, { force: true }).catch(() => {});
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Streams to disk while hashing; more bytes than pinned, fewer, or another
  // hash discard the file.
  async download(asset, file) {
    let response;
    try { response = await this.fetch(asset.url, { redirect: 'follow', signal: this.controller.signal }); }
    catch (error) { throw this.controller.signal.aborted ? fail('OPERATION_ABORTED') : fail('RUNTIME_DOWNLOAD_FAILED'); }
    if (!response.ok || !response.body) throw fail('RUNTIME_DOWNLOAD_FAILED');
    if (response.url && new URL(response.url).protocol !== 'https:') throw fail('RUNTIME_DOWNLOAD_FAILED');
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > 0 && declared !== asset.size) throw fail('RUNTIME_DOWNLOAD_INVALID');
    const hash = createHash('sha256'), handle = await open(file, 'wx', 0o600), reader = response.body.getReader();
    let received = 0, reported = 0;
    try {
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch { throw this.controller.signal.aborted ? fail('OPERATION_ABORTED') : fail('RUNTIME_DOWNLOAD_FAILED'); }
        if (chunk.done) break;
        received += chunk.value.length;
        if (received > asset.size) throw fail('RUNTIME_DOWNLOAD_INVALID');
        hash.update(chunk.value); await handle.write(chunk.value);
        if (received - reported >= 1024 * 1024 || received === asset.size) { reported = received; this.progress.receivedBytes = received; this.emit('progress', { ...this.progress }); }
      }
      await handle.sync();
    } finally { await handle.close(); await reader.cancel().catch(() => {}); }
    if (received !== asset.size || hash.digest('hex') !== asset.sha256) throw fail('RUNTIME_DOWNLOAD_INVALID');
  }

  // bsdtar refuses absolute paths and ".." entries unless asked (-P); the
  // archive's content is already authenticated by its pinned hash.
  extract(file, directory) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.tar, ['-xzf', file, '-C', directory], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      const abort = () => child.kill('SIGKILL');
      this.controller.signal.addEventListener('abort', abort, { once: true });
      child.stderr.resume();
      child.on('error', () => reject(fail('RUNTIME_EXTRACT_FAILED')));
      child.on('close', code => {
        this.controller.signal.removeEventListener('abort', abort);
        code === 0 && !this.controller.signal.aborted ? resolve() : reject(fail(this.controller.signal.aborted ? 'OPERATION_ABORTED' : 'RUNTIME_EXTRACT_FAILED'));
      });
    });
  }

  // Matplotlib's font cache records absolute paths, so it is built once at the
  // installed location, sandboxed: read the runtime, write only the cache.
  // Project sessions copy it (see matplotlibCache); without it each turn would
  // spend tens of seconds rebuilding it.
  async warm() {
    const installed = this.installed, cache = this.matplotlibCache();
    await mkdir(cache, { recursive: true });
    const env = { HOME: cache, TMPDIR: cache, MPLCONFIGDIR: cache, MPLBACKEND: 'Agg', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', LANG: 'en_US.UTF-8' };
    const [command, args] = process.platform === 'darwin'
      ? ['/usr/bin/sandbox-exec', seatbeltArgs({ read: [installed.root], write: [await realpath(cache)] }, installed.python, ['-I', '-c', WARM_UP])]
      : [installed.python, ['-I', '-c', WARM_UP]];
    await new Promise(resolve => {
      const child = spawn(command, args, { cwd: cache, env, stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
      const abort = () => child.kill('SIGKILL');
      this.controller.signal.addEventListener('abort', abort, { once: true });
      // A runtime without the cache still works; turns then build their own.
      child.on('error', resolve);
      child.on('close', () => { clearTimeout(timer); this.controller.signal.removeEventListener('abort', abort); resolve(); });
    });
  }
  matplotlibCache() { return path.join(this.installed.root, '.cache', 'matplotlib'); }

  async removeOtherVersions() {
    const keep = path.basename(this.directory());
    for (const name of await readdir(this.root)) {
      if (name === keep || name === '.downloads') continue;
      await rm(path.join(this.root, name), { recursive: true, force: true });
    }
  }

  async close() {
    this.controller.abort();
    await this.installing?.catch(() => {});
  }
}
