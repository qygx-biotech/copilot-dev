import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const vendorRoot = path.join(repositoryRoot, "docs", "vendor");

const assets = [
  ["shared/retrieval-contract.js", "retrieval-contract.js"],
  ["shared/retrieval-profiles.js", "retrieval-profiles.js"],
  ["shared/semantic-intent.js", "semantic-intent.js"],
  ["shared/source-citations.js", "source-citations.js"],
  ["shared/experiment-semantics.js", "experiment-semantics.js"],
  ["node_modules/pdfjs-dist/build/pdf.mjs", "pdfjs/pdf.mjs"],
  ["node_modules/pdfjs-dist/build/pdf.worker.mjs", "pdfjs/pdf.worker.mjs"],
  ["node_modules/xlsx/dist/xlsx.full.min.js", "xlsx/xlsx.full.min.js"],
  ["node_modules/katex/dist/katex.min.css", "katex/katex.min.css"],
  ["node_modules/katex/dist/katex.min.js", "katex/katex.min.js"],
  ["node_modules/katex/dist/contrib/auto-render.min.js", "katex/auto-render.min.js"],
  ["node_modules/katex/dist/fonts", "katex/fonts"],
];

await rm(vendorRoot, { recursive: true, force: true });
for (const [source, destination] of assets) {
  const target = path.join(vendorRoot, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(repositoryRoot, source), target, { recursive: true });
}

console.log(`Renderer assets prepared in ${path.relative(repositoryRoot, vendorRoot)}.`);
