import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(packageRoot, "..", "shared", "retrieval-contract.js");
const destination = path.join(packageRoot, "shared", "retrieval-contract.js");

await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log("Shared retrieval contract prepared for Alibaba FC packaging.");
