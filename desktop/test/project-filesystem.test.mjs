import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

test("Windows hides existing and newly created workspace metadata directories", async () => {
  const existingRoot = await temporaryProject("biodesign-hidden-existing-");
  await mkdir(path.join(existingRoot, ".biodesign"));
  const hiddenPaths = [];
  await ProjectFilesystem.open(existingRoot, {
    platform: "win32",
    setHiddenAttribute: async (absolutePath) => hiddenPaths.push(absolutePath),
  });

  const newRoot = await temporaryProject("biodesign-hidden-new-");
  const filesystem = await ProjectFilesystem.open(newRoot, {
    platform: "win32",
    setHiddenAttribute: async (absolutePath) => hiddenPaths.push(absolutePath),
  });
  await filesystem.ensureDirectory(".biodesign/cache");
  await filesystem.writeText(".biodesign/workspace.json", "{}");

  assert.deepEqual(hiddenPaths, [
    path.join(await realpath(existingRoot), ".biodesign"),
    path.join(await realpath(newRoot), ".biodesign"),
  ]);
});

test("absolute, parent, Windows, empty-segment, and NUL paths are rejected", async () => {
  const root = await temporaryProject();
  const filesystem = await ProjectFilesystem.open(root);
  for (const invalid of ["/etc/passwd", "../outside", "literature/../outside", "C:\\outside", "a//b", "a\0b"]) {
    await assert.rejects(() => filesystem.readText(invalid), { code: "INVALID_PATH" });
  }
});

test("concurrent cold corpus map writes share newly created directories", async () => {
  const root = await temporaryProject("biodesign-corpus-maps-");
  const filesystem = await ProjectFilesystem.open(root);
  const writes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    filesystem.writeText(`.biodesign/workflows/corpus/maps/paper-${index}.json`, JSON.stringify({ paperId: index })),
  ));
  assert.deepEqual(writes.map((result) => result.status), Array(8).fill("fulfilled"));
  for (let index = 0; index < writes.length; index += 1) {
    assert.deepEqual(JSON.parse(await filesystem.readText(`.biodesign/workflows/corpus/maps/paper-${index}.json`)), { paperId: index });
  }
});

test("directory creation still rejects files and symlinks at the target", async () => {
  const root = await temporaryProject();
  const outside = await temporaryProject("biodesign-directory-outside-");
  const filesystem = await ProjectFilesystem.open(root);
  await writeFile(path.join(root, "occupied"), "file");
  await symlink(outside, path.join(root, "linked"));
  await assert.rejects(() => filesystem.ensureDirectory("occupied"), { code: "NOT_A_DIRECTORY" });
  await assert.rejects(() => filesystem.ensureDirectory("linked"), { code: "SYMLINK_NOT_ALLOWED" });
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

test("citation existence checks reject symlink escapes and remain scoped to the selected workspace", async () => {
  const root = await temporaryProject("biodesign-citation-");
  const outside = await temporaryProject("biodesign-citation-other-");
  const filesystem = await ProjectFilesystem.open(root);
  await filesystem.ensureDirectory("literature/中文");
  await filesystem.writeText("literature/中文/论文.pdf", "fixture");
  await writeFile(path.join(outside, "paper.pdf"), "other workspace");
  await symlink(path.join(outside, "paper.pdf"), path.join(root, "literature", "escape.pdf"));
  assert.equal(await filesystem.exists("literature/中文/论文.pdf"), true);
  assert.equal(await filesystem.exists("literature/missing.pdf"), false);
  await assert.rejects(() => filesystem.exists("literature/escape.pdf"), { code: "SYMLINK_NOT_ALLOWED" });
  await assert.rejects(() => filesystem.exists(path.join(outside, "paper.pdf")), { code: "INVALID_PATH" });
  await assert.rejects(() => filesystem.exists("../paper.pdf"), { code: "INVALID_PATH" });
});

test("metadata-only preflight gets identical nanosecond and filesystem identity fields from tree and stat", async () => {
  const root = await temporaryProject("biodesign-preflight-stat-");
  const filesystem = await ProjectFilesystem.open(root);
  await filesystem.writeText("literature/P17.pdf", "source fixture");
  const metadata = await filesystem.stat("literature/P17.pdf");
  const entry = (await filesystem.tree()).children[0].children[0];
  assert.match(metadata.mtimeNs, /^\d+$/);
  assert.match(metadata.filesystemFileId, /^\d+:\d+$/);
  assert.equal(entry.mtimeNs, metadata.mtimeNs);
  assert.equal(entry.filesystemFileId, metadata.filesystemFileId);
  assert.doesNotThrow(() => JSON.stringify(entry));
});
