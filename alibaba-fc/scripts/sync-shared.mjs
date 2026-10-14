import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["corpus-result-service.js", "advanced-tools.js", "runtime-concurrency.js", "runtime-tools.js", "turn-observability.js", "runtime-extensions.js", "generic-subagent.js", "literature-agent.js", "agent-prompts.js", "side-chat-tools.js", "conversation-transcript.js", "academic-tools.js", "source-fetch.js", "source-download.js", "web-search.js", "retrieval-contract.js", "literature-wiki.js", "semantic-intent.js", "experiment-semantics.js", "source-citations.js", "provider-rate-limit.js", "event-stream.js", "chat-images.js"]) {
  const source = path.resolve(packageRoot, "..", "shared", name);
  const destination = path.join(packageRoot, "shared", name);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
// The agent loop shared with the desktop app. Replace the whole directory so
// a module removed from shared/agent cannot linger in an FC package.
const agentDestination = path.join(packageRoot, "shared", "agent");
await rm(agentDestination, { recursive: true, force: true });
await cp(path.resolve(packageRoot, "..", "shared", "agent"), agentDestination, { recursive: true });
console.log("Shared contracts prepared for Alibaba FC packaging.");
