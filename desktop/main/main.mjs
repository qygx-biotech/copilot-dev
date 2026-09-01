import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// This must run before the normal application module is evaluated. The package
// creates/removes Squirrel shortcuts and quits for install, update, uninstall,
// and obsolete lifecycle launches.
const squirrelStartup = require("electron-squirrel-startup");

if (!squirrelStartup) {
  await import("./application.mjs");
}
