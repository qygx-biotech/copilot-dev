import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const topics = require('../../shared/topic-navigation.js');
const STATE_PATH = '.biodesign/runtime/topics.json';

/** Project-scoped navigation only. No prompt or tool authority is persisted here. */
export class TopicService {
  constructor(filesystem) { this.filesystem = filesystem; this.pending = Promise.resolve(); }
  async read() {
    if (!await this.filesystem.exists(STATE_PATH)) return topics.normalizeState();
    let value;
    try { value = JSON.parse(await this.filesystem.readText(STATE_PATH)); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw Object.assign(new Error('The saved topic navigation state is not valid JSON.'), { code: 'INVALID_TOPIC_STATE' });
    }
    return topics.normalizeState(value);
  }
  list() { return this.pending.then(() => this.read()); }
  change(operation) {
    const next = this.pending.then(async () => {
      const previous = await this.read(), state = operation(previous);
      if (JSON.stringify(state) !== JSON.stringify(previous)) await this.filesystem.writeText(STATE_PATH, JSON.stringify(state, null, 2));
      return state;
    });
    this.pending = next.catch(() => {});
    return next;
  }
  sync({ topics: items } = {}) { return this.change(state => topics.syncTopics(state, items)); }
  update({ role, id, pinned, archived } = {}) {
    return this.change(state => topics.updateTopic(state, { role, id }, {
      ...(pinned === undefined ? {} : { pinned }), ...(archived === undefined ? {} : { archived }),
    }));
  }
  reorder({ keys } = {}) { return this.change(state => topics.reorderTopics(state, keys)); }
}

export { STATE_PATH as TOPIC_STATE_PATH };
