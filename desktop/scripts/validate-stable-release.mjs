import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function parseStableSemver(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value || "").trim());
  if (!match) return null;
  return { text: `${match[1]}.${match[2]}.${match[3]}`, parts: match.slice(1).map(Number) };
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index];
  }
  return 0;
}

export function validateStableRelease({ packageVersion, tag, existingReleases = [] }) {
  const version = parseStableSemver(packageVersion);
  if (!version) throw new Error(`Package version ${packageVersion} is not a stable semantic version.`);
  if (tag !== `v${version.text}`) throw new Error(`Release tag ${tag} must exactly match v${version.text}.`);

  const publishedVersions = existingReleases.flat(Infinity)
    .filter((release) => release && release.draft !== true)
    .map((release) => parseStableSemver(release.tag_name))
    .filter(Boolean);
  for (const published of publishedVersions) {
    if (compareVersions(version, published) <= 0) {
      throw new Error(`Stable release ${version.text} is not newer than published release ${published.text}.`);
    }
  }
  return version.text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
  const releasesPath = process.env.BIODESIGN_RELEASES_JSON_PATH;
  const existingReleases = releasesPath
    ? JSON.parse(await readFile(releasesPath, "utf8"))
    : [];
  const version = validateStableRelease({
    packageVersion: packageMetadata.version,
    tag: process.env.BIODESIGN_RELEASE_TAG,
    existingReleases,
  });
  console.log(`Validated stable BioDesign release ${version}.`);
}
