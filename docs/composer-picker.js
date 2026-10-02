(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioDesignComposerPicker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  let sequence = 0;
  function tokenAt(text, caret, selectionEnd = caret) {
    if (typeof text !== 'string' || !Number.isInteger(caret) || caret < 0 || caret > text.length || selectionEnd !== caret) return null;
    const match = /(?:^|\s)([@$/])([A-Za-z0-9_.-]{0,100})$/.exec(text.slice(0, caret));
    if (!match) return null;
    const start = caret - match[2].length - 1;
    // Slash commands start a line. Path fragments and URLs never open menus.
    if (match[1] === '/' && text.slice(0, start).split('\n').at(-1).trim()) return null;
    const suffix = /^[A-Za-z0-9_.-]*/.exec(text.slice(caret))[0];
    return { trigger: match[1], query: match[2], start, end: caret + suffix.length, caret, text };
  }
  function replaceToken(text, token, insertText) {
    if (typeof text !== 'string' || text !== token?.text || typeof insertText !== 'string' || insertText.length > 512 || /[\r\n]/.test(insertText)) {
      throw Object.assign(new Error('The composer changed before the reference was selected.'), { code: 'STALE_COMPOSER_PICKER' });
    }
    const value = `${insertText.trimEnd()} `;
    return { text: text.slice(0, token.start) + value + text.slice(token.end).replace(/^ /, ''), caret: token.start + value.length };
  }
  function attach(textarea, { getChoices, onChoose, onError } = {}) {
    if (!textarea?.ownerDocument || typeof getChoices !== 'function') throw new Error('A composer element and choice provider are required.');
    const document = textarea.ownerDocument, view = document.defaultView;
    const listId = `biodesign-composer-picker-${++sequence}`;
    const popup = document.createElement('div'); popup.className = 'composer-reference-picker'; popup.id = listId; popup.hidden = true; popup.setAttribute('role', 'listbox');
    popup.setAttribute('aria-label', 'Composer suggestions'); document.body.append(popup);
    const attributes = ['role', 'aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-activedescendant'];
    const previous = Object.fromEntries(attributes.map(name => [name, textarea.getAttribute(name)]));
    textarea.setAttribute('role', 'combobox'); textarea.setAttribute('aria-autocomplete', 'list'); textarea.setAttribute('aria-controls', listId); textarea.setAttribute('aria-expanded', 'false');
    let epoch = 0, token = null, choices = [], active = 0, destroyed = false;
    const position = () => {
      if (popup.hidden) return;
      const rect = textarea.getBoundingClientRect(), height = Math.min(300, popup.scrollHeight || 240);
      popup.style.width = `${Math.min(460, Math.max(240, rect.width))}px`;
      popup.style.left = `${Math.max(8, Math.min(rect.left, view.innerWidth - Math.min(460, Math.max(240, rect.width)) - 8))}px`;
      popup.style.top = `${Math.max(8, rect.top - height - 8)}px`;
      popup.style.maxHeight = `${Math.max(80, rect.top - 16)}px`;
    };
    const close = () => { epoch++; token = null; choices = []; popup.hidden = true; popup.replaceChildren(); textarea.setAttribute('aria-expanded', 'false'); textarea.removeAttribute('aria-activedescendant'); };
    const paint = () => {
      popup.replaceChildren();
      choices.forEach((choice, index) => {
        const row = document.createElement('div'); row.id = `${listId}-${index}`; row.className = 'composer-reference-option'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === active));
        const title = document.createElement('strong'); title.textContent = choice.label || choice.insertText || choice.id; row.append(title);
        if (choice.description) { const description = document.createElement('small'); description.textContent = choice.description; row.append(description); }
        row.addEventListener('mousedown', event => { event.preventDefault(); choose(index); }); popup.append(row);
      });
      popup.hidden = !choices.length; textarea.setAttribute('aria-expanded', String(Boolean(choices.length)));
      if (choices.length) textarea.setAttribute('aria-activedescendant', `${listId}-${active}`);
      else textarea.removeAttribute('aria-activedescendant');
      position(); popup.children[active]?.scrollIntoView?.({ block: 'nearest' });
    };
    const choose = index => {
      const choice = choices[index], selectedToken = token;
      if (!choice || !selectedToken) return;
      try {
        if (textarea.selectionStart !== selectedToken.caret || textarea.selectionEnd !== selectedToken.caret) throw Object.assign(new Error('The composer cursor moved before selection.'), { code: 'STALE_COMPOSER_PICKER' });
        const replacement = replaceToken(textarea.value, selectedToken, choice.insertText || `${selectedToken.trigger}${choice.id}`);
        close(); textarea.value = replacement.text; textarea.focus(); textarea.setSelectionRange(replacement.caret, replacement.caret);
        textarea.dispatchEvent(new view.Event('input', { bubbles: true }));
        Promise.resolve(onChoose?.(choice, { ...selectedToken, insertedText: choice.insertText || `${selectedToken.trigger}${choice.id}` })).catch(error => onError?.(error));
      } catch (error) { close(); onError?.(error); }
    };
    const refresh = async () => {
      const current = ++epoch;
      const captured = tokenAt(textarea.value, textarea.selectionStart, textarea.selectionEnd);
      if (!captured || textarea.disabled || textarea.readOnly) { close(); return; }
      try {
        const result = await getChoices(captured);
        if (destroyed || current !== epoch || textarea.value !== captured.text || textarea.selectionStart !== captured.caret) return;
        choices = (Array.isArray(result) ? result : []).filter(choice => choice && typeof choice.id === 'string' && !choice.disabled).slice(0, 40);
        active = 0; token = captured; paint();
      } catch (error) { if (current === epoch) { close(); onError?.(error); } }
    };
    const keydown = event => {
      if (event.isComposing || popup.hidden || !choices.length) return;
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'Escape') close();
        else if (event.key === 'Enter' || event.key === 'Tab') choose(active);
        else { active = (active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length; paint(); }
      }
    };
    const cursor = event => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) void refresh(); };
    textarea.addEventListener('input', refresh);
    textarea.addEventListener('click', refresh);
    textarea.addEventListener('keyup', cursor);
    textarea.addEventListener('keydown', keydown, true);
    textarea.addEventListener('blur', close);
    view.addEventListener('resize', position); view.addEventListener('scroll', position, true);
    return { refresh, close, destroy() {
      destroyed = true; close(); popup.remove();
      textarea.removeEventListener('input', refresh); textarea.removeEventListener('click', refresh); textarea.removeEventListener('keyup', cursor);
      textarea.removeEventListener('keydown', keydown, true); textarea.removeEventListener('blur', close);
      view.removeEventListener('resize', position); view.removeEventListener('scroll', position, true);
      for (const [name, value] of Object.entries(previous)) { if (value === null) textarea.removeAttribute(name); else textarea.setAttribute(name, value); }
    } };
  }
  return Object.freeze({ tokenAt, replaceToken, attach });
});
