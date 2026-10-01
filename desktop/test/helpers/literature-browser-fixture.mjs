import { EventEmitter } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PlaywrightMcpClient } from '../../services/playwright-mcp-client.mjs';
import sourceFetch from '../../../shared/source-fetch.js';

// Substitute only Chrome/DNS and the external MCP tool responses. Ownership,
// closure listeners, protocol transport, workflow and checkpoint code are real.
export function browserFixture(t, profileRoot) {
  const contexts = [], calls = [];
  t.mock.method(sourceFetch, 'resolvePublicTarget', async () => ({ address: '93.184.216.34', family: 4 }));
  const browser = new PlaywrightMcpClient({ profileRoot,
    launch: async () => {
      const context = new EventEmitter(), connection = new EventEmitter(), page = new EventEmitter();
      page.closed = false; page.isClosed = () => page.closed;
      page.url = () => 'https://example.org/library'; page.frames = () => [];
      page.close = async () => { page.closed = true; page.emit('close'); };
      context.pages = () => page.closed ? [] : [page]; context.browser = () => connection;
      context.route = async () => {}; context.close = async () => { page.closed = true; context.emit('close'); };
      contexts.push(context); return context;
    },
    connect: async () => {
      const server = new Server({ name: 'browser-fixture', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: 'browser_snapshot', description: 'Observe', inputSchema: { type: 'object', properties: {} } },
        { name: 'browser_navigate', description: 'Navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
      ] }));
      server.setRequestHandler(CallToolRequestSchema, async request => {
        calls.push(request.params.name);
        return { content: [{ type: 'text', text: `- Page URL: https://example.org/library\n- heading "RAW_BROWSER_SNAPSHOT Observed enzyme ${contexts.length}" [ref=e1]` }] };
      });
      return server;
    },
  });
  t.after(() => browser.close());
  return { browser, contexts, calls };
}
