import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillsService } from "../services/skills-service.mjs";
import { ProjectFilesystem } from "../services/project-filesystem.mjs";

const roots = [];
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biodesign-skills-"));
  roots.push(root);
  const filesystem = await ProjectFilesystem.open(root);
  return { root, filesystem, service: new SkillsService(filesystem, options) };
}
const skill = (name, body = "Use existing scoped evidence tools.", fields = "") => `---\nname: ${name}\ndescription: Instructions for ${name}.\n${fields}---\n${body}\n`;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("project-managed, repository, and bundled skills have deterministic precedence", async () => {
  const bundled = await fixture();
  await bundled.filesystem.writeText("shared/SKILL.md", skill("shared", "Bundled."));
  await bundled.filesystem.writeText("bundled-only/SKILL.md", skill("bundled-only"));
  const { filesystem, service } = await fixture({ bundledSkillsPath: bundled.root });
  await filesystem.writeText("skills/shared/SKILL.md", skill("shared", "Repository."));
  assert.equal((await service.read("shared")).body, "Repository.");
  await service.save({ name: "shared", content: skill("shared", "Managed.") });
  assert.equal((await service.read("shared")).body, "Managed.");
  assert.equal(await filesystem.readText("skills/shared/SKILL.md"), skill("shared", "Repository."));
  assert.deepEqual((await service.list()).skills.map(item => [item.name, item.source]), [["bundled-only", "bundled"], ["shared", "project"]]);
});

test("progressive catalog never includes bodies; explicit and always loading respect persistent disables", async () => {
  const { filesystem, service } = await fixture();
  await service.save({ name: "always-on", content: skill("always-on", "Permanent workflow.", "always: true\n") });
  await service.save({ name: "on-demand", content: skill("on-demand", "Only on invocation.") });
  const empty = await service.context();
  assert.deepEqual(empty.active.map(item => item.name), ["always-on"]);
  assert.equal(JSON.stringify(empty.catalog).includes("Only on invocation"), false);
  assert.deepEqual((await service.context("$on-demand $on-demand $$ignored email$not-a-skill")).active.map(item => item.name), ["always-on", "on-demand"]);
  await service.setEnabled("always-on", false);
  const restored = new SkillsService(filesystem);
  assert.deepEqual((await restored.context("$always-on")).active, []);
  assert.equal((await restored.read("always-on")).enabled, false);
  await assert.rejects(() => restored.read("always-on", { forAgent: true }), { code: "SKILL_UNAVAILABLE" });
});

test("Nanobot JSON and nested YAML metadata expose missing dependencies without leaking secrets", async () => {
  const { filesystem, service } = await fixture({ env: { PATH: "", PRIVATE_TOKEN: "keep-secret" } });
  await service.save({ name: "nested", content: skill("nested", "Nested instructions.", 'metadata:\n  nanobot:\n    always: true\n    requires:\n      bins: [nonexistent]\n      env:\n        - PRIVATE_TOKEN\n        - MISSING_TOKEN\n') });
  await service.save({ name: "json", content: skill("json", "JSON instructions.", 'metadata: \'{"nanobot":{"always":true,"requires":{"env":["PRIVATE_TOKEN"]}}}\'\n') });
  const listing = await service.list();
  const nested = listing.skills.find(item => item.name === "nested");
  assert.equal(nested.available, false);
  assert.deepEqual(nested.missing, { bins: ["nonexistent"], env: ["MISSING_TOKEN"] });
  assert.equal(JSON.stringify(listing).includes("keep-secret"), false);
  assert.deepEqual((await service.context("$nested")).active.map(item => item.name), ["json"]);
  await filesystem.writeText("skills/folded/SKILL.md", "---\nname: folded\ndescription: >-\n  Instructions across\n  multiple lines.\n---\nA body.");
  assert.equal((await service.read("folded")).description, "Instructions across multiple lines.");
});

test("skill names, YAML expansion, malformed metadata, and oversized content fail closed", async () => {
  const { filesystem, service } = await fixture();
  for (const name of ["../escape", "a/b", "Uppercase", "a--b", "a\\b"]) {
    await assert.rejects(() => service.save({ name, content: skill(name) }), { code: "INVALID_SKILL_NAME" });
  }
  await assert.rejects(() => service.save({ name: "one", content: skill("two") }), { code: "INVALID_SKILL_METADATA" });
  await assert.rejects(() => service.save({ name: "one", content: skill("one", "body", 'metadata: &shared {requires: {bins: [curl]}}\nrequires: *shared\n') }), { code: "INVALID_SKILL_METADATA" });
  await assert.rejects(() => service.save({ name: "one", content: skill("one", "a".repeat(65536)) }), { code: "SKILL_TOO_LARGE" });
  await filesystem.writeText(".biodesign/runtime/skills.json", "invalid");
  await assert.rejects(() => service.context(), { code: "INVALID_SKILL_STATE" });
});

test("invalid project overrides do not activate a bundled fallback", async () => {
  const bundled = await fixture();
  await bundled.filesystem.writeText("same/SKILL.md", skill("same", "Bundled always", "always: true\n"));
  const { filesystem, service } = await fixture({ bundledSkillsPath: bundled.root });
  await filesystem.writeText("skills/same/SKILL.md", "broken metadata");
  const result = await service.context("$same");
  assert.deepEqual(result.active, []);
  assert.equal(result.errors[0].code, "INVALID_SKILL_METADATA");
});

test("discovery and saving never follow project symlinks", async () => {
  const outside = await fixture();
  await outside.filesystem.writeText("stolen/SKILL.md", skill("stolen", "Secret outside."));
  const { root, filesystem, service } = await fixture();
  await filesystem.ensureDirectory("skills");
  await symlink(path.join(outside.root, "stolen"), path.join(root, "skills", "stolen"));
  assert.deepEqual((await service.list()).skills, []);
  await filesystem.ensureDirectory(".biodesign");
  await symlink(outside.root, path.join(root, ".biodesign", "skills"));
  await assert.rejects(() => service.save({ name: "stolen", content: skill("stolen", "Overwrite attempt") }), { code: "SYMLINK_NOT_ALLOWED" });
  assert.match(await outside.filesystem.readText("stolen/SKILL.md"), /Secret outside/);
});

test("executable dependencies are checked without executing the binary", async () => {
  const { root, service } = await fixture();
  await mkdir(path.join(root, "bin"));
  await writeFile(path.join(root, "bin", "available-tool"), "not executable code", { mode: 0o700 });
  service.env = { PATH: path.join(root, "bin") };
  await service.save({ name: "available", content: skill("available", "Use the tool.", "requires:\n  bins: [available-tool]\n") });
  assert.equal((await service.read("available")).available, true);
});

test("concurrent enable mutations retain both changes", async () => {
  const { service } = await fixture();
  await service.save({ name: "one", content: skill("one") });
  await service.save({ name: "two", content: skill("two") });
  await Promise.all([service.setEnabled("one", false), service.setEnabled("two", false)]);
  assert.deepEqual((await service.list()).skills.map(item => item.enabled), [false, false]);
});
