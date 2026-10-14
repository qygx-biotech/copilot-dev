import process from "node:process";
import { createAgentLoopHost } from "./agent-loop-host.mjs";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("The agent loop must run as an Electron utility process.");

// Electron's net stack honours system proxy and certificate settings; Node's
// fetch does not. Fall back only when the Electron module is unavailable.
let fetchImpl = globalThis.fetch;
try {
  const { net } = await import("electron");
  if (typeof net?.fetch === "function") fetchImpl = (input, init) => net.fetch(input, init);
} catch { /* Plain Node fetch remains available. */ }

const host = createAgentLoopHost({ post: message => parentPort.postMessage(message), fetchImpl });
parentPort.on("message", event => host.handle(event?.data ?? event));
