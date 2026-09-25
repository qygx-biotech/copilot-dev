import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ProjectFilesystem } from './project-filesystem.mjs';
import { ValidationError } from '../ipc/validation.mjs';

// Shell navigation only. Histories and research state are read from their
// original project stores; this registry never writes a second copy of them.
export class ProjectCatalog {
  constructor(root) { this.root = root; this.writes = Promise.resolve(); }

  accountRoot(account) {
    if (typeof account !== 'string' || !account.trim() || account.length > 200) throw new ValidationError('INVALID_ACCOUNT', 'A signed-in account is required.');
    return path.join(this.root, createHash('sha256').update(account.trim()).digest('hex').slice(0, 24));
  }

  async read(account) {
    const root = this.accountRoot(account);
    await mkdir(path.join(root, 'workspace'), { recursive: true });
    let entries = [];
    try {
      const value = JSON.parse(await readFile(path.join(root, 'projects.json'), 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.some(entry => typeof entry.id !== 'string' || typeof entry.path !== 'string' || !path.isAbsolute(entry.path))) throw new Error('Invalid project registry');
      entries = value.projects;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return [{ id: 'default', name: 'Chats', path: await realpath(path.join(root, 'workspace')), managed: true }, ...entries];
  }

  async remember(account, directory) {
    // Only call with a path returned by Electron's native folder picker.
    const task = this.writes.catch(() => {}).then(async () => {
      const selected = await ProjectFilesystem.open(directory);
      const entries = await this.read(account);
      let entry = entries.find(item => item.path === selected.root);
      if (!entry) {
        entry = { id: randomUUID(), name: path.basename(selected.root), path: selected.root, managed: false };
        const filename = path.join(this.accountRoot(account), 'projects.json');
        const temporary = `${filename}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: 1, projects: [...entries.filter(item => !item.managed), entry] }, null, 2), { mode: 0o600 });
        await rename(temporary, filename);
      }
      return { ...entry, initialized: await selected.exists('.biodesign/workspace.json') };
    });
    this.writes = task;
    return task;
  }

  async get(account, id) {
    const entry = (await this.read(account)).find(item => item.id === id);
    if (!entry) throw new ValidationError('UNKNOWN_PROJECT', 'Choose this project with the folder picker first.');
    // Do not follow a remembered folder that was replaced with a symlink.
    if (await realpath(entry.path) !== entry.path) throw new ValidationError('PROJECT_PATH_CHANGED', 'The project folder changed. Select it again.');
    return entry;
  }

  async list(account) {
    return Promise.all((await this.read(account)).map(async entry => {
      try {
        if (await realpath(entry.path) !== entry.path) throw new ValidationError('PROJECT_PATH_CHANGED', 'The project folder changed. Select it again.');
        const files = await ProjectFilesystem.open(entry.path, { maxReadBytes: 16 * 1024 * 1024 });
        const json = async relative => await files.exists(relative) ? JSON.parse(await files.readText(relative)) : null;
        const state = await json('.biodesign/state.json');
        const agents = (state?.agent?.workbench?.panels || []).filter(chat => chat.messages?.length || chat.sideChatCount > 0).map(chat => ({ id: chat.id, title: chat.title || 'Agent Work', updatedAt: chat.updatedAt, role: 'agent_command' }));
        return { ...entry, hasGoal: Boolean(state?.project?.goal?.trim()), initialized: await files.exists('.biodesign/workspace.json'), conversations: agents.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
      } catch (error) {
        return { ...entry, conversations: [], unavailable: true, error: error.code || 'PROJECT_UNREADABLE' };
      }
    }));
  }
}
