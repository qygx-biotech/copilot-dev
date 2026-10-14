(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BioDesignRuntimeInteraction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Trusted UI only. Model strings are text nodes, never HTML or script.
  function create({ document, title = 'Agent work', isCurrent = () => true, readArtifact } = {}) {
    let panel, content, planNode, ended = false, messages = 0;
    const questions = new Set();
    const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
    const button = (text, action) => { const node = element('button', text); node.type = 'button'; node.addEventListener('click', action); return node; };
    function ensure() {
      if (ended || !isCurrent()) throw Object.assign(new Error('The request has ended.'), { code: 'OPERATION_ABORTED' });
      if (panel?.isConnected) return;
      panel = element('section'); panel.className = 'runtime-interaction'; panel.setAttribute('aria-label', 'Agent interaction');
      panel.style.cssText = 'width:min(440px,90vw);max-height:65vh;overflow:auto;background:Canvas;color:CanvasText;border:1px solid #888;border-radius:12px;padding:16px;box-shadow:0 4px 20px #0003';
      panel.append(element('h3', title.slice(0, 160)));
      content = element('div'); content.setAttribute('aria-live', 'polite'); panel.append(content);
      panel.append(button('Dismiss', () => {
        for (const question of questions) question.close();
        panel.remove(); planNode = null;
      }));
      stack().append(panel);
    }
    // Agent Work tasks running in parallel each ask in their own panel; the
    // panels stack in the corner instead of covering one another.
    function stack() {
      let host = document.querySelector('.runtime-interactions');
      if (!host) {
        host = element('div'); host.className = 'runtime-interactions';
        host.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:1000;display:flex;flex-direction:column-reverse;align-items:flex-end;gap:12px;max-height:calc(100vh - 48px);overflow:auto';
        document.body.append(host);
      }
      return host;
    }
    function confirm({ title, signal }) {
      ensure();
      const form = element('section'); form.append(element('p', title)); content.append(form);
      return new Promise(resolve => {
        let settled = false;
        const finish = value => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); questions.delete(request); form.remove(); resolve(value); };
        const abort = () => finish(false), request = { close: abort }; questions.add(request);
        form.append(button('Approve', () => finish(isCurrent() && !signal?.aborted)), button('Decline', abort));
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      });
    }
    function ask({ questions: items, signal, asynchronous, deliver = () => {} }) {
      ensure();
      const form = element('form'); form.setAttribute('aria-label', asynchronous ? 'Agent question (answer while this turn is active)' : 'Agent question');
      form.append(element('p', 'Answers steer this turn. They do not grant new source or execution permissions.'));
      const fields = items.map(question => {
        const group = element('fieldset'); group.append(element('legend', question.question));
        const id = `runtime-answer-${globalThis.crypto.randomUUID()}`;
        const input = element('textarea'); input.id = id; input.rows = 2; input.maxLength = 4000;
        const label = element('label', 'Your answer'); label.htmlFor = id;
        for (const option of question.options || []) group.append(button(option.label, () => { input.value = option.label; input.focus(); }),
          ...(option.description ? [element('small', option.description)] : []));
        group.append(label, input); form.append(group);
        return { id: question.id, input };
      });
      const error = element('p'); error.setAttribute('role', 'alert'); form.append(error);
      let resolve, settled = false;
      const answer = new Promise(done => { resolve = done; });
      const finish = value => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort); questions.delete(request); form.remove(); resolve(value);
      };
      const abort = () => finish(null);
      const request = { answer, close: abort };
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!isCurrent() || signal?.aborted || ended) { finish(null); return; }
        if (fields.some(field => !field.input.value.trim())) { error.textContent = 'Answer each question, or dismiss the request.'; return; }
        const value = { answers: Object.fromEntries(fields.map(field => [field.id, { answers: [field.input.value.trim()] }])) };
        // Enqueue before acknowledging the UI action. On a full queue the text
        // stays editable and the user sees the failure, rather than losing it.
        try { deliver(value); } catch (cause) { error.textContent = cause.message || 'The answer could not be delivered. Start a new turn.'; return; }
        finish(value);
      });
      const submit = element('button', 'Send answers'); submit.type = 'submit';
      form.append(submit, button('Skip', () => finish(null))); content.append(form); questions.add(request);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      return request;
    }
    return {
      confirm,
      result(value) {
        if (readArtifact && /^\.biodesign\/runtime\/generated-images\/[a-f0-9-]{36}\.png$/.test(value?.artifact_path || '')) {
          ensure();
          content.append(button('Save generated image', async () => {
            try {
              if (!isCurrent()) return;
              const bytes = await readArtifact(value.artifact_path); if (!isCurrent()) return;
              const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
              const link = element('a'); link.href = url; link.download = 'generated-image.png'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
            } catch { content.append(element('p', 'The generated image could not be read from this project.')); }
          }));
        }
        for (const item of value?.content || []) {
          if (item.type !== 'image' || !['image/png', 'image/jpeg'].includes(item.mimeType) || typeof item.data !== 'string' || item.data.length > 32000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) continue;
          ensure(); const img = element('img'); img.alt = 'Image returned by an authorized tool'; img.src = `data:${item.mimeType};base64,${item.data}`; img.style.maxWidth = '100%'; content.append(img);
        }
      },
      ask,
      message(text) {
        ensure();
        if (messages >= 30) throw Object.assign(new Error('Message display limit reached.'), { code: 'USER_MESSAGE_LIMIT' });
        messages++; const message = element('p', text); message.style.whiteSpace = 'pre-wrap'; content.append(message);
      },
      plan(value) {
        ensure(); if (planNode) planNode.remove(); planNode = element('div');
        planNode.append(element('h4', 'Task plan'));
        if (value.explanation) planNode.append(element('p', value.explanation));
        const steps = element('ol');
        for (const step of value.plan) steps.append(element('li', `${step.status}: ${step.step}`));
        planNode.append(steps); content.prepend(planNode);
      },
      close() { ended = true; for (const question of questions) question.close(); panel?.remove(); },
    };
  }
  return { create };
});
