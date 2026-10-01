(function () {
  'use strict';
  function modal(title) {
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'max-width:560px;padding:24px;border:1px solid #bbb;border-radius:12px;color:inherit;background:Canvas';
    const heading = document.createElement('h2'); heading.textContent = title; dialog.append(heading);
    document.body.append(dialog); dialog.showModal(); return dialog;
  }
  const button = (label, fn) => { const node = document.createElement('button'); node.textContent = label; node.style.margin = '8px'; node.onclick = fn; return node; };
  window.BioDesignLibrarySettings = {
    key(account) { return `biodesign.library-url.v1.${encodeURIComponent(account || 'default')}`; },
    get(account) { return localStorage.getItem(this.key(account)) || ''; },
    edit({ account, language = 'en', requiredChoice = false, signal } = {}) {
      return new Promise((resolve, reject) => {
        const zh = language === 'zh';
        const dialog = modal(requiredChoice ? (zh ? '选择文献访问方式' : 'Choose literature access') : 'Library URL');
        dialog.classList.add('library-url-dialog'); dialog.setAttribute('aria-label', 'Library URL');
        const description = document.createElement('p');
        description.textContent = zh ? '请输入学校图书馆网址。若不提供图书馆网址，将仅搜索开放获取的论文。' : 'Enter your university library URL. If no library URL is provided, only open-access papers will be searched.';
        const label = document.createElement('label'); label.textContent = 'Library URL'; label.htmlFor = 'library-url-input';
        const input = document.createElement('input'); input.id = label.htmlFor; input.type = 'url'; input.placeholder = 'https://library.university.edu'; input.autocomplete = 'url';
        const error = document.createElement('p'); error.className = 'library-url-error'; error.setAttribute('role', 'alert');
        try { input.value = this.get(account); } catch { /* Settings can still be entered if storage is unavailable. */ }
        const actions = document.createElement('div'); actions.className = 'library-url-actions';
        const finish = value => { signal?.removeEventListener('abort', abort); dialog.remove(); resolve(value); };
        const abort = () => { signal?.removeEventListener('abort', abort); dialog.remove(); reject(Object.assign(new Error('Library setup cancelled'), { code: 'OPERATION_ABORTED' })); };
        const save = () => {
          let url = input.value.trim();
          try {
            if (url) { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); url = parsed.href; }
          } catch { error.textContent = zh ? '请输入有效的 http 或 https 网址。' : 'Enter a valid http or https URL without embedded credentials.'; input.focus(); return; }
          try { localStorage.setItem(this.key(account), url); }
          catch { error.textContent = zh ? '无法保存设置，请重试。' : 'Could not save this setting. Please try again.'; return; }
          finish({ url });
        };
        actions.append(button(zh ? '取消' : 'Cancel', () => requiredChoice ? abort() : finish(null)));
        if (requiredChoice) actions.append(button(zh ? '不使用图书馆继续' : 'Continue without library', () => finish({ url: '' })));
        actions.append(button(requiredChoice ? (zh ? '保存并继续' : 'Save and continue') : (zh ? '保存' : 'Save'), save));
        dialog.append(description, label, input, error, actions);
        dialog.addEventListener('cancel', event => { event.preventDefault(); requiredChoice ? abort() : finish(null); });
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save(); } });
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); else input.focus();
      });
    },
  };
  window.BioDesignLiteratureLogin = {
    wait({ jobId, signal }) {
      return new Promise((resolve, reject) => {
        const dialog = modal('University library sign-in');
        const text = document.createElement('p'); text.textContent = 'Complete your university sign-in and MFA directly in the separate browser window. Your progress is saved. Continue when finished; access will be checked again.'; dialog.append(text);
        const finish = value => { signal?.removeEventListener('abort', abort); dialog.remove(); resolve(value); };
        const abort = () => { dialog.remove(); reject(Object.assign(new Error('Request cancelled'), { code: 'OPERATION_ABORTED' })); };
        dialog.append(button('Continue after sign-in', () => finish(true)), button('Cancel retrieval', () => finish(false)));
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      });
    },
    async showJobs() {
      const dialog = modal('Library jobs');
      try {
        const jobs = await window.biodesignDesktop.execution.runWorkflow({ workflowId: 'literature_jobs', input: {} });
        for (const job of jobs.filter(job => !['completed', 'cancelled'].includes(job.status))) {
          const row = document.createElement('p'); row.textContent = `${job.kind === 'discover_papers' ? job.task.objective : job.task.papers.map(p => p.title).join('; ')} — ${job.status}`;
          row.append(button('Resume with saved model', () => { dialog.remove(); window.dispatchEvent(new CustomEvent('biodesign-literature-resume', { detail: job })); })); dialog.append(row);
        }
        if (!dialog.querySelector('p')) { const text = document.createElement('p'); text.textContent = 'No unfinished library jobs.'; dialog.append(text); }
      } catch { const text = document.createElement('p'); text.textContent = 'Open a project to view its saved library jobs.'; dialog.append(text); }
      dialog.append(button('Close', () => dialog.remove()));
    },
  };
})();
