import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateStableRelease } from "../scripts/validate-stable-release.mjs";

const require = createRequire(import.meta.url);
const { requireProductionWindowsSigning } = require("../scripts/windows-signing-config.cjs");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("production signing fails closed when configuration is absent or invalid", () => {
  assert.equal(requireProductionWindowsSigning({}), undefined);
  assert.throws(
    () => requireProductionWindowsSigning({ BIODESIGN_PRODUCTION_RELEASE: "1" }),
    /WINDOWS_CERTIFICATE_FILE/
  );
  assert.throws(
    () => requireProductionWindowsSigning({
      BIODESIGN_PRODUCTION_RELEASE: "1",
      WINDOWS_CERTIFICATE_FILE: "missing.pfx",
      WINDOWS_CERTIFICATE_PASSWORD: "protected",
      WINDOWS_SIGNING_SUBJECT: "BioDesign Publisher",
    }, () => false),
    /certificate file is missing/
  );
  const config = requireProductionWindowsSigning({
    BIODESIGN_PRODUCTION_RELEASE: "1",
    WINDOWS_CERTIFICATE_FILE: "protected-ci-file.pfx",
    WINDOWS_CERTIFICATE_PASSWORD: "protected",
    WINDOWS_SIGNING_SUBJECT: "BioDesign Publisher",
  }, () => true);
  assert.deepEqual(config.hashes, ["sha256"]);
  assert.match(config.timestampServer, /^http:\/\/timestamp\.digicert\.com$/);
});

test("stable release policy requires a higher matching semantic version and excludes prereleases", () => {
  assert.equal(validateStableRelease({
    packageVersion: "0.1.6",
    tag: "v0.1.6",
    existingReleases: [{ tag_name: "v0.1.5", draft: false, prerelease: true }],
  }), "0.1.6");
  assert.throws(() => validateStableRelease({ packageVersion: "0.1.6-beta.1", tag: "v0.1.6-beta.1" }), /not a stable/);
  assert.throws(() => validateStableRelease({
    packageVersion: "0.1.6",
    tag: "v0.1.6",
    existingReleases: [{ tag_name: "v0.1.6", draft: false }],
  }), /not newer/);
  assert.throws(() => validateStableRelease({
    packageVersion: "0.1.6",
    tag: "v0.1.6",
    existingReleases: [[{ tag_name: "v0.1.7", draft: false }]],
  }), /not newer/);
  assert.throws(() => validateStableRelease({ packageVersion: "0.1.6", tag: "v0.1.7" }), /exactly match/);
});

test("stable workflow publishes a normal release with pinned actions and protected signing secrets", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/windows-stable-release.yml"), "utf8");
  assert.doesNotMatch(workflow, /--draft|--prerelease/);
  assert.match(workflow, /environment: windows-production/);
  assert.match(workflow, /actions\/checkout@[a-f\d]{40}/);
  assert.match(workflow, /actions\/setup-node@[a-f\d]{40}/);
  assert.match(workflow, /WINDOWS_CERTIFICATE_BASE64: \$\{\{ secrets\./);
  assert.match(workflow, /permissions:\r?\n\s+contents: read/);
  assert.match(workflow, /contents: write/);
});

test("beta workflow stays draft-only until manual publication and preserves stable signing gates", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/windows-prerelease.yml"), "utf8");
  const stableWorkflow = await readFile(path.join(repositoryRoot, ".github/workflows/windows-stable-release.yml"), "utf8");
  assert.match(workflow, /--draft/);
  assert.match(workflow, /--prerelease/);
  assert.match(workflow, /BioDesign-Setup\.exe/);
  assert.match(workflow, /RELEASES/);
  assert.match(workflow, /\*-full\.nupkg/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /manually publish it as a public prerelease/);
  assert.match(workflow, /Unknown.publisher|unknown-publisher/i);
  assert.match(stableWorkflow, /environment: windows-production/);
  assert.match(stableWorkflow, /WINDOWS_CERTIFICATE_BASE64/);
  assert.doesNotMatch(stableWorkflow, /--prerelease/);
});

test("Windows update smoke audits and starts the full package before two-version fixtures", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/windows-update-smoke.yml"), "utf8");
  assert.match(workflow, /desktop:build:windows/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /desktop:verify:windows/);
  assert.match(workflow, /desktop:audit:package/);
  assert.match(workflow, /desktop:smoke:packaged/);
  assert.match(workflow, /HTTPS_PROXY: http:\/\/127\.0\.0\.1:9/);
  assert.match(workflow, /build-windows-update-smoke\.mjs/);
  assert.match(workflow, /build-windows-beta-update-smoke\.mjs/);
});

test("Windows Squirrel identity and release artifact names remain stable", async () => {
  const forge = await readFile(path.join(repositoryRoot, "forge.config.cjs"), "utf8");
  const packageMetadata = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.match(packageMetadata.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/);
  assert.match(forge, /name: "BioDesign"/);
  assert.match(forge, /executableName: "BioDesign"/);
  assert.match(forge, /setupExe: "BioDesign-Setup\.exe"/);
  assert.match(await readFile(path.join(repositoryRoot, "desktop/main/windows-updater.mjs"), "utf8"), /com\.squirrel\.BioDesign\.BioDesign/);
});
