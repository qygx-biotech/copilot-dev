import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Ajv from 'ajv/dist/2020.js';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlaywrightMcpClient } from '../services/playwright-mcp-client.mjs';
import { verifyPaper } from '../services/paper-verification.mjs';

test('pinned MCP schemas use target, validate with draft 2020-12, and expose unsafe code only upstream', async () => {
  const server = await createConnection({ webmcp: false });
  const client = new Client({ name: 'schema-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const tools = (await client.listTools()).tools;
    const ajv = new Ajv({ strict: false }); tools.forEach(tool => ajv.compile(tool.inputSchema));
    const click = tools.find(tool => tool.name === 'browser_click'); assert(click.inputSchema.properties.target); assert(!click.inputSchema.properties.ref);
    assert(tools.some(tool => tool.name === 'browser_run_code_unsafe'));
  } finally { await client.close(); await server.close(); }
});

test('real PDF parser produces an identity receipt, not just a magic-byte check', async () => {
  const content = 'BT /F1 12 Tf 30 700 Td (Enzyme engineering experiment Alice Smith 2024 DOI: 10.1234/enzyme Version of Record) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const receipt = await verifyPaper(Buffer.from(pdf), { title: 'Enzyme engineering experiment', authors: ['Alice Smith'], year: 2024, doi: '10.1234/enzyme' }, ['published']);
  assert.equal(receipt.pages, 1); assert.equal(receipt.identity, 'doi'); assert.equal(receipt.version, 'published'); assert.equal(receipt.parsed, true);
});

test('real Chrome fixture: multilingual interactions, login suppression and login/resume dialog', { skip: process.env.PLAYWRIGHT_MCP_SMOKE !== '1' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-fixture-'));
  const browser = new PlaywrightMcpClient({ profileRoot: root, headless: true });
  try {
    await browser.start();
    assert(!browser.tools.some(tool => /unsafe|evaluate|cookie|network|pdf_save/.test(tool.name)));
    const page = browser.context.pages()[0];
    await page.setContent('<label>检索<input type="search"></label><button>Search</button>');
    const observed = await browser.call('job', 'browser_snapshot', {});
    const target = observed.snapshot.match(/searchbox "检索" \[ref=(\w+)\]/)[1];
    await browser.call('job', 'browser_type', { target, text: '酶工程' });
    assert.equal(await page.locator('input').inputValue(), '酶工程');
    await assert.rejects(browser.call('job', 'browser_run_code_unsafe', { code: 'return 1' }), { code: 'BROWSER_TOOL_NOT_ALLOWED' });
    await page.setContent('<input type="password" value="fixture-secret"><h1>University login</h1>');
    const login = await browser.call('job', 'browser_snapshot', {}); assert.equal(login.status, 'needs_login'); assert(!JSON.stringify(login).includes('fixture-secret'));
    await page.setContent('<main>Application UI fixture</main>');
    await page.addScriptTag({ path: path.resolve('docs/literature-login.js') });
    await page.evaluate(() => { window.BioDesignLiteratureLogin.wait({ jobId: 'fixture' }).then(value => window.resumed = value); });
    assert.equal(await page.locator('dialog').count(), 1);
    await page.getByRole('button', { name: 'Continue after sign-in' }).click();
    assert.equal(await page.evaluate(() => window.resumed), true);
  } finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
});

test('real Chrome window closure releases ownership and a subsequent job can acquire a fresh browser', { skip: process.env.PLAYWRIGHT_MCP_SMOKE !== '1' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-ownership-'));
  const browser = new PlaywrightMcpClient({ profileRoot: root, headless: true });
  try {
    await browser.call('first-job', 'browser_snapshot', {});
    await assert.rejects(browser.call('competing-job', 'browser_snapshot', {}), { code: 'BROWSER_BUSY' });
    const context = browser.context;
    const lastPage = await context.newPage();
    await context.pages()[0].close();
    assert.equal(browser.owner, 'first-job'); assert.equal(browser.context, context);
    await lastPage.close(); await browser.closing;
    assert.equal(browser.owner, null); assert.equal(browser.context, null);
    const next = await browser.call('next-job', 'browser_snapshot', {});
    assert.equal(next.status, 'observed'); assert.equal(browser.owner, 'next-job');
    assert.notEqual(browser.context, context);
    await browser.close('first-job'); assert.equal(browser.owner, 'next-job');
    await browser.close('next-job'); assert.equal(browser.owner, null);
  } finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
});
