import { PaperMcpClient } from "../services/paper-mcp-client.mjs";
const client = new PaperMcpClient(process.argv[2] ? { command: process.argv[2] } : { appPath: process.cwd() });
try {
  await client.start();
  // Exercises the real MCP protocol without depending on a live provider or writing files.
  try {
    await client.call("get_academic_paper", { paper_ref: "paper_000000000000000000000000" });
    throw new Error("Unknown paper handle was accepted");
  } catch (error) { if (error.code !== "PAPER_HANDLE_EXPIRED") throw error; }
  console.log("Local paper MCP executable: startup, tool discovery, structured errors and shutdown verified.");
} finally { await client.close(); }
