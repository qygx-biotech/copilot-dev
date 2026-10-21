import Ajv from "ajv/dist/2020.js";
import path from "node:path";
import { access } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import academic from "../../shared/academic-tools.js";

const error = code => Object.assign(new Error(code), { code });
export function paperServerPath({ appPath, resourcesPath, packaged = false }) {
  const root = packaged ? resourcesPath : path.join(appPath, "desktop", "paper-search", "dist", `${process.platform}-${process.arch}`);
  return path.join(root, "paper-search-server", process.platform === "win32" ? "paper-search-server.exe" : "paper-search-server");
}

export class PaperMcpClient {
  constructor(options) {
    this.command = options.command || paperServerPath(options);
    this.args = options.args || [];
    this.closed = false;
    this.starting = null;
    this.client = null;
    this.transport = null;
    this.queue = Promise.resolve();
  }

  async start() {
    if (this.closed) throw error("OPERATION_ABORTED");
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try { await access(this.command); } catch { throw error("PAPER_MCP_NOT_INSTALLED"); }
      // Only app-controlled settings reach the server: its contact address and an optional OpenAlex key.
      const settings = Object.fromEntries(["BIODESIGN_CONTACT_EMAIL", "BIODESIGN_OPENALEX_API_KEY"].filter(name => process.env[name]).map(name => [name, process.env[name]]));
      const transport = new StdioClientTransport({ command: this.command, args: this.args, stderr: "pipe", env: { PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", ...settings } });
      // Drain upstream diagnostics without putting paper text/URLs into application logs.
      transport.stderr?.resume();
      const client = new Client({ name: "biodesign-desktop", version: "1.0.0" }, { capabilities: {} });
      this.transport = transport;
      client.onclose = () => { if (this.client === client) this.client = null; };
      try {
        await client.connect(transport, { timeout: 15000 });
        const listed = await client.listTools({}, { timeout: 10000 });
        this.tools = listed.tools;
        const ajv = new Ajv({ strict: false });
        this.validators = new Map(listed.tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
        const names = new Set(listed.tools.map(tool => tool.name));
        if (!["search_academic_papers", "get_academic_paper", "resolve_paper_full_text"].every(name => names.has(name))) throw error("PAPER_MCP_INCOMPATIBLE");
        if (this.closed) throw error("OPERATION_ABORTED");
        this.client = client;
        return client;
      } catch (cause) { await client.close().catch(() => {}); throw cause; }
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  call(name, args, signal) {
    const run = async () => {
      if (signal?.aborted || this.closed) throw error("OPERATION_ABORTED");
      if (!academic.isTool(name)) throw error("TOOL_NOT_ALLOWED");
      academic.validateInput(name, args);
      const client = await this.start();
      if (!this.validators.get(name)?.(args)) throw error("INVALID_ACADEMIC_INPUT");
      try {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000, signal });
        if (result.isError) {
          const text = (result.content || []).filter(item => item.type === "text").map(item => item.text).join("");
          throw error(["PAPER_HANDLE_EXPIRED", "SEARCH_CURSOR_EXPIRED", "INVALID_ACADEMIC_INPUT"].find(code => text.includes(code)) || "ACADEMIC_TOOL_FAILED");
        }
        const data = result.structuredContent || JSON.parse(result.content.find(item => item.type === "text")?.text || "null");
        return academic.validateResult(name, data);
      } catch (cause) {
        if (signal?.aborted || this.closed) throw error("OPERATION_ABORTED");
        throw cause.code && typeof cause.code === "string" ? cause : error("PAPER_MCP_FAILED");
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async close() {
    this.closed = true;
    await this.transport?.close().catch(() => {});
    this.client = null;
  }
}
