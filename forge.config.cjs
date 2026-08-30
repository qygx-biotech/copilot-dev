const path = require("node:path");
const { AutoUnpackNativesPlugin } = require("@electron-forge/plugin-auto-unpack-natives");

const excludedTopLevel = new Set([
  ".git",
  ".github",
  ".wrangler",
  "alibaba-fc",
  "learn-claude-code",
  "out",
  "worker",
]);

module.exports = {
  packagerConfig: {
    name: "BioDesign",
    executableName: "BioDesign",
    appBundleId: "ai.biodesign.copilot",
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
      return (
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
      },
    },
  ],
  plugins: [new AutoUnpackNativesPlugin({})],
};
