const path = require("node:path");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const { AutoUnpackNativesPlugin } = require("@electron-forge/plugin-auto-unpack-natives");
const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { requireProductionWindowsSigning } = require("./desktop/scripts/windows-signing-config.cjs");

const productionWindowsSign = requireProductionWindowsSigning();

function commandLineOption(name, fallback) {
  const equals = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const targetPlatform = commandLineOption("platform", process.platform);
const targetArchitecture = commandLineOption("arch", process.arch);
const targetNativeKey = `${targetPlatform}-${targetArchitecture}`;

function isForeignNativePrebuild(filePath) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const directoryMatch = normalized.match(/\/prebuilds\/([^/]+)\//);
  if (directoryMatch && directoryMatch[1] !== targetNativeKey) return true;
  const betterSqliteMatch = normalized.match(/\/better-sqlite3\/prebuilds\/([^/]+)\.node$/);
  return Boolean(betterSqliteMatch && betterSqliteMatch[1] !== targetNativeKey);
}

const excludedTopLevel = new Set([
  ".git",
  ".github",
  ".wrangler",
  ".agents",
  ".codex",
  "alibaba-fc",
  "coverage",
  "learn-claude-code",
  "out",
  "worker",
]);

const forbiddenPackageSegment = /[/\\](?:__tests__|coverage|examples?|fixtures?|test|tests)(?:[/\\]|$)/i;
const forbiddenPackageFile = /(?:^|[/\\])(?:\.env(?:\..*)?|.*\.(?:map|p12|pem|pfx|key))$/i;

module.exports = {
  packagerConfig: {
    name: "BioDesign",
    executableName: "BioDesign",
    appBundleId: "ai.biodesign.copilot",
    win32metadata: {
      CompanyName: "qygx-biotech",
      FileDescription: "BioDesign Copilot",
      InternalName: "BioDesign",
      OriginalFilename: "BioDesign.exe",
      ProductName: "BioDesign",
    },
    windowsSign: productionWindowsSign,
    // QMD loads sqlite-vec as a raw shared library in addition to .node
    // modules, so every platform-native binary must live outside the ASAR.
    asar: { unpack: "**/*.{node,dylib,so,dll}" },
    // The pinned Electron package already ships the official checksum map.
    // Passing it avoids an unnecessary remote SHASUMS fetch during packaging.
    download: { checksums: require("./node_modules/electron/checksums.json") },
    ignore(filePath) {
      if (!filePath) return false;
      const first = filePath.replace(/^[/\\]+/, "").split(/[/\\]/)[0];
      if (excludedTopLevel.has(first)) return true;
      if (isForeignNativePrebuild(filePath)) return true;
      if (forbiddenPackageFile.test(filePath) || forbiddenPackageSegment.test(filePath)) return true;
      return (
        /^[/\\](?:\.DS_Store|README(?:\.[^/\\]+)?|package-lock\.json)$/i.test(filePath) ||
        /^[/\\]local-backend[/\\]node_modules([/\\]|$)/.test(filePath) ||
        /^[/\\]local-backend[/\\](benchmark|scripts|test)([/\\]|$)/.test(filePath) ||
        /^[/\\]local-backend[/\\]package-lock\.json$/.test(filePath) ||
        /^[/\\]local-backend[/\\]src[/\\](knowledge-cli|server)\.js$/.test(filePath) ||
        /^[/\\]docs[/\\].*\.md$/.test(filePath) ||
        /^[/\\]desktop[/\\](scripts|test)([/\\]|$)/.test(filePath)
      );
    },
  },
  rebuildConfig: {
    force: true,
    // These dependencies ship platform/architecture prebuilds and load them
    // directly. Recompiling them makes packaging depend on the runner's host
    // Visual Studio/Xcode version without changing the Electron runtime ABI.
    ignoreModules: [
      "better-sqlite3",
      "tree-sitter-go",
      "tree-sitter-javascript",
      "tree-sitter-python",
      "tree-sitter-rust",
      "tree-sitter-typescript",
    ],
  },
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["darwin", "win32"] },
    { name: "@electron-forge/maker-dmg", platforms: ["darwin"] },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "BioDesign",
        authors: "qygx-biotech",
        description: "Packaged Electron desktop runtime for BioDesign Copilot.",
        setupExe: "BioDesign-Setup.exe",
        windowsSign: productionWindowsSign,
      },
    },
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    // Fuses run last so ASAR integrity is embedded after all package hooks.
    new FusesPlugin({
      version: FuseVersion.V1,
      // Electron 44 adds WasmTrapHandlers as fuse 9. Forge 7.11.2's supported
      // @electron/fuses@1.8 peer names the first eight; the ninth remains at
      // Electron's documented safe/performance default (enabled) and is audited.
      strictlyRequireAllFuses: false,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      // Required by the existing loadFile()/file: renderer. Disabling this
      // makes ASAR-hosted docs/index.html fail to resolve in packaged builds.
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    }),
  ],
};
