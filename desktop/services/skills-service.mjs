import { access, opendir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { parseDocument } from "yaml";
import { ProjectFilesystem } from "./project-filesystem.mjs";
import { ValidationError } from "../ipc/validation.mjs";

const STATE_PATH = ".biodesign/runtime/skills.json";
const EDITABLE_ROOT = ".biodesign/skills";
const NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_SKILLS = 128;
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_ACTIVE_BYTES = 256 * 1024;

function validateName(name) {
  if (typeof name !== "string" || name.length > 64 || !NAME.test(name)) {
    throw new ValidationError("INVALID_SKILL_NAME", "Use a lowercase skill name of up to 64 letters, numbers, and single hyphens.");
  }
  return name;
}

function requirementList(value, kind) {
  if (value === undefined) return [];
  const pattern = kind === "env" ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
  if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== "string" || item.length > 128 || !pattern.test(item))) {
    throw new ValidationError("INVALID_SKILL_METADATA", `Skill requires.${kind} must contain at most 32 valid names.`);
  }
  return [...new Set(value)];
}

export function parseSkill(name, content) {
  validateName(name);
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_SKILL_BYTES) {
    throw new ValidationError("SKILL_TOO_LARGE", "Each skill must be UTF-8 text of at most 64 KiB.");
  }
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!frontmatter) throw new ValidationError("INVALID_SKILL_METADATA", "A skill needs YAML frontmatter with name and description.");
  // Core schema avoids implicit dates. Alias expansion is forbidden so
  // a document cannot amplify a bounded file into an unbounded metadata object.
  let metadata;
  try {
    const document = parseDocument(frontmatter[1], { schema: "core", uniqueKeys: true });
    if (document.errors.length) throw document.errors[0];
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new ValidationError("INVALID_SKILL_METADATA", "Skill frontmatter must be valid YAML without aliases or duplicate keys.");
  }
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object" || metadata.name !== name ||
    typeof metadata.description !== "string" || !metadata.description.trim() || metadata.description.trim().length > 1024) {
    throw new ValidationError("INVALID_SKILL_METADATA", "The frontmatter name must match the skill directory and description must contain 1–1024 characters.");
  }
  let extension = metadata.metadata || {};
  if (typeof extension === "string") {
    try { extension = JSON.parse(extension); }
    catch { throw new ValidationError("INVALID_SKILL_METADATA", "The metadata field must be a mapping or JSON object."); }
  }
  if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
    throw new ValidationError("INVALID_SKILL_METADATA", "The metadata field must be a mapping or JSON object.");
  }
  extension = extension.biodesign || extension.nanobot || extension.openclaw || extension;
  const requires = extension.requires || metadata.requires || {};
  if (!requires || typeof requires !== "object" || Array.isArray(requires)) throw new ValidationError("INVALID_SKILL_METADATA", "Skill requirements must be a mapping.");
  const always = metadata.always ?? extension.always ?? false;
  if (typeof always !== "boolean") throw new ValidationError("INVALID_SKILL_METADATA", "Skill always must be true or false.");
  return {
    description: metadata.description.trim(), always,
    requires: { bins: requirementList(requires.bins, "bins"), env: requirementList(requires.env, "env") },
    content, body: content.slice(frontmatter[0].length).trim(),
    version: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

async function hasExecutable(name, env, platform) {
  const windows = platform === "win32";
  const directories = String(env.PATH || env.Path || "").split(windows ? ";" : ":").filter(Boolean);
  const extensions = windows ? ["", ...String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  for (const directory of directories) {
    // Empty/relative PATH entries would make availability depend on a different
    // process working directory. They do not grant project shell capability.
    if (!path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      try {
        const candidate = path.join(directory, name + extension);
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return true;
      } catch { /* Try the next explicit PATH candidate. */ }
    }
  }
  return false;
}

function publicSkill(entry) {
  const { content, body, filesystem, ...info } = entry;
  return { ...info, removable: info.path?.startsWith(`${EDITABLE_ROOT}/`) === true };
}

/** Prompt instructions only: loading a skill never changes tool authorization. */
export class SkillsService {
  constructor(filesystem, options = {}) {
    if (!filesystem?.resolveExisting || !filesystem?.writeText) throw new TypeError("A confined project filesystem is required.");
    this.filesystem = filesystem;
    this.bundledSkillsPath = options.bundledSkillsPath || null;
    this.env = options.env || process.env;
    this.platform = options.platform || process.platform;
    this.mutation = Promise.resolve();
  }

  async state() {
    if (!(await this.filesystem.exists(STATE_PATH))) return { version: 1, disabled: [] };
    if ((await this.filesystem.stat(STATE_PATH)).size > 32 * 1024) throw new ValidationError("INVALID_SKILL_STATE", "The skill settings file exceeds its limit.");
    let state;
    try { state = JSON.parse(await this.filesystem.readText(STATE_PATH)); }
    catch { throw new ValidationError("INVALID_SKILL_STATE", "The skill settings file is not valid JSON."); }
    if (state?.version !== 1 || !Array.isArray(state.disabled) || state.disabled.length > MAX_SKILLS ||
      state.disabled.some(name => typeof name !== "string" || name.length > 64 || !NAME.test(name))) {
      throw new ValidationError("INVALID_SKILL_STATE", "The skill settings file is invalid; enabled state cannot be determined.");
    }
    return state;
  }

  async discoverRoot(filesystem, root, source, found, errors, disabled) {
    let directory;
    try {
      const absolute = root ? await filesystem.resolveExisting(root) : filesystem.root;
      directory = await opendir(absolute);
    } catch (error) {
      if (error.code !== "ENOENT") errors.push({ path: root || "bundled/skills", code: error.code || "SKILL_DISCOVERY_FAILED", message: error.message });
      return;
    }
    const children = [];
    let count = 0;
    for await (const entry of directory) {
      if (++count > MAX_DIRECTORY_ENTRIES) throw new ValidationError("TOO_MANY_SKILLS", "A skills directory may contain at most 512 entries.");
      if (entry.isDirectory() && NAME.test(entry.name) && entry.name.length <= 64) children.push(entry.name);
    }
    for (const name of children.sort()) {
      if (found.has(name)) continue;
      const relative = `${root ? `${root}/` : ""}${name}/SKILL.md`;
      try {
        if (!(await filesystem.exists(relative))) continue;
        if ((await filesystem.stat(relative)).size > MAX_SKILL_BYTES) throw new ValidationError("SKILL_TOO_LARGE", "Each skill is limited to 64 KiB.");
        const parsed = parseSkill(name, await filesystem.readText(relative));
        const bins = [];
        for (const bin of parsed.requires.bins) if (!(await hasExecutable(bin, this.env, this.platform))) bins.push(bin);
        const env = parsed.requires.env.filter(variable => !this.env[variable]);
        found.set(name, {
          ...parsed, name, path: source === "bundled" ? `bundled/skills/${name}/SKILL.md` : relative,
          source, enabled: !disabled.has(name), available: !bins.length && !env.length,
          missing: { bins, env }, filesystem,
        });
        if (found.size > MAX_SKILLS) throw new ValidationError("TOO_MANY_SKILLS", "A project may expose at most 128 skills.");
      } catch (error) {
        if (error.code === "TOO_MANY_SKILLS") throw error;
        // Invalid project overrides must not silently activate a bundled skill.
        found.set(name, { name, path: relative, source, enabled: false, available: false, description: "", always: false, invalid: true, missing: { bins: [], env: [] } });
        errors.push({ name, path: relative, code: error.code || "INVALID_SKILL", message: error.message });
      }
    }
  }

  async discover() {
    const state = await this.state();
    const found = new Map();
    const errors = [];
    const disabled = new Set(state.disabled);
    // UI-managed project overrides take precedence over repository and bundled skills.
    await this.discoverRoot(this.filesystem, EDITABLE_ROOT, "project", found, errors, disabled);
    await this.discoverRoot(this.filesystem, "skills", "project", found, errors, disabled);
    if (this.bundledSkillsPath) {
      const bundled = await ProjectFilesystem.open(this.bundledSkillsPath);
      await this.discoverRoot(bundled, "", "bundled", found, errors, disabled);
    }
    if (found.size > MAX_SKILLS) throw new ValidationError("TOO_MANY_SKILLS", "A project may expose at most 128 skills.");
    return { entries: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
  }

  async list() {
    const { entries, errors } = await this.discover();
    return { skills: entries.map(publicSkill), errors };
  }

  async read(name, { forAgent = false } = {}) {
    validateName(name);
    const { entries } = await this.discover();
    const entry = entries.find(item => item.name === name);
    if (!entry || entry.invalid) throw new ValidationError("SKILL_NOT_FOUND", "The requested skill is missing or invalid.");
    if (forAgent && (!entry.enabled || !entry.available)) throw new ValidationError("SKILL_UNAVAILABLE", "This skill is disabled or has unmet requirements.");
    return { ...publicSkill(entry), content: entry.content, body: entry.body };
  }

  async context(text = "") {
    if (typeof text !== "string") throw new ValidationError("INVALID_SKILL_INPUT", "Skill invocation input must be text.");
    const { entries, errors } = await this.discover();
    const requested = new Set([...text.matchAll(/(?<![\w$])\$([A-Za-z0-9_-]+)/g)].map(match => match[1]));
    const active = entries.filter(entry => entry.enabled && entry.available && !entry.invalid && (entry.always || requested.has(entry.name)))
      .map(entry => ({ name: entry.name, path: entry.path, version: entry.version, content: entry.body, reason: entry.always ? "always" : "explicit" }));
    if (active.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.content), 0) > MAX_ACTIVE_BYTES) {
      throw new ValidationError("SKILL_CONTEXT_TOO_LARGE", "Active skills exceed 256 KiB. Disable some always-active skills or invoke fewer skills.");
    }
    return { catalog: entries.filter(entry => entry.enabled && !entry.invalid).map(publicSkill), active, errors };
  }

  serialize(operation) {
    const pending = this.mutation.then(operation);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  async save({ name, content, exclusive = false, enabled }) {
    validateName(name);
    parseSkill(name, content);
    return this.serialize(async () => {
      const { entries } = await this.discover();
      if (exclusive && entries.some(entry => entry.name === name)) throw new ValidationError("SKILL_EXISTS", "A skill with this name already exists. Choose a different name or edit the existing skill.");
      if (!entries.some(entry => entry.name === name) && entries.length >= MAX_SKILLS) throw new ValidationError("TOO_MANY_SKILLS", "A project may expose at most 128 skills.");
      if (enabled !== undefined && typeof enabled !== "boolean") throw new ValidationError("INVALID_SKILL_STATE", "Skill enabled must be a boolean.");
      // Disable imports before creating their instructions, so even always:true
      // cannot activate between the settings and file writes.
      if (enabled === false) {
        const state = await this.state();
        const disabled = [...new Set([...state.disabled, name])].sort();
        if (disabled.length > MAX_SKILLS) throw new ValidationError("INVALID_SKILL_STATE", "The disabled skill list is full.");
        await this.filesystem.writeText(STATE_PATH, JSON.stringify({ version: 1, disabled }, null, 2));
      }
      await this.filesystem.writeText(`${EDITABLE_ROOT}/${name}/SKILL.md`, content, { exclusive });
      return this.read(name);
    });
  }

  async import({ name, content }) {
    // File selection is done by the user in the renderer. This method only
    // writes a bounded instruction file; it never executes installation steps.
    return this.save({ name, content, exclusive: true, enabled: false });
  }

  async remove(name) {
    validateName(name);
    return this.serialize(async () => {
      const { entries } = await this.discover();
      const entry = entries.find(item => item.name === name);
      if (!entry || !entry.path.startsWith(`${EDITABLE_ROOT}/`)) throw new ValidationError("SKILL_REMOVE_DENIED", "Only project-managed skills can be removed here. Repository and bundled skills can be disabled.");
      // Removing an override must not unexpectedly reactivate an inherited
      // skill of the same name on the next model request.
      const state = await this.state();
      const disabled = [...new Set([...state.disabled, name])].sort();
      if (disabled.length > MAX_SKILLS) throw new ValidationError("INVALID_SKILL_STATE", "The disabled skill list is full.");
      await this.filesystem.writeText(STATE_PATH, JSON.stringify({ version: 1, disabled }, null, 2));
      await this.filesystem.remove(`${EDITABLE_ROOT}/${name}`, { recursive: true });
      return { removed: true, name, inheritedDisabled: true };
    });
  }

  async setEnabled(name, enabled) {
    validateName(name);
    if (typeof enabled !== "boolean") throw new ValidationError("INVALID_SKILL_STATE", "Skill enabled must be a boolean.");
    return this.serialize(async () => {
      await this.read(name);
      const state = await this.state();
      const disabled = new Set(state.disabled);
      if (enabled) disabled.delete(name); else disabled.add(name);
      if (disabled.size > MAX_SKILLS) throw new ValidationError("INVALID_SKILL_STATE", "The disabled skill list is full. Remove obsolete entries from the project skill settings before adding another.");
      await this.filesystem.writeText(STATE_PATH, JSON.stringify({ version: 1, disabled: [...disabled].sort() }, null, 2));
      return this.read(name);
    });
  }
}
