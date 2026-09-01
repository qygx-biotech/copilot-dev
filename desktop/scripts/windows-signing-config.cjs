const fs = require("node:fs");

const PRODUCTION_RELEASE_FLAG = "BIODESIGN_PRODUCTION_RELEASE";
const REQUIRED_SIGNING_ENVIRONMENT = Object.freeze([
  "WINDOWS_CERTIFICATE_FILE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_SIGNING_SUBJECT",
]);

function requireProductionWindowsSigning(environment = process.env, fileExists = fs.existsSync) {
  if (environment[PRODUCTION_RELEASE_FLAG] !== "1") return undefined;

  const missing = REQUIRED_SIGNING_ENVIRONMENT.filter((name) => !String(environment[name] || "").trim());
  if (missing.length) {
    throw new Error(`Production Windows release signing is not configured. Missing: ${missing.join(", ")}.`);
  }

  const certificateFile = environment.WINDOWS_CERTIFICATE_FILE;
  if (!fileExists(certificateFile)) {
    throw new Error("Production Windows release signing certificate file is missing.");
  }

  return Object.freeze({
    certificateFile,
    certificatePassword: environment.WINDOWS_CERTIFICATE_PASSWORD,
    timestampServer: "http://timestamp.digicert.com",
    hashes: ["sha256"],
    automaticallySelectCertificate: false,
    description: "BioDesign Copilot",
    website: "https://github.com/qygx-biotech/copilot-dev",
  });
}

module.exports = {
  PRODUCTION_RELEASE_FLAG,
  REQUIRED_SIGNING_ENVIRONMENT,
  requireProductionWindowsSigning,
};
