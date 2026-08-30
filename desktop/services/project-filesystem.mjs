import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { assertRelativePath, ValidationError } from "../ipc/validation.mjs";

const DEFAULT_MAX_READ_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_WRITE_BYTES = 128 * 1024 * 1024;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mimeType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".csv": "text/csv",
    ".html": "text/html",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })[extension] || "application/octet-stream";
}

export class ProjectFilesystem {
  static async open(rootPath, options = {}) {
    if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
      throw new ValidationError("INVALID_PROJECT_ROOT", "The project root must be an absolute path selected by the main process.");
    }
    const root = await realpath(rootPath);
    const info = await stat(root);
    if (!info.isDirectory()) throw new ValidationError("INVALID_PROJECT_ROOT", "The selected project root is not a directory.");
    return new ProjectFilesystem(root, options);
  }

  constructor(root, options = {}) {
    this.root = root;
    this.id = options.id || crypto.randomUUID();
    this.maxReadBytes = options.maxReadBytes || DEFAULT_MAX_READ_BYTES;
    this.maxWriteBytes = options.maxWriteBytes || DEFAULT_MAX_WRITE_BYTES;
  }

  descriptor() {
    return { projectId: this.id, name: path.basename(this.root) || "BioDesign Workspace" };
  }

  candidate(relativePath) {
    const relative = assertRelativePath(relativePath);
    const candidate = path.resolve(this.root, ...relative.split("/"));
    if (!isInside(this.root, candidate)) {
      throw new ValidationError("PATH_ESCAPE", "The requested path escaped the active project.");
    }
    return candidate;
  }

  async assertNoSymlink(relativePath, options = {}) {
    const relative = assertRelativePath(relativePath);
    let current = this.root;
    const segments = relative.split("/");
    const inspectCount = options.allowMissingLeaf ? segments.length - 1 : segments.length;
    for (let index = 0; index < inspectCount; index += 1) {
      current = path.join(current, segments[index]);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (error?.code === "ENOENT" && options.allowMissingComponents) break;
        throw error;
      }
      if (info.isSymbolicLink()) {
        throw new ValidationError("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed in project filesystem operations.");
      }
    }
    return this.candidate(relative);
  }

  async resolveExisting(relativePath) {
    const candidate = await this.assertNoSymlink(relativePath);
    const resolved = await realpath(candidate);
    if (!isInside(this.root, resolved)) {
      throw new ValidationError("SYMLINK_ESCAPE", "The requested path resolves outside the active project.");
    }
    return resolved;
  }

  async exists(relativePath) {
    try {
      await this.resolveExisting(relativePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async stat(relativePath) {
    const absolutePath = await this.resolveExisting(relativePath);
    const info = await stat(absolutePath);
    return {
      relativePath,
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      size: Number(info.size),
      lastModified: Number(info.mtimeMs),
      mimeType: info.isFile() ? mimeType(relativePath) : null,
    };
  }

  async readBinary(relativePath) {
    const absolutePath = await this.resolveExisting(relativePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new ValidationError("NOT_A_FILE", "The requested project path is not a file.");
    if (info.size > this.maxReadBytes) throw new ValidationError("FILE_TOO_LARGE", "The project file exceeds the desktop read limit.");
    const bytes = await readFile(absolutePath);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  async readText(relativePath) {
    return Buffer.from(await this.readBinary(relativePath)).toString("utf8");
  }

  async ensureDirectory(relativePath) {
    const candidate = await this.assertNoSymlink(relativePath, {
      allowMissingLeaf: true,
      allowMissingComponents: true,
    });
    const segments = assertRelativePath(relativePath).split("/");
    let current = this.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new ValidationError("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed in project directories.");
        if (!info.isDirectory()) throw new ValidationError("NOT_A_DIRECTORY", "A project path component is not a directory.");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(current);
      }
    }
    return candidate;
  }

  async writeText(relativePath, value, options = {}) {
    if (typeof value !== "string") throw new ValidationError("INVALID_TEXT", "Project text writes require a string.");
    return this.writeBinary(relativePath, Buffer.from(value, "utf8"), options);
  }

  async writeBinary(relativePath, value, options = {}) {
    const bytes = Buffer.from(value);
    if (bytes.byteLength > this.maxWriteBytes) throw new ValidationError("FILE_TOO_LARGE", "The project write exceeds the desktop limit.");
    const relative = assertRelativePath(relativePath);
    const parentRelative = path.posix.dirname(relative);
    if (parentRelative !== ".") await this.ensureDirectory(parentRelative);
    const absolutePath = await this.assertNoSymlink(relative, { allowMissingLeaf: true });
    if (await this.exists(relative)) {
      const existing = await lstat(absolutePath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new ValidationError("INVALID_WRITE_TARGET", "The project write target is not a regular file.");
      }
    }

    if (options.atomic === false) {
      const handle = await open(absolutePath, "w", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      const temporaryPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.tmp-${crypto.randomUUID()}`);
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporaryPath, absolutePath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    }
    return this.stat(relative);
  }

  async remove(relativePath, options = {}) {
    const absolutePath = await this.resolveExisting(relativePath);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) throw new ValidationError("SYMLINK_NOT_ALLOWED", "Symbolic links cannot be removed through the project API.");
    if (info.isDirectory() && options.recursive !== true) {
      throw new ValidationError("RECURSIVE_REQUIRED", "Removing a directory requires an explicit recursive operation.");
    }
    await rm(absolutePath, { recursive: options.recursive === true, force: false });
    return { removed: true, relativePath };
  }

  async list(relativePath, options = {}) {
    const directoryPath = await this.resolveExisting(relativePath);
    const directoryInfo = await stat(directoryPath);
    if (!directoryInfo.isDirectory()) throw new ValidationError("NOT_A_DIRECTORY", "The requested project path is not a directory.");
    const files = [];
    const visit = async (absoluteDirectory, relativeDirectory) => {
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const childRelative = `${relativeDirectory}/${entry.name}`.replace(/^\//, "");
        const childAbsolute = path.join(absoluteDirectory, entry.name);
        if (entry.isDirectory()) {
          if (options.recursive === true) await visit(childAbsolute, childRelative);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await stat(childAbsolute);
        files.push({
          name: entry.name,
          relativePath: childRelative,
          size: Number(info.size),
          lastModified: Number(info.mtimeMs),
          type: mimeType(entry.name),
        });
      }
    };
    await visit(directoryPath, relativePath);
    return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  async tree(options = {}) {
    const excluded = new Set(Array.isArray(options.excludeNames) ? options.excludeNames : [".biodesign"]);
    const visit = async (absoluteDirectory, parentRelative = "") => {
      const children = [];
      for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
        if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
        const relativePath = parentRelative ? `${parentRelative}/${entry.name}` : entry.name;
        const absolutePath = path.join(absoluteDirectory, entry.name);
        if (entry.isDirectory()) {
          children.push({ name: entry.name, relativePath, type: "directory", size: null, lastModified: null, children: await visit(absolutePath, relativePath) });
        } else if (entry.isFile()) {
          const info = await stat(absolutePath);
          children.push({ name: entry.name, relativePath, type: "file", mimeType: mimeType(entry.name), size: Number(info.size), lastModified: Number(info.mtimeMs), children: [] });
        }
      }
      return children.sort((left, right) => left.type !== right.type ? (left.type === "directory" ? -1 : 1) : left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
    };
    return { name: path.basename(this.root), relativePath: "", type: "directory", size: null, lastModified: null, children: await visit(this.root) };
  }
}
