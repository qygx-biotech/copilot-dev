import crypto from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ValidationError, assertOnlyKeys } from '../ipc/validation.mjs';
const { redactValue } = createRequire(import.meta.url)('../../shared/redact-secrets.js');

// Bug reports, after Codex's /feedback (codex-rs/feedback, tui/src/bottom_pane/
// feedback_view.rs): a category, a note, and only the parts the user chose,
// listed before saving. BioDesign saves the report as a local JSON file for the
// user to email; nothing is uploaded. Secrets and the home folder path are
// removed from every string.
export const FEEDBACK_CATEGORIES = Object.freeze(['bug', 'bad_result', 'good_result', 'safety_check', 'other']);
export const FEEDBACK_LIMITS = Object.freeze({ note: 4000, logEntries: 1000, logEntryCharacters: 4000, messages: 200, messageCharacters: 20000,
  turnDetailsCharacters: 200000, mainLogBytes: 512 * 1024, reportBytes: 5 * 1024 * 1024 });

const invalid = message => new ValidationError('INVALID_FEEDBACK_REPORT', message);
const text = (value, limit, label) => {
  if (typeof value !== 'string' || value.length > limit) throw invalid(`${label} must be text of at most ${limit} characters.`);
  return value;
};
const json = (value, limit, label) => {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw invalid(`${label} must be JSON.`); }
  if (encoded === undefined || encoded.length > limit) throw invalid(`${label} is too large.`);
  return JSON.parse(encoded);
};

// What the renderer may send: the user's choices and the renderer-side parts.
export function validateFeedbackPayload(payload) {
  assertOnlyKeys(payload, ['category', 'note', 'includeLogs', 'includeConversation', 'language', 'rendererLog', 'turnDetails', 'conversation']);
  if (!FEEDBACK_CATEGORIES.includes(payload.category)) throw invalid('Unknown feedback category.');
  for (const key of ['includeLogs', 'includeConversation']) if (typeof payload[key] !== 'boolean') throw invalid(`${key} must be a boolean.`);
  const result = { category: payload.category, note: text(payload.note ?? '', FEEDBACK_LIMITS.note, 'note').trim(),
    includeLogs: payload.includeLogs, includeConversation: payload.includeConversation, language: payload.language === 'zh' ? 'zh' : 'en' };
  if (payload.rendererLog !== undefined) {
    if (!Array.isArray(payload.rendererLog) || payload.rendererLog.length > FEEDBACK_LIMITS.logEntries) throw invalid('rendererLog is too large.');
    result.rendererLog = payload.rendererLog.map(entry => json(entry, FEEDBACK_LIMITS.logEntryCharacters, 'rendererLog entry'));
  }
  if (payload.turnDetails !== undefined) result.turnDetails = json(payload.turnDetails, FEEDBACK_LIMITS.turnDetailsCharacters, 'turnDetails');
  if (payload.conversation !== undefined) {
    const conversation = payload.conversation;
    assertOnlyKeys(conversation, ['surface', 'title', 'messages']);
    if (!['side_chat', 'agent_command'].includes(conversation.surface) || !Array.isArray(conversation.messages) || conversation.messages.length > FEEDBACK_LIMITS.messages) throw invalid('Invalid conversation.');
    result.conversation = { surface: conversation.surface, title: text(conversation.title ?? '', 300, 'title'),
      messages: conversation.messages.map(message => {
        assertOnlyKeys(message, ['role', 'content', 'createdAt']);
        if (!['user', 'assistant'].includes(message.role)) throw invalid('Invalid message role.');
        return { role: message.role, content: text(message.content, FEEDBACK_LIMITS.messageCharacters, 'message'), ...(typeof message.createdAt === 'string' ? { createdAt: message.createdAt.slice(0, 40) } : {}) };
      }) };
  }
  return result;
}

async function tail(file, bytes) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat(), length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const content = buffer.toString('utf8');
    return size > bytes ? content.slice(content.indexOf('\n') + 1) : content;
  } catch (error) { return error.code === 'ENOENT' ? '' : `(unavailable: ${error.code || 'READ_FAILED'})`; }
  finally { await handle?.close(); }
}

export class FeedbackReports {
  // appInfo(): versions and platform. diagnostics(): app state without paths.
  // chooseFile(defaultName): an absolute path chosen by the user, or null.
  constructor({ appInfo, diagnostics = async () => ({}), logFile = null, chooseFile, reveal = () => {}, homeDirectory = os.homedir(),
    now = () => new Date(), randomId = () => crypto.randomUUID() }) {
    Object.assign(this, { appInfo, diagnostics, logFile, chooseFile, revealFile: reveal, homeDirectory, now, randomId });
    this.lastPath = null;
  }

  async build(payload) {
    const id = this.randomId(), createdAt = this.now().toISOString();
    const diagnostics = await this.diagnostics().catch(error => ({ unavailable: error?.code || 'DIAGNOSTICS_FAILED' }));
    const parts = ['report', 'app', 'diagnostics'];
    const report = { version: 1, id, createdAt, category: payload.category, note: payload.note, language: payload.language,
      app: this.appInfo(), diagnostics };
    if (payload.turnDetails) { report.turn = payload.turnDetails; parts.push('turn'); }
    if (payload.includeLogs) {
      report.logs = { rendererEvents: payload.rendererLog || [], mainLog: this.logFile ? await tail(this.logFile, FEEDBACK_LIMITS.mainLogBytes) : '' };
      parts.push('logs');
    }
    if (payload.includeConversation && payload.conversation) { report.conversation = payload.conversation; parts.push('conversation'); }
    report.contents = parts;
    return this.bound(this.sanitize(report));
  }

  // Secrets anywhere, and the home folder in any path, never leave the app.
  sanitize(report) {
    const redacted = redactValue(report);
    if (!this.homeDirectory || this.homeDirectory.length < 2) return redacted;
    const home = this.homeDirectory.replace(/[/\\]+$/, '');
    const replace = value => typeof value === 'string' ? value.split(home).join('~')
      : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)])) : value;
    return replace(redacted);
  }

  // Oldest log lines go first, then the earliest conversation messages.
  bound(report) {
    const size = () => Buffer.byteLength(JSON.stringify(report, null, 2));
    const truncated = new Set();
    while (size() > FEEDBACK_LIMITS.reportBytes) {
      if (report.logs?.mainLog) { report.logs.mainLog = report.logs.mainLog.slice(Math.ceil(report.logs.mainLog.length / 2)); truncated.add('mainLog'); }
      else if (report.logs?.rendererEvents?.length) { report.logs.rendererEvents = report.logs.rendererEvents.slice(Math.ceil(report.logs.rendererEvents.length / 2)); truncated.add('rendererEvents'); }
      else if (report.conversation?.messages?.length) { report.conversation.messages = report.conversation.messages.slice(1); truncated.add('conversation'); }
      else break;
    }
    if (truncated.size) report.truncated = [...truncated];
    return report;
  }

  async save(payload) {
    const report = await this.build(payload);
    const file = await this.chooseFile(`biodesign-report-${report.id.slice(0, 8)}.json`);
    if (!file) return { saved: false };
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw invalid('The report location must be an absolute path.');
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    this.lastPath = file;
    return { saved: true, id: report.id, fileName: path.basename(file), contents: report.contents, ...(report.truncated ? { truncated: report.truncated } : {}) };
  }

  // Shows the last saved report in Finder or Explorer; the renderer never sees its path.
  reveal() {
    if (!this.lastPath) throw new ValidationError('NO_SAVED_REPORT', 'No report has been saved yet.');
    this.revealFile(this.lastPath);
    return { revealed: true };
  }
}
