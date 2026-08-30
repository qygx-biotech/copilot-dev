import path from "node:path";
import { ProjectQmdManager } from "./project-qmd-manager.js";

function parseArguments(argv) {
  const parsed = {
    command: "status",
    projectRoot: process.env.BIODESIGN_PROJECT_ROOT || "",
    query: "",
    mode: "fast",
    collections: [],
    vectors: false,
    force: false,
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--project") parsed.projectRoot = argv[++index] || "";
    else if (value === "--query") parsed.query = argv[++index] || "";
    else if (value === "--mode") parsed.mode = argv[++index] || "fast";
    else if (value === "--collection") parsed.collections.push(argv[++index] || "");
    else if (value === "--vectors") parsed.vectors = true;
    else if (value === "--force") parsed.force = true;
    else positionals.push(value);
  }
  if (positionals[0]) parsed.command = positionals[0];
  if (!parsed.query && positionals.length > 1) parsed.query = positionals.slice(1).join(" ");
  parsed.collections = parsed.collections.filter(Boolean);
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args.projectRoot) {
    throw new Error("Pass --project /absolute/path/to/an/initialized/BioDesign/workspace.");
  }
  const manager = new ProjectQmdManager({
    projectRoot: args.projectRoot,
    embedModel: process.env.BIODESIGN_QMD_EMBED_MODEL,
  });
  try {
    await manager.initialize();
    let result;
    if (args.command === "status") {
      result = await manager.status();
    } else if (args.command === "update") {
      result = await manager.update({ collections: args.collections });
    } else if (args.command === "embed") {
      result = await manager.embed({
        collections: args.collections,
        force: args.force,
      });
    } else if (args.command === "rebuild") {
      const update = await manager.update({ collections: args.collections });
      const embed = args.vectors
        ? await manager.embed({ collections: args.collections, force: true })
        : null;
      result = { update, embed };
    } else if (args.command === "search") {
      result = await manager.search({
        query: args.query,
        mode: args.mode,
        collections: args.collections,
        limit: 10,
      });
    } else {
      throw new Error(`Unknown knowledge command: ${args.command}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await manager.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
