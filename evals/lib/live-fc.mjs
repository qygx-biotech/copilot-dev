// Evaluation transport: reuses the production authenticated Alibaba FC client.
// No Requesty endpoint, model selection, or provider credential exists here.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { LiteratureApiClient } = require('../../docs/literature-module.js');
const { readWorkbenchResponse } = require('../../shared/event-stream.js');

export async function createLiveFc({ baseUrl, tokenFile, token = process.env.BIODESIGN_EVAL_FC_TOKEN, timeoutMs = 180000 } = {}) {
  if (tokenFile) token = (await fs.readFile(tokenFile, 'utf8')).trim();
  if (!token) return null;
  const url = new URL(baseUrl || 'https://biodesi-api-dev-jvvowibabk.cn-beijing.fcapp.run');
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.fcapp.run') || url.username || url.password || url.search || url.hash) {
    throw new Error('Evaluation requires the existing HTTPS Alibaba FC application endpoint.');
  }
  const calls = [];
  const trackedFetch = async (input, init = {}) => {
    const target = new URL(input);
    if (target.origin !== url.origin) throw new Error('FC evaluation origin boundary rejected a request.');
    const start = performance.now();
    const item = { endpoint: target.pathname, startedAt: new Date().toISOString(), status: null, durationMs: null };
    calls.push(item);
    try {
      const response = await fetch(target, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      item.status = response.status;
      return response;
    } catch (error) { item.errorCode = error.code || error.name; throw error; }
    finally { item.durationMs = performance.now() - start; }
  };
  const headers = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const api = new LiteratureApiClient({ baseUrl: url.origin, getHeaders: headers, fetch: trackedFetch });
  return {
    api, calls, baseUrl: url.origin,
    async probe() {
      const config = await api.getKnowledgeRetrievalConfig();
      const cards = await api.getPaperCardConfiguration();
      // Store only signatures/versions, never response objects or auth headers.
      return { reachable: true, plannerSignature: config.plannerSignature ?? config.plannerConfigSignature ?? null, rerankerSignature: config.rerankerSignature ?? config.rerankerConfigSignature ?? null, paperCardSignature: cards.modelSignature ?? null, revision: null };
    },
    async generateAnswer({ query, context, testCase, case: caseAlias, signal }) {
      const c = testCase || caseAlias || {};
      const started = performance.now();
      let firstVisibleMs = null;
      const response = await trackedFetch(`${url.origin}/chat`, {
        method: 'POST', headers: headers(), signal,
        body: JSON.stringify({ mode: c.setup?.surface === 'agent_command' ? 'agent_instruction' : 'side_chat', stream: true,
          messages: [{ role: 'user', content: query }], localWorkspaceContext: context,
          referenceDocuments: [], experimentDocuments: [], experimentNotes: [], storedDocuments: [], selectedDocumentKeys: [],
          callContext: { turnId: `eval-${c.id || 'case'}-${Date.now()}`, profile: 'medium', role: 'answer' } }),
      });
      if (!response.ok) throw Object.assign(new Error(`FC chat returned HTTP ${response.status}`), { code: `FC_HTTP_${response.status}` });
      const data = await readWorkbenchResponse(response, { signal, onEvent(event) { if (event.type === 'delta' && firstVisibleMs === null) firstVisibleMs = performance.now() - started; } });
      return { text: data.reply ?? '', citations: data.citations ?? [], semanticTelemetry: data.semanticTelemetry ?? null,
        usage: data.usage ?? null, firstVisibleMs, wallMs: performance.now() - started,
        limitation: 'FC HTTP requests observed; upstream transport attempts and billing require FC usage logs when absent from response.' };
    },
  };
}
