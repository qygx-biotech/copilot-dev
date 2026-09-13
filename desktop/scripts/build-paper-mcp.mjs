import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "desktop/paper-search");
export async function sourceDigest() {
  const hash = crypto.createHash("sha256");
  async function scan(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".venv", "__pycache__", "dist", "build", "tests"].includes(entry.name) || entry.name.endsWith(".spec")) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(filename);
      else { hash.update(path.relative(source, filename)); hash.update(await readFile(filename)); }
    }
  }
  await scan(source);
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  return hash.digest("hex");
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false, ...options });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
export async function buildPaperMcp(platform = process.platform, arch = process.arch) {
  const destination = path.join(source, "dist", `${platform}-${arch}`, "paper-search-server");
  const binary = path.join(destination, platform === "win32" ? "paper-search-server.exe" : "paper-search-server");
  const digest = await sourceDigest();
  try {
    const manifest = JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8"));
    if (manifest.sourceDigest === digest && manifest.platform === platform && manifest.arch === arch) {
      await access(binary);
      return destination;
    }
  } catch { /* Build a fresh, reproducible native bundle. */ }
  if (platform !== process.platform || arch !== process.arch) throw new Error(`Build the paper MCP on a native ${platform}-${arch} runner first. Its matching bundle is required; cross-compiling Python is unsupported.`);
  const python = path.join(source, ".venv", platform === "win32" ? "Scripts/python.exe" : "bin/python");
  try { await access(python); } catch {
    await run(process.env.BIODESIGN_PAPER_PYTHON || (platform === "win32" ? "python" : "python3"), ["-m", "venv", path.join(source, ".venv")]);
  }
  await run(python, ["-c", "import sys; assert sys.version_info >= (3, 10), 'Python 3.10+ is required only on the build machine'"]);
  // uv-created environments may omit pip. The shipped executable needs neither.
  await run(python, ["-m", "ensurepip"]);
  await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", path.join(source, "requirements.txt")]);
  const buildRoot = path.join(source, "build");
  await mkdir(buildRoot, { recursive: true });
  await run(python, ["-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "paper-search-server",
    "--distpath", path.dirname(destination), "--workpath", buildRoot, "--specpath", buildRoot,
    "--paths", path.join(source, "vendor"), "--collect-submodules", "paper_search_mcp", "--copy-metadata", "mcp",
    path.join(source, "main.py")], { env: { ...process.env, PYTHONPATH: path.join(source, "vendor"), PYINSTALLER_CONFIG_DIR: path.join(buildRoot, "cache") } });
  await cp(path.join(source, "vendor/LICENSE.paper-search-mcp"), path.join(destination, "LICENSE.paper-search-mcp"));
  await cp(path.join(source, "vendor/UPSTREAM.md"), path.join(destination, "UPSTREAM.md"));
  await run(binary, ["--check"]);
  await run(process.execPath, [path.join(root, "desktop/scripts/smoke-paper-mcp.mjs"), binary]);
  await writeFile(path.join(destination, "manifest.json"), JSON.stringify({ version: 1, platform, arch, sourceDigest: digest }, null, 2));
  return destination;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPaperMcp(process.argv[2] || process.platform, process.argv[3] || process.arch);
