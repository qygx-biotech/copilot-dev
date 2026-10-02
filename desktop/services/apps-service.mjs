import crypto from "node:crypto";
import path from "node:path";
import { assertOnlyKeys, assertRelativePath, ValidationError } from "../ipc/validation.mjs";
import { parseSkill } from "./skills-service.mjs";
import { normalizeMcpConfig } from "./generic-mcp-service.mjs";

const STATE_PATH = ".biodesign/runtime/apps.json";
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const fail = (code, message) => new ValidationError(code, message);

export const MCP_PRESETS = Object.freeze([
  { id: "remote-http", name: "Remote MCP", description: "Connect an existing Streamable HTTP service.", config: { transport: "streamableHttp", url: "", enabled: false, enabledTools: [], timeoutMs: 30000 } },
  { id: "remote-sse", name: "Legacy SSE MCP", description: "Connect a service that explicitly supports SSE.", config: { transport: "sse", url: "", enabled: false, enabledTools: [], timeoutMs: 30000 } },
  { id: "local-program", name: "Local MCP program", description: "Connect an already installed program using stdio.", config: { transport: "stdio", command: "", args: [], enabled: false, enabledTools: [], timeoutMs: 30000 } },
]);

/** A local bundle is declarative configuration plus SKILL.md files. Preview
 * validates every member, pins its digest, and import leaves all members disabled. */
export class AppsService {
  constructor({ filesystem, skills, mcp }) { this.filesystem = filesystem; this.skills = skills; this.mcp = mcp; this.pending = Promise.resolve(); }

  async state() {
    if (!(await this.filesystem.exists(STATE_PATH))) return { version: 1, bundles: [] };
    if ((await this.filesystem.stat(STATE_PATH)).size > 128 * 1024) throw fail("INVALID_APPS_STATE", "The installed Apps catalog is too large.");
    try {
      const value = JSON.parse(await this.filesystem.readText(STATE_PATH));
      if (value.version !== 1 || !Array.isArray(value.bundles) || value.bundles.length > 64 || value.bundles.some(item => !ID.test(item.id)
        || typeof item.name !== "string" || !Array.isArray(item.skills) || !Array.isArray(item.servers))) throw new Error("invalid");
      return value;
    } catch { throw fail("INVALID_APPS_STATE", "The installed Apps catalog is invalid."); }
  }

  async list() {
    const [state, skills, mcp] = await Promise.all([this.state(), this.skills.list(), this.mcp.list()]);
    const apps = [
      { id: "builtin-paper", kind: "integrated", name: "Paper research", description: "Academic search, source acquisition, and literature workflows.", status: "integrated", enabled: true },
      { id: "builtin-browser", kind: "integrated", name: "Research browser", description: "The existing browser MCP used by literature workflows.", status: "integrated", enabled: true },
      ...mcp.servers.map(server => ({ id: `mcp-${server.name}`, kind: "mcp", name: server.name, description: server.config.transport === "stdio" ? server.config.command : server.config.url,
        status: server.status, enabled: server.config.enabled, server: server.name })),
      ...state.bundles.map(bundle => {
        const members = [...bundle.skills.map(name => skills.skills.find(item => item.name === name)), ...bundle.servers.map(name => mcp.servers.find(item => item.name === name))];
        const enabled = members.some(item => item?.enabled || item?.config?.enabled);
        return { ...bundle, kind: "bundle", enabled, status: members.some(item => !item) ? "incomplete" : enabled ? "enabled" : "disabled" };
      }),
    ];
    return { apps, presets: MCP_PRESETS };
  }

  async inspect(manifestPath) {
    assertRelativePath(manifestPath);
    if (!manifestPath.endsWith(".json")) throw fail("INVALID_APP_BUNDLE", "Choose a project-relative JSON bundle manifest.");
    if ((await this.filesystem.stat(manifestPath)).size > 64 * 1024) throw fail("INVALID_APP_BUNDLE", "The bundle manifest is limited to 64 KiB.");
    let manifest;
    try { manifest = JSON.parse(await this.filesystem.readText(manifestPath)); }
    catch { throw fail("INVALID_APP_BUNDLE", "The bundle manifest must contain valid JSON."); }
    assertOnlyKeys(manifest, ["version", "id", "name", "description", "skills", "mcpServers"], "bundle");
    if (manifest.version !== 1 || typeof manifest.id !== "string" || !ID.test(manifest.id) || typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 128
      || (manifest.description !== undefined && (typeof manifest.description !== "string" || manifest.description.length > 2048))) throw fail("INVALID_APP_BUNDLE", "A bundle needs version 1, a lowercase ID, and a name.");
    const skillEntries = manifest.skills || [], serverEntries = manifest.mcpServers || [];
    if (!Array.isArray(skillEntries) || !Array.isArray(serverEntries) || skillEntries.length > 16 || serverEntries.length > 8 || (!skillEntries.length && !serverEntries.length)) {
      throw fail("INVALID_APP_BUNDLE", "A bundle needs 1–16 skill instructions and/or 1–8 MCP configurations.");
    }
    const skills = [];
    for (const entry of skillEntries) {
      assertOnlyKeys(entry, ["name", "path"], "bundle skill");
      assertRelativePath(entry.path);
      if (path.posix.basename(entry.path) !== "SKILL.md") throw fail("INVALID_APP_BUNDLE", "Each skill path must name a SKILL.md file relative to the manifest.");
      const sourcePath = path.posix.join(path.posix.dirname(manifestPath), entry.path);
      if ((await this.filesystem.stat(sourcePath)).size > 65536) throw fail("INVALID_APP_BUNDLE", "Each skill is limited to 64 KiB.");
      const content = await this.filesystem.readText(sourcePath);
      const metadata = parseSkill(entry.name, content);
      skills.push({ name: entry.name, description: metadata.description, sourcePath, version: metadata.version, content });
    }
    const servers = serverEntries.map(entry => {
      assertOnlyKeys(entry, ["name", "config"], "bundle MCP server");
      // Bundles may declare connection mechanics but never smuggle credentials
      // or OAuth ownership across installations. Enter credentials in MCP settings.
      assertOnlyKeys(entry.config, ["transport", "url", "command", "args", "enabledTools", "timeoutMs", "allowLocalhost"], "bundle MCP configuration");
      return { name: entry.name, config: normalizeMcpConfig(entry.name, { ...entry.config, enabled: false }) };
    });
    if (new Set(skills.map(item => item.name)).size !== skills.length || new Set(servers.map(item => item.name)).size !== servers.length) throw fail("INVALID_APP_BUNDLE", "Bundle members must have unique names.");
    const [existingSkills, existingServers, state] = await Promise.all([this.skills.list(), this.mcp.list(), this.state()]);
    const conflicts = [...skills.filter(item => existingSkills.skills.some(existing => existing.name === item.name)).map(item => `Skill ${item.name} already exists.`),
      ...servers.filter(item => existingServers.servers.some(existing => existing.name === item.name)).map(item => `MCP server ${item.name} already exists.`),
      ...(state.bundles.some(item => item.id === manifest.id) ? [`App ${manifest.id} is already installed.`] : [])];
    const digest = sha(JSON.stringify({ manifest, skills: skills.map(({ name, content }) => ({ name, content })) }));
    return { id: manifest.id, name: manifest.name.trim(), description: manifest.description || "", path: manifestPath, digest, conflicts,
      skills: skills.map(({ content, ...item }) => item), servers, _skillContent: skills };
  }

  async preview(path) { const { _skillContent, ...result } = await this.inspect(path); return result; }

  install({ path, expectedDigest }) {
    const result = this.pending.then(async () => {
      const inspected = await this.inspect(path);
      if (typeof expectedDigest !== "string" || inspected.digest !== expectedDigest) throw fail("APP_BUNDLE_CHANGED", "The bundle changed since preview. Preview it again before importing.");
      if (inspected.conflicts.length) throw fail("APP_BUNDLE_CONFLICT", inspected.conflicts.join(" "));
      const state = await this.state();
      if (state.bundles.length >= 64) throw fail("APP_LIMIT", "The project may have at most 64 imported Apps.");
      const createdSkills = [], createdServers = [];
      try {
        for (const skill of inspected._skillContent) {
          await this.skills.import(skill); createdSkills.push(skill.name);
        }
        for (const server of inspected.servers) {
          await this.mcp.save({ ...server, exclusive: true }); createdServers.push(server.name);
        }
        state.bundles.push({ id: inspected.id, name: inspected.name, description: inspected.description, digest: inspected.digest, sourcePath: path,
          installedAt: new Date().toISOString(), skills: createdSkills, servers: createdServers });
        await this.filesystem.writeText(STATE_PATH, JSON.stringify(state, null, 2));
      } catch (error) {
        // All destinations are exclusive creations. No pre-existing component
        // is overwritten, connected, or removed during rollback.
        const rollback = await Promise.allSettled([...createdSkills.map(name => this.skills.remove(name)), ...createdServers.map(name => this.mcp.remove(name))]);
        if (rollback.some(item => item.status === "rejected")) throw fail("APP_IMPORT_PARTIAL", "Import failed and some disabled members remain. Review Skills and MCP settings before retrying.");
        throw error;
      }
      return this.list();
    });
    this.pending = result.catch(() => {});
    return result;
  }
}
