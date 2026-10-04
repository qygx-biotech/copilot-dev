import { EventEmitter } from 'node:events';
import Ajv from 'ajv/dist/2020.js';
import { PlaywrightMcpClient } from '../../services/playwright-mcp-client.mjs';
import { referenceSchema } from '../../services/browser-references.mjs';

export function referencePage() {
  const page = new EventEmitter(), elements = new Map(), actions = [], lookups = [];
  page.closed = false; page.isClosed = () => page.closed; page.url = () => 'https://example.org/';
  page.frameList = []; page.frames = () => page.frameList.filter(frame => !frame.detached);
  page.addFrame = (parent = null) => {
    const frame = { version: 1, detached: false, parentFrame: () => parent, isDetached() { return this.detached; }, locator: () => ({ count: async () => 0 }) };
    frame.evaluateHandle = async () => {
      const version = frame.version;
      return { dispose: async () => {}, evaluate: async () => { if (frame.detached || version !== frame.version) throw new Error('Execution context destroyed'); return true; } };
    };
    page.frameList.push(frame); page.emit('frameattached', frame); return frame;
  };
  const main = page.addFrame(); page.mainFrame = () => main;
  page.navigate = (frame = main) => { frame.version++; page.emit('framenavigated', frame); };
  page.detach = frame => {
    for (const candidate of page.frameList) { for (let ancestor = candidate; ancestor; ancestor = ancestor.parentFrame()) if (ancestor === frame) { candidate.detached = true; break; } }
    page.emit('framedetached', frame);
  };
  page.addElement = (ref, frame = main) => {
    const element = { ref, frame, version: frame.version, connected: true, type: null, href: 'https://example.org/paper.pdf' };
    const alive = () => element.connected && !frame.detached && frame.version === element.version;
    element.handle = {
      dispose: async () => {}, ownerFrame: async () => frame,
      getAttribute: async key => key === 'href' ? element.href : key === 'type' ? element.type : element.autocomplete,
      evaluate: async fn => { if (frame.version !== element.version || frame.detached) throw new Error('Execution context destroyed'); return String(fn).includes('baseURI') ? 'https://example.org/' : element.connected; },
    };
    for (const action of ['click', 'dblclick', 'fill', 'type', 'press', 'selectOption']) element.handle[action] = async (...args) => {
      if (!alive()) throw new Error('Element detached'); actions.push({ name: action, ref, args });
    };
    elements.set(ref, element); return element;
  };
  page.locator = selector => ({ elementHandles: async () => {
    lookups.push(selector); const element = elements.get(selector.replace(/^aria-ref=/, ''));
    return element?.connected && !element.frame.detached && element.version === element.frame.version ? [element.handle] : [];
  } });
  page.snapshots = 0;
  page.ariaSnapshot = async () => { page.snapshots++; return [...elements.values()].filter(element => element.connected && element.version === element.frame.version && !element.frame.detached).map(element => `- link "Articles+" [ref=${element.ref}]`).join('\n'); };
  page.close = async () => { page.closed = true; page.emit('close'); };
  return { page, main, elements, actions, lookups };
}

export async function referenceBrowserFixture() {
  const f = referencePage(), browser = new PlaywrightMcpClient({ profileRoot: '/unused' }), validated = [];
  f.page.addElement('e45'); f.page.addElement('f1e45');
  browser.start = async () => {}; browser.owner = 'job'; browser.currentPage = f.page;
  const pages = [f.page]; browser.context = { pages: () => pages.filter(page => !page.isClosed()) };
  browser.trackPage(f.page, browser.context, () => {});
  const validate = new Ajv().compile({ type: 'object', properties: { target: referenceSchema() }, required: ['target'] });
  browser.validators = new Map(['browser_click', 'browser_type', 'browser_select_option'].map(name => [name, args => { validated.push(args.target); return validate(args); }]));
  browser.validators.set('browser_snapshot', () => true);
  browser.client = { callTool: async () => { throw new Error('Reference actions must use retained exact handles, not MCP re-resolution'); } };
  await browser.observe(); f.page.snapshots = 0; f.lookups.length = 0;
  return { ...f, browser, validated, pages, addPage() { const next = referencePage(); pages.push(next.page); browser.trackPage(next.page, browser.context, () => {}); return next; } };
}
