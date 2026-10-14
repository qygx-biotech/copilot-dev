import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
const fail = code => Object.assign(new Error(code), { code });

// macOS seatbelt profiles built from a policy object. Paths travel as `-D`
// parameters and are referenced with (param ...), never interpolated into the
// profile text. Every path must already be canonical (fs/promises realpath),
// because seatbelt matches the kernel's resolved path, including its case.
// Reference: codex-rs/sandboxing/src/seatbelt.rs and seatbelt_base_policy.sbpl.

// System locations a shell, coreutils, Python or Node needs to start and run.
const SYSTEM_READ = ['/System', '/usr/lib', '/usr/share', '/usr/libexec', '/bin', '/sbin', '/usr/bin', '/usr/sbin',
  '/Library/Apple', '/private/etc', '/private/var/db/dyld', '/private/var/db/timezone'];
const DEVICES = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom'];

function checkedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\n\r]/.test(value) || path.normalize(value) !== value || (value.length > 1 && value.endsWith('/'))) throw fail('INVALID_SANDBOX_PATH');
  return value;
}

// policy: { read: [path], write: [path], protect: [path], reopen: [path], hidden: [path], anchors: [path], fork }
// - read: readable subpaths (besides the system locations above).
// - write: readable and writable subpaths.
// - protect: readable but not writable, even inside a write root.
// - reopen: writable again inside a protected path.
// - hidden: neither readable nor writable, even inside a read or write root.
// - anchors: directories that cannot be unlinked or renamed, so a writable
//   root cannot be swapped for a symlink between calls.
export function seatbeltProfile({ read = [], write = [], protect = [], reopen = [], hidden = [], anchors = [], fork = false }) {
  const params = [];
  const param = (prefix, value) => { const key = `${prefix}_${params.length}`; params.push([key, checkedPath(value)]); return `(param "${key}")`; };
  const hiddenParams = hidden.map(value => param('HIDDEN', value));
  // Allows carry require-not filters for hidden paths. A later deny alone is
  // not enough: a wildcard file-read* deny does not override the metadata allow.
  const exclusions = hiddenParams.map(key => `(require-not (literal ${key})) (require-not (subpath ${key}))`).join(' ');
  const visible = filter => hiddenParams.length ? `(require-all ${filter} ${exclusions})` : filter;
  const readFilters = read.map(value => visible(`(subpath ${param('READ', value)})`));
  const writeFilters = write.map(value => visible(`(subpath ${param('WRITE', value)})`));
  const anchorParams = anchors.map(value => param('ANCHOR', value));
  const protectParams = protect.map(value => param('PROTECT', value));
  const reopenFilters = reopen.map(value => visible(`(subpath ${param('REOPEN', value)})`));
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    ...(fork ? ['(allow process-fork)'] : []),
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    // Python multiprocessing uses POSIX semaphores; user lookups use libinfo.
    '(allow ipc-posix-sem)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    hiddenParams.length ? `(allow file-read-metadata (require-all ${exclusions}))` : '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${SYSTEM_READ.map(value => `(subpath "${value}")`).join(' ')} ${DEVICES.map(value => `(literal "${value}")`).join(' ')} (subpath "/dev/fd") ${[...readFilters, ...writeFilters].join(' ')})`,
    `(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (subpath "/dev/fd"))`,
    ...(writeFilters.length ? [`(allow file-write* ${writeFilters.join(' ')})`] : []),
    // Later rules take precedence. Protected paths are denied, then reopened
    // ones allowed again; anchors cannot be removed even though they sit inside
    // a writable root; hidden paths are denied again explicitly.
    ...(protectParams.length ? [`(deny file-write* ${protectParams.map(key => `(literal ${key}) (subpath ${key})`).join(' ')})`] : []),
    ...(reopenFilters.length ? [`(allow file-write* ${reopenFilters.join(' ')})`] : []),
    ...anchorParams.map(key => `(deny file-write-unlink (require-all (literal ${key}) (vnode-type DIRECTORY)))`),
    ...(hiddenParams.length ? [`(deny file-read* file-read-metadata file-write* ${hiddenParams.map(key => `(literal ${key}) (subpath ${key})`).join(' ')})`] : []),
  ].join('\n');
  return { profile, params };
}

// Arguments for /usr/bin/sandbox-exec, followed by the command and its arguments.
export function seatbeltArgs(policy, command, args = []) {
  const { profile, params } = seatbeltProfile(policy);
  return [...params.flatMap(([key, value]) => ['-D', `${key}=${value}`]), '-p', profile, command, ...args];
}

// Locations an executable outside the system folders needs (its own file, its
// app bundle, or a Homebrew keg and the libraries it links).
export function executableReadRoots(executable) {
  checkedPath(executable);
  const roots = [executable];
  if (executable.includes('.app/')) roots.push(executable.split('.app/')[0] + '.app');
  for (const prefix of ['/opt/homebrew', '/usr/local']) {
    if (executable.startsWith(prefix + '/')) roots.push(`${prefix}/Cellar`, `${prefix}/opt`, `${prefix}/lib`);
  }
  return roots;
}

export const PROJECT_WRITABLE = 'output';
export const PROJECT_HIDDEN = '.biodesign';
// Agent Work task folders, output/agent-tasks/<task>/: a conversation running
// alongside others writes only its own (docs/codex-parity-features.md).
export const PROJECT_TASKS = 'agent-tasks';
export const TASK_FOLDER = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// A real directory at exactly this canonical path, created when missing.
async function realDirectory(directory) {
  await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) throw fail('INVALID_OUTPUT_DIRECTORY');
  return directory;
}

// Resolves the paths of a project-mode policy. The project root must be an
// existing directory; output/ and output/agent-tasks/ are created by the host
// when missing and must be real directories, never symlinks. A read-only
// policy (plan mode) neither creates nor needs them.
// - task: a conversation running alongside others writes only its own
//   output/agent-tasks/<task>/ (output).
// - Otherwise the turn writes output/ except output/agent-tasks/ (tasks),
//   which stays read-only from its first process on, so no command it starts
//   can ever write another task's folder; its own conversation's folder (own,
//   from ownTask) stays writable.
export async function projectPaths(root, { readOnly = false, task = null, ownTask = null } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw fail('INVALID_PROJECT_ROOT');
  for (const name of [task, ownTask]) if (name !== null && (readOnly || typeof name !== 'string' || !TASK_FOLDER.test(name))) throw fail('INVALID_TASK_FOLDER');
  if (task && ownTask) throw fail('INVALID_TASK_FOLDER');
  const project = await realpath(root);
  if (!(await lstat(project)).isDirectory()) throw fail('INVALID_PROJECT_ROOT');
  if (readOnly) return { project, output: null, outputRoot: null, tasks: null, own: null, hidden: await metadataPath(project) };
  const outputRoot = await realDirectory(path.join(project, PROJECT_WRITABLE));
  const tasks = await realDirectory(path.join(outputRoot, PROJECT_TASKS));
  const output = task ? await realDirectory(path.join(tasks, task)) : outputRoot;
  // The own folder is created by the turn only if it writes there.
  const own = ownTask ? path.join(tasks, ownTask) : null;
  if (own && await lstat(own).then(info => info.isSymbolicLink() || !info.isDirectory(), error => { if (error.code === 'ENOENT') return false; throw error; })) throw fail('INVALID_OUTPUT_DIRECTORY');
  return { project, output, outputRoot, tasks, own, hidden: await metadataPath(project) };
}

// The metadata folder's canonical name, if it exists under another case.
async function metadataPath(project) {
  const hidden = await realpath(path.join(project, PROJECT_HIDDEN)).catch(error => {
    if (error.code === 'ENOENT') return path.join(project, PROJECT_HIDDEN);
    throw error;
  });
  if (path.dirname(hidden) !== project) throw fail('INVALID_PROJECT_METADATA');
  return hidden;
}

// The project-mode policy: read the project without its metadata folder, write
// only output/ (or the task's folder in it) and the turn's private folder,
// start child processes, no network. runtimes are installed execution runtimes
// (read-only to the sandbox). Without an output folder (plan mode) only the
// private folder is writable. A turn writing output/ cannot write
// output/agent-tasks/ except its own conversation's folder.
export function projectPolicy({ project, output, outputRoot = output, tasks = null, own = null, hidden, privateRoot, executables = [], runtimes = [] }) {
  const whole = Boolean(output) && output === outputRoot;
  return {
    read: [project, ...executables.flatMap(executableReadRoots), ...runtimes],
    write: output ? [output, privateRoot] : [privateRoot],
    protect: whole && tasks ? [tasks] : [],
    reopen: whole && tasks && own ? [own] : [],
    hidden: [hidden],
    anchors: output ? [...new Set([outputRoot, ...(tasks ? [tasks] : []), output, ...(whole && own ? [own] : [])])] : [],
    fork: true,
  };
}
