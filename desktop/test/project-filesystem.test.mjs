import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectFilesystem } from "../services/project-filesystem.mjs";

const temporaryRoots = [];

async function temporaryProject(prefix = "biodesign-fs-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("project filesystem reads, atomically writes, lists, and builds a safe tree", async () => {
  const root = await temporaryProject();
  const filesystem = await ProjectFilesystem.open(root);
  await filesystem.ensureDirectory("literature/nested");
  await filesystem.writeText("literature/nested/paper.md", "evidence");
  await filesystem.writeBinary("literature/data.bin", new Uint8Array([1, 2, 3]));
  await filesystem.ensureDirectory(".biodesign/cache");
  await filesystem.writeText(".biodesign/cache/private.txt", "hidden");

  assert.equal(await filesystem.readText("literature/nested/paper.md"), "evidence");
  assert.deepEqual([...new Uint8Array(await filesystem.readBinary("literature/data.bin"))], [1, 2, 3]);
  assert.deepEqual((await filesystem.list("literature", { recursive: true })).map((item) => item.relativePath), [
    "literature/data.bin",
    "literature/nested/paper.md",
  ]);
  const tree = await filesystem.tree();
  assert.equal(tree.children.some((entry) => entry.name === ".biodesign"), false);
  assert.equal(await readFile(path.join(root, "literature", "nested", "paper.md"), "utf8"), "evidence");
});

test("absolute, parent, Windows, empty-segment, and NUL paths are rejected", async () => {
  const root = await temporaryProject();
  const filesystem = await ProjectFilesystem.open(root);
  for (const invalid of ["/etc/passwd", "../outside", "literature/../outside", "C:\\outside", "a//b", "a\0b"]) {
    await assert.rejects(() => filesystem.readText(invalid), { code: "INVALID_PATH" });
  }
});

test("symlink traversal and symlink leaf access are rejected", async () => {
  const root = await temporaryProject();
  const outside = await temporaryProject("biodesign-outside-");
  await writeFile(path.join(outside, "secret.txt"), "outside");
  await mkdir(path.join(root, "literature"));
  await symlink(outside, path.join(root, "literature", "escape"));
  await symlink(path.join(outside, "secret.txt"), path.join(root, "literature", "secret-link.txt"));
  const filesystem = await ProjectFilesystem.open(root);

  await assert.rejects(() => filesystem.readText("literature/escape/secret.txt"), { code: "SYMLINK_NOT_ALLOWED" });
  await assert.rejects(() => filesystem.readText("literature/secret-link.txt"), { code: "SYMLINK_NOT_ALLOWED" });
  await assert.rejects(() => filesystem.writeText("literature/escape/new.txt", "no"), { code: "SYMLINK_NOT_ALLOWED" });
});

test("two project instances cannot observe each other's relative paths", async () => {
  const rootA = await temporaryProject("biodesign-a-");
  const rootB = await temporaryProject("biodesign-b-");
  const projectA = await ProjectFilesystem.open(rootA);
  const projectB = await ProjectFilesystem.open(rootB);
  await projectA.ensureDirectory("literature");
  await projectB.ensureDirectory("literature");
  await projectA.writeText("literature/result.txt", "A");
  await projectB.writeText("literature/result.txt", "B");
  assert.equal(await projectA.readText("literature/result.txt"), "A");
  assert.equal(await projectB.readText("literature/result.txt"), "B");
  assert.notEqual(projectA.id, projectB.id);
});
