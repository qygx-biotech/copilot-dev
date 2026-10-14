import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { FeedbackReports, FEEDBACK_LIMITS, validateFeedbackPayload } from '../services/feedback-report.mjs';
import { registerIpcHandlers } from '../ipc/register-handlers.mjs';
import channels from '../ipc/channels.cjs';
import { createRequire } from 'node:module';
const { redactSecrets } = createRequire(import.meta.url)('../../shared/redact-secrets.js');

const HOME = '/Users/researcher';
// Composed so no source file contains a credential-shaped literal.
const BEARER = ['Bearer', 'abcdefghijklmnopqrstuvwxyz012345'].join(' ');
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJhY2NvdW50IjoicmVzZWFyY2hlciJ9', 'c2lnbmF0dXJlLXZhbHVlLTEyMw'].join('.');
const SK = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-');

async function reports(t, overrides = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'biodesign-feedback-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logFile = path.join(directory, 'desktop.log');
  await writeFile(logFile, `2026-10-07T00:00:00Z start ${HOME}/Projects/enzyme\n2026-10-07T00:00:01Z auth ${BEARER}\n`);
  const revealed = [];
  const service = new FeedbackReports({ homeDirectory: HOME, logFile, randomId: () => '0123456789abcdef-report', now: () => new Date('2026-10-07T12:00:00Z'),
    appInfo: () => ({ version: '0.1.7', platform: 'darwin' }), diagnostics: async () => ({ projectOpen: true, cwd: `${HOME}/Projects/enzyme` }),
    chooseFile: async name => path.join(directory, name), reveal: file => revealed.push(file), ...overrides });
  return { service, directory, revealed };
}
const payload = extra => validateFeedbackPayload({ category: 'bug', note: `Crashed while reading ${HOME}/Projects/enzyme/data.csv with api_key=${SK}`,
  includeLogs: true, includeConversation: false, language: 'en', rendererLog: [{ event: 'agent.started', details: { token: JWT } }],
  turnDetails: { version: 1, turnId: 'turn-1', activities: [] }, conversation: { surface: 'agent_command', title: 'Titre', messages: [{ role: 'user', content: 'Private question' }] }, ...extra });

test('secrets are redacted in the forms Codex handles, plus session tokens', () => {
  for (const [input, expected] of [[`Authorization: ${BEARER}`, 'Authorization: Bearer [REDACTED_SECRET]'], [`token=${JWT}`, 'token=[REDACTED_SECRET]'],
    [JWT, '[REDACTED_SECRET]'], [`key ${SK}`, 'key [REDACTED_SECRET]'], ['AKIAABCDEFGHIJKLMNOP', '[REDACTED_SECRET]'], ['password: "hunter2hunter2"', 'password: "[REDACTED_SECRET]"'],
    ['pH 7.2 and token count 12', 'pH 7.2 and token count 12']])
    assert.equal(redactSecrets(input), expected, input);
});

test('a report holds what the user chose, without secrets or the home folder', async t => {
  const { service, directory } = await reports(t);
  const result = await service.save(payload());
  assert.deepEqual(result, { saved: true, id: '0123456789abcdef-report', fileName: 'biodesign-report-01234567.json', contents: ['report', 'app', 'diagnostics', 'turn', 'logs'] });
  const file = path.join(directory, result.fileName), saved = await readFile(file, 'utf8'), report = JSON.parse(saved);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(report.category, 'bug');
  assert.equal(report.note, 'Crashed while reading ~/Projects/enzyme/data.csv with api_key=[REDACTED_SECRET]');
  assert.equal(report.diagnostics.cwd, '~/Projects/enzyme');
  assert.equal(report.logs.rendererEvents[0].details.token, '[REDACTED_SECRET]');
  assert.match(report.logs.mainLog, /start ~\/Projects\/enzyme\n.*auth Bearer \[REDACTED_SECRET\]/);
  assert.ok(!('conversation' in report), 'The conversation is included only when chosen');
  for (const secret of [HOME, 'abcdefghijklmnopqrstuvwxyz012345', JWT, SK]) assert.ok(!saved.includes(secret), secret);
  const withoutLogs = await service.build(payload({ includeLogs: false, includeConversation: true }));
  assert.deepEqual(withoutLogs.contents, ['report', 'app', 'diagnostics', 'turn', 'conversation']);
  assert.equal(withoutLogs.conversation.messages[0].content, 'Private question');
  assert.ok(!('logs' in withoutLogs));
});

test('reports stay within 5 MB by dropping the oldest log lines first', async t => {
  const { service } = await reports(t);
  const huge = 'x'.repeat(FEEDBACK_LIMITS.mainLogBytes);
  await writeFile(service.logFile, Array.from({ length: 12 }, (_, index) => `${index} ${huge}`).join('\n'));
  // Each part has its own bound; only together, with a long conversation, can they exceed 5 MB.
  const report = await service.build(payload({ includeConversation: true,
    rendererLog: Array.from({ length: 1000 }, (_, index) => ({ event: `e${index}`, details: { text: 'y'.repeat(3900) } })),
    conversation: { surface: 'side_chat', title: 'Long', messages: Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index} ${'z'.repeat(19000)}` })) } }));
  assert.ok(Buffer.byteLength(JSON.stringify(report, null, 2)) <= FEEDBACK_LIMITS.reportBytes);
  assert.deepEqual(report.truncated.slice(0, 2), ['mainLog', 'rendererEvents'], 'Logs are trimmed before the conversation');
  assert.equal(report.logs.mainLog, '');
  assert.ok(report.conversation.messages.at(-1).content.startsWith('m199 '), 'The newest messages are kept');
});

test('cancelling saves nothing; reveal shows only the last saved report', async t => {
  const { service: cancelled } = await reports(t, { chooseFile: async () => null });
  assert.deepEqual(await cancelled.save(payload()), { saved: false });
  assert.throws(() => cancelled.reveal(), { code: 'NO_SAVED_REPORT' });
  const { service, revealed, directory } = await reports(t);
  await service.save(payload());
  assert.deepEqual(service.reveal(), { revealed: true });
  assert.deepEqual(revealed, [path.join(directory, 'biodesign-report-01234567.json')]);
});

test('the renderer may send only bounded, known report fields', () => {
  for (const [bad, code] of [[{ category: 'praise' }, 'INVALID_FEEDBACK_REPORT'], [{ includeLogs: 'yes' }, 'INVALID_FEEDBACK_REPORT'], [{ extra: 1 }, 'UNKNOWN_FIELD'],
    [{ note: 'n'.repeat(FEEDBACK_LIMITS.note + 1) }, 'INVALID_FEEDBACK_REPORT'], [{ rendererLog: Array(FEEDBACK_LIMITS.logEntries + 1).fill({}) }, 'INVALID_FEEDBACK_REPORT'],
    [{ conversation: { surface: 'side_chat', messages: [{ role: 'system', content: 'x' }] } }, 'INVALID_FEEDBACK_REPORT'],
    [{ conversation: { surface: 'side_chat', messages: [{ role: 'user', content: 'x', path: '/etc' }] } }, 'UNKNOWN_FIELD']])
    assert.throws(() => payload(bad), { code }, JSON.stringify(bad).slice(0, 80));
});

test('the report channels are registered only with a feedback service and validate their input', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) };
  const contents = Object.assign(new EventEmitter(), { getURL: () => 'file:///app/docs/desktop.html', isDestroyed: () => false });
  const sessionManager = Object.assign(new EventEmitter(), { requireActive() { throw new Error('No project is needed'); } });
  const options = { ipcMain, dialog: {}, sessionManager, runtimeInfo: () => ({}), getWindow: () => ({ webContents: contents, isDestroyed: () => false }), getUpdaterController: () => null };
  registerIpcHandlers(options);
  assert.ok(!handlers.has(channels.feedbackSave));
  const saved = [];
  registerIpcHandlers({ ...options, feedback: { save: async value => { saved.push(value); return { saved: true }; }, reveal: () => ({ revealed: true }) } });
  const event = { sender: contents, senderFrame: { url: 'file:///app/docs/desktop.html' } };
  assert.deepEqual(await handlers.get(channels.feedbackSave)(event, { category: 'other', note: 'Slow', includeLogs: false, includeConversation: false }), { ok: true, value: { saved: true } });
  assert.equal(saved[0].note, 'Slow');
  const rejected = await handlers.get(channels.feedbackSave)(event, { category: 'other', includeLogs: false, includeConversation: false, path: '/tmp/x' });
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'UNKNOWN_FIELD');
  assert.deepEqual(await handlers.get(channels.feedbackReveal)(event, undefined), { ok: true, value: { revealed: true } });
});
