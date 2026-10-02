import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const api = require('../../docs/composer-picker.js');

test('composer token detection respects caret, line commands, and plain path/email text', () => {
  assert.deepEqual(api.tokenAt('Read @abc12 please', 9), { trigger: '@', query: 'abc', start: 5, end: 11, caret: 9, text: 'Read @abc12 please' });
  assert.equal(api.tokenAt('name@example', 12), null);
  assert.equal(api.tokenAt('Read /tmp/file', 14), null);
  assert.equal(api.tokenAt('Hello /new', 10), null);
  assert.equal(api.tokenAt('Read @abc12', 10, 11), null);
  assert.equal(api.tokenAt('Read $lit-review', 16).trigger, '$');
  assert.equal(api.tokenAt('/sk', 3).query, 'sk');
  assert.equal(api.tokenAt('Hello\n/ne', 9).trigger, '/');
});

test('caret replacement replaces the complete token and leaves surrounding text intact', () => {
  const source = 'Read @abc12 please', token = api.tokenAt(source, 9);
  assert.deepEqual(api.replaceToken(source, token, '@other'), { text: 'Read @other please', caret: 12 });
  assert.throws(() => api.replaceToken('Changed', token, '@other'), { code: 'STALE_COMPOSER_PICKER' });
  assert.throws(() => api.replaceToken(source, token, 'injected\ncommand'), { code: 'STALE_COMPOSER_PICKER' });
});

class Element extends EventTarget {
  constructor(tag, document) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.attributes = new Map(); this.children = []; this.style = {}; this.hidden = false; this.value = ''; this.selectionStart = 0; this.selectionEnd = 0; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  getBoundingClientRect() { return { top: 600, left: 100, width: 600 }; }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView() {}
}
function documentFixture() {
  const view = new EventTarget(); view.innerWidth = 1000; view.Event = Event;
  const document = { defaultView: view }; document.createElement = tag => new Element(tag, document); document.body = document.createElement('body');
  const textarea = document.createElement('textarea');
  textarea.value = '@ab'; textarea.setSelectionRange(3, 3);
  return { textarea, document, key(name) { const event = new Event('keydown', { cancelable: true }); event.key = name; textarea.dispatchEvent(event); return event; } };
}

test('keyboard selection inserts a reference, suppresses sending, and restores accessibility attributes', async () => {
  const { textarea, document, key } = documentFixture();
  textarea.setAttribute('role', 'textbox');
  const selected = [];
  const controller = api.attach(textarea, { getChoices: () => [{ id: 'abc12', label: 'First', insertText: '@abc12' }, { id: 'abc34', label: 'Second', insertText: '@abc34' }], onChoose: choice => selected.push(choice.id) });
  await controller.refresh();
  assert.equal(textarea.getAttribute('aria-expanded'), 'true');
  key('ArrowDown');
  assert.equal(document.body.children[0].children[1].getAttribute('aria-selected'), 'true');
  const enter = key('Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(textarea.value, '@abc34 ');
  assert.deepEqual(selected, ['abc34']);
  assert.equal(textarea.getAttribute('aria-expanded'), 'false');
  controller.destroy();
  assert.equal(document.body.children.length, 0);
  assert.equal(textarea.getAttribute('role'), 'textbox');
  assert.equal(textarea.getAttribute('aria-controls'), null);
});

test('stale asynchronous menu results and moved cursor cannot insert into the wrong text', async () => {
  const { textarea, document, key } = documentFixture();
  const deferred = [], errors = [];
  const controller = api.attach(textarea, { getChoices: () => new Promise(resolve => deferred.push(resolve)), onError: error => errors.push(error.code) });
  const first = controller.refresh();
  textarea.value = '$skill'; textarea.setSelectionRange(6, 6);
  const second = controller.refresh();
  deferred[1]([{ id: 'skill', insertText: '$skill' }]); await second;
  deferred[0]([{ id: 'old', insertText: '@old' }]); await first;
  assert.equal(document.body.children[0].children[0].children[0].textContent, '$skill');
  textarea.setSelectionRange(0, 0); key('Enter');
  assert.equal(textarea.value, '$skill');
  assert.deepEqual(errors, ['STALE_COMPOSER_PICKER']);
  controller.destroy();
});

test('escape and blur cancel suggestions without invoking a selected action', async () => {
  const { textarea, key } = documentFixture();
  let calls = 0;
  const controller = api.attach(textarea, { getChoices: () => [{ id: 'abc12' }], onChoose: () => calls++ });
  await controller.refresh(); key('Escape');
  assert.equal(textarea.getAttribute('aria-expanded'), 'false');
  await controller.refresh(); textarea.dispatchEvent(new Event('blur'));
  assert.equal(textarea.getAttribute('aria-expanded'), 'false');
  assert.equal(calls, 0);
  controller.destroy();
});
