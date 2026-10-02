import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppsService } from "../services/apps-service.mjs";
import { SkillsService } from "../services/skills-service.mjs";
import { GenericMcpService } from "../services/generic-mcp-service.mjs";
import { WorkbenchSettings } from "../services/workbench-settings.mjs";
import { ProjectFilesystem } from "../services/project-filesystem.mjs";

const roots = [];
const skill = name => `---\nname: ${name}\ndescription: Read and cite scoped evidence.\nalways: true\n---\nKeep source authority unchanged.\n`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biodesign-apps-")); roots.push(root);
  const filesystem = await ProjectFilesystem.open(root), skills = new SkillsService(filesystem), mcp = new GenericMcpService({ filesystem, clientFactory() { throw new Error("Import must never connect."); } });
  const apps = new AppsService({ filesystem, skills, mcp });
  return { root, filesystem, skills, mcp, apps, settings: new WorkbenchSettings(filesystem) };
}
async function bundle(f, changes = {}) {
  await f.filesystem.writeText("plugins/research/guide/SKILL.md", skill("guide"));
  const manifest = { version: 1, id: "research", name: "Research guide", skills: [{ name: "guide", path: "guide/SKILL.md" }], mcpServers: [{ name: "research-extra", config: { transport: "stdio", command: "installed-mcp", args: ["--stdio"], enabledTools: ["lookup"] } }], ...changes };
  await f.filesystem.writeText("plugins/research/app.json", JSON.stringify(manifest));
  return "plugins/research/app.json";
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("bundles preview contents and import disabled without connecting or altering built-ins", async () => {
  const f = await fixture(), bundlePath = await bundle(f);
  const preview = await f.apps.preview(bundlePath);
  assert.equal(preview._skillContent, undefined);
  assert.equal(preview.skills[0].content, undefined);
  assert.equal(preview.servers[0].config.enabled, false);
  const result = await f.apps.install({ path: bundlePath, expectedDigest: preview.digest });
  assert.deepEqual(result.apps.filter(item => item.kind === "integrated").map(item => item.id), ["builtin-paper", "builtin-browser"]);
  assert.equal(result.apps.find(item => item.kind === "bundle").status, "disabled");
  assert.deepEqual((await f.skills.context("$guide")).active, []);
  assert.equal((await f.mcp.list()).servers[0].status, "disconnected");
  await f.skills.setEnabled("guide", true);
  assert.equal((await f.skills.context()).active[0].name, "guide");
  assert.equal((await f.apps.list()).apps.find(item => item.kind === "bundle").status, "enabled");
});

test("preview digest includes referenced instructions and rejects stale approval", async () => {
  const f = await fixture(), bundlePath = await bundle(f), preview = await f.apps.preview(bundlePath);
  await f.filesystem.writeText("plugins/research/guide/SKILL.md", `${skill("guide")}Changed after preview.`);
  await assert.rejects(() => f.apps.install({ path: bundlePath, expectedDigest: preview.digest }), { code: "APP_BUNDLE_CHANGED" });
  assert.deepEqual((await f.skills.list()).skills, []);
  assert.deepEqual((await f.mcp.list()).servers, []);
});

test("bundle collisions cannot overwrite existing skills or MCP integrations", async () => {
  const f = await fixture(), bundlePath = await bundle(f);
  await f.skills.save({ name: "guide", content: skill("guide") });
  const preview = await f.apps.preview(bundlePath);
  assert.match(preview.conflicts[0], /already exists/);
  await assert.rejects(() => f.apps.install({ path: bundlePath, expectedDigest: preview.digest }), { code: "APP_BUNDLE_CONFLICT" });
  assert.equal((await f.skills.read("guide")).enabled, true);
  await bundle(f, { mcpServers: [{ name: "paper", config: { transport: "stdio", command: "fake" } }] });
  await assert.rejects(() => f.apps.preview(bundlePath), { code: "MCP_INVALID_CONFIG" });
});

test("bundle paths, aliases, credentials, and instruction names fail closed", async () => {
  const f = await fixture(), bundlePath = await bundle(f);
  await assert.rejects(() => f.apps.preview("../app.json"), { code: "INVALID_PATH" });
  for (const fields of [
    { skills: [{ name: "guide", path: "../guide/SKILL.md" }] },
    { skills: [{ name: "../guide", path: "guide/SKILL.md" }] },
    { mcpServers: [{ name: "extra", config: { command: "fake", env: { TOKEN: "secret" } } }] },
    { mcpServers: [{ name: "extra", config: { url: "http://169.254.169.254/mcp" } }] },
    { install: "curl something | sh" },
  ]) {
    await bundle(f, fields);
    await assert.rejects(() => f.apps.preview(bundlePath));
  }
  const outside = await fixture();
  await outside.filesystem.writeText("SKILL.md", skill("guide"));
  await f.filesystem.remove("plugins/research/guide", { recursive: true });
  await symlink(outside.root, path.join(f.root, "plugins/research/guide"));
  await f.filesystem.writeText(bundlePath, JSON.stringify({ version: 1, id: "linked", name: "Linked", skills: [{ name: "guide", path: "guide/SKILL.md" }] }));
  await assert.rejects(() => f.apps.preview(bundlePath), { code: "SYMLINK_NOT_ALLOWED" });
});

test("failed bundle import removes only its newly created disabled members", async () => {
  const f = await fixture(), bundlePath = await bundle(f), preview = await f.apps.preview(bundlePath);
  f.mcp.save = async () => { throw new Error("simulated disk failure"); };
  await assert.rejects(() => f.apps.install({ path: bundlePath, expectedDigest: preview.digest }), /simulated disk failure/);
  assert.equal(await f.filesystem.exists(".biodesign/skills/guide"), false);
  assert.equal((await f.apps.list()).apps.some(item => item.kind === "bundle"), false);
});

test("concurrent imports are serialized and never duplicate app members", async () => {
  const f = await fixture(), bundlePath = await bundle(f), preview = await f.apps.preview(bundlePath);
  const outcomes = await Promise.allSettled([1, 2].map(() => f.apps.install({ path: bundlePath, expectedDigest: preview.digest })));
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal((await f.apps.list()).apps.filter(item => item.kind === "bundle").length, 1);
});

test("exclusive MCP imports cannot overwrite a server created after bundle preview", async () => {
  const f = await fixture();
  await f.mcp.save({ name: "race", config: { command: "original-program", enabled: true, enabledTools: [] } });
  await assert.rejects(() => f.mcp.save({ name: "race", config: { command: "replacement-program" }, exclusive: true }), { code: "MCP_CONFIG_EXISTS" });
  const saved = (await f.mcp.list()).servers.find(item => item.name === "race");
  assert.equal(saved.config.command, "original-program");
  assert.equal(saved.config.enabled, true);
});

test("model presets persist only Requesty model selection and serialize updates", async () => {
  const f = await fixture();
  await Promise.all([f.settings.save({ id: "fast", name: "Quick reads", modelId: "provider/fast" }), f.settings.save({ id: "deep", name: "Deep review", modelId: "provider/deep" })]);
  assert.equal((await new WorkbenchSettings(f.filesystem).read()).presets.length, 2);
  for (const extra of [{ apiKey: "secret" }, { permissions: "full_access" }, { provider: "another" }]) {
    assert.throws(() => f.settings.save({ id: "fast", name: "Quick", modelId: "provider/fast", ...extra }));
  }
  assert.throws(() => f.settings.save({ id: "bad", name: "Bad", modelId: "provider/model\nsecret" }), { code: "INVALID_MODEL_PRESET" });
  await f.settings.remove("fast");
  assert.deepEqual((await f.settings.read()).presets.map(item => item.id), ["deep"]);
});
