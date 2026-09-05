import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["retrieval-contract.js", "semantic-intent.js", "experiment-semantics.js", "source-citations.js"]) {
  const source = path.resolve(packageRoot, "..", "shared", name);
  const destination = path.join(packageRoot, "shared", name);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
console.log("Shared contracts prepared for Alibaba FC packaging.");
