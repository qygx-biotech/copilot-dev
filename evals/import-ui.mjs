#!/usr/bin/env node
// Read-only import of an actual normal Side Chat exchange from an isolated eval
// workspace. It never accesses a session credential or invokes a provider.
import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyFrozenSuite, writeJson, sha256 } from './lib/reproducibility.mjs';
const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!options.workspace || !options.output) throw new Error('Usage: node evals/import-ui.mjs --workspace ISOLATED_EVAL_PROJECT --output NEW_OBSERVATION_JSON [--cache-state cold|warm]');
const suite = path.resolve('evals/biodesign-eval-v1');
const frozen = await verifyFrozenSuite(suite);
const workspace = path.resolve(options.workspace);
const metadata = JSON.parse(await fs.readFile(path.join(workspace, '.biodesign/workspace.json')));
if (!/synthetic|eval/i.test(metadata.name) && !/eval/i.test(path.basename(workspace))) throw new Error('UI importer requires an explicitly isolated evaluation workspace.');
const index = JSON.parse(await fs.readFile(path.join(workspace, '.biodesign/chat/index.json')));
const conversationFile = path.join(workspace, '.biodesign/chat/conversations', `${index.activeConversationId}.json`);
const conversation = JSON.parse(await fs.readFile(conversationFile));
const user = conversation.messages.filter(m => m.role === 'user').at(-1);
const position = conversation.messages.indexOf(user);
const assistant = conversation.messages.slice(position + 1).find(m => m.role === 'assistant');
if (!assistant) throw new Error('No completed response for latest question; do not import a pending run.');
const cases = (await fs.readFile(path.join(suite, 'cases.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const matches = cases.filter(c => c.query === user.content);
if (matches.length !== 1) throw new Error('Latest actual user question must match one frozen case exactly.');
const c = matches[0];
const elapsed = Date.parse(assistant.createdAt) - Date.parse(user.createdAt);
const observation = { caseId: c.id, repeat: Number(options.repeat || 0), status: 'completed', executionMode: 'live-electron-side-chat-ui',
  cacheState: options['cache-state'] || 'unknown', datasetHash: frozen.hash,
  actual: { answer: { text: assistant.content, citations: assistant.citations || [], claims: null }, chatContext: user.context || null,
    activity: assistant.activity || null, storedConversation: conversation },
  timing: { latencyMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null, timeToFirstVisibleMs: null, cacheState: options['cache-state'] || 'unknown', measurement: 'Persisted user/assistant timestamps; not sub-millisecond instrumentation.' },
  telemetry: user.context?.semanticTelemetry || null,
  provenance: { entrypoint: 'Actual Side Chat UI → askSideChat → ProjectContextService → sendWorkbenchRequest → authenticated FC /chat',
    syntheticFixture: true, providerSubstitution: false, conversationHash: sha256(JSON.stringify(conversation)), workspaceId: metadata.workspaceId,
    rendererSource: 'docs/index.html; renderer reloaded before this lane', fcRevision: null, noCredentialsImported: true },
  limitations: ['FC Requesty tokens, upstream transport retries, and pricing are not exposed by persisted chat telemetry.',
    'Final citations do not establish retrieval top-K rankings; this importer does not fabricate retrieval metrics.',
    'UI lane uses a shared synthetic workspace with sequential artifact warming. Per-case cache state must be recorded explicitly.',
    'The Electron main process revision is not attested by a renderer reload.'],
};
const output = path.resolve(options.output);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ caseId: c.id, output, responseCharacters: assistant.content.length, latencyMs: observation.timing.latencyMs, cloudCalls: observation.telemetry?.cloudCalls ?? null }));
