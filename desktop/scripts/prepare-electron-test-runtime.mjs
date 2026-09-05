import { createRequire } from "node:module";
import { access } from "node:fs/promises";

// Electron 44 can install its binary lazily on first require. Complete that
// operation before parallel test processes require or launch the same binary.
const require = createRequire(import.meta.url);
await access(require("electron"));
