(function () {
  'use strict';
  function modal(title) {
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'max-width:560px;padding:24px;border:1px solid #bbb;border-radius:12px;color:inherit;background:Canvas';
    const heading = document.createElement('h2'); heading.textContent = title; dialog.append(heading);
    document.body.append(dialog); dialog.showModal(); return dialog;
  }
  const button = (label, fn) => { const node = document.createElement('button'); node.textContent = label; node.style.margin = '8px'; node.onclick = fn; return node; };
  const paragraph = text => { const node = document.createElement('p'); node.textContent = text; return node; };
  const validUrl = value => {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    return parsed.href;
  };
  window.BioDesignLibrarySettings = {
    key(account) { return `biodesign.library-url.v1.${encodeURIComponent(account || 'default')}`; },
    accessKey(account) { return `biodesign.library-access.v2.${encodeURIComponent(account || 'default')}`; },
    get(account) { return localStorage.getItem(this.key(account)) || ''; },
    // The remembered choice: library website and proxy prefix, or an explicit "no library".
    saved(account) {
      try {
        const value = JSON.parse(localStorage.getItem(this.accessKey(account)) || 'null');
        if (value && typeof value.url === 'string') return { url: value.url, ...(value.proxy ? { proxy: value.proxy } : {}) };
      } catch { /* Fall back to the earlier URL-only setting. */ }
      const url = this.get(account);
      return url ? { url } : null;
    },
    remember(account, value) {
      localStorage.setItem(this.accessKey(account), JSON.stringify({ url: value.url, ...(value.proxy ? { proxy: value.proxy } : {}) }));
      if (value.url) localStorage.setItem(this.key(account), value.url);
    },
    edit({ account, language = 'en', requiredChoice = false, signal } = {}) {
      return new Promise((resolve, reject) => {
        const zh = language === 'zh';
        const dialog = modal(requiredChoice ? (zh ? '选择文献访问方式' : 'Choose literature access') : 'Library URL');
        dialog.classList.add('library-url-dialog'); dialog.setAttribute('aria-label', 'Library URL');
        const description = paragraph(zh ? '请输入学校图书馆网址。若不提供图书馆网址，将仅搜索开放获取的论文。此选择会被记住，可在“账户 → Library URL”中更改。'
          : 'Enter your university library URL. If no library URL is provided, only open-access papers will be searched. This choice is remembered; change it under Account → Library URL.');
        const label = document.createElement('label'); label.textContent = 'Library URL'; label.htmlFor = 'library-url-input';
        const input = document.createElement('input'); input.id = label.htmlFor; input.type = 'url'; input.placeholder = 'https://library.university.edu'; input.autocomplete = 'url';
        const proxyLabel = document.createElement('label'); proxyLabel.textContent = zh ? '图书馆代理前缀（可选）' : 'Library proxy prefix (optional)'; proxyLabel.htmlFor = 'library-proxy-input';
        const proxy = document.createElement('input'); proxy.id = proxyLabel.htmlFor; proxy.type = 'url'; proxy.placeholder = 'https://ezproxy.university.edu/login?url='; proxy.autocomplete = 'off';
        const proxyHelp = paragraph(zh ? '代理前缀（例如 EZproxy 的“login?url=”）可让论文页面直接通过学校访问打开。可在图书馆网站的“校外访问”或书签工具说明中找到。'
          : 'A proxy prefix (for example EZproxy "login?url=") opens publisher pages through your university access. Libraries list it under off-campus access or bookmarklet instructions.');
        proxyHelp.style.fontSize = '0.85em';
        for (const field of [input, proxy]) { field.style.display = 'block'; field.style.width = '100%'; field.style.margin = '4px 0 12px'; }
        const error = document.createElement('p'); error.className = 'library-url-error'; error.setAttribute('role', 'alert');
        try { const saved = this.saved(account); input.value = saved?.url || this.get(account); proxy.value = saved?.proxy || ''; } catch { /* Settings can still be entered if storage is unavailable. */ }
        const actions = document.createElement('div'); actions.className = 'library-url-actions';
        const finish = value => { signal?.removeEventListener('abort', abort); dialog.remove(); resolve(value); };
        const abort = () => { signal?.removeEventListener('abort', abort); dialog.remove(); reject(Object.assign(new Error('Library setup cancelled'), { code: 'OPERATION_ABORTED' })); };
        const save = () => {
          let url = input.value.trim(), prefix = proxy.value.trim();
          try { if (url) url = validUrl(url); if (prefix) prefix = validUrl(prefix); }
          catch { error.textContent = zh ? '请输入有效的 http 或 https 网址。' : 'Enter a valid http or https URL without embedded credentials.'; input.focus(); return; }
          try { this.remember(account, { url, proxy: prefix }); if (!url) localStorage.removeItem(this.key(account)); }
          catch { error.textContent = zh ? '无法保存设置，请重试。' : 'Could not save this setting. Please try again.'; return; }
          finish({ url, ...(prefix ? { proxy: prefix } : {}) });
        };
        actions.append(button(zh ? '取消' : 'Cancel', () => requiredChoice ? abort() : finish(null)));
        // Skipping is remembered as an explicit choice; a saved library URL is kept for later.
        if (requiredChoice) actions.append(button(zh ? '不使用图书馆继续' : 'Continue without library', () => {
          try { if (!this.saved(account)) localStorage.setItem(this.accessKey(account), JSON.stringify({ url: '' })); } catch { /* This request continues regardless. */ }
          finish({ url: '' });
        }));
        actions.append(button(requiredChoice ? (zh ? '保存并继续' : 'Save and continue') : (zh ? '保存' : 'Save'), save));
        dialog.append(description, label, input, proxyLabel, proxy, proxyHelp, error, actions);
        dialog.addEventListener('cancel', event => { event.preventDefault(); requiredChoice ? abort() : finish(null); });
        for (const field of [input, proxy]) field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save(); } });
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); else input.focus();
      });
    },
  };
  window.BioDesignLiteratureLogin = {
    // The download consent: one click, independent of how the request was worded.
    confirmDownload({ papers = [], permission = 'read_only', library = null, language = 'en', signal } = {}) {
      return new Promise((resolve, reject) => {
        const zh = language === 'zh';
        const readOnly = !['workspace_write', 'full_access'].includes(permission);
        const dialog = modal(zh ? `下载 ${papers.length} 篇论文？` : `Download ${papers.length} paper${papers.length === 1 ? '' : 's'}?`);
        dialog.classList.add('literature-download-card'); dialog.setAttribute('aria-label', 'Confirm paper download');
        const list = document.createElement('ol'); list.style.maxHeight = '40vh'; list.style.overflow = 'auto';
        for (const paper of papers.slice(0, 20)) {
          const item = document.createElement('li');
          item.textContent = [paper.title, [paper.authors?.[0], paper.year].filter(Boolean).join(', '), paper.doi ? `doi:${paper.doi}` : ''].filter(Boolean).join(' — ');
          list.append(item);
        }
        dialog.append(list, paragraph(zh ? '论文将保存到项目的 literature 文件夹。系统会先尝试开放获取版本，再通过学校图书馆打开出版商页面。'
          : 'Papers are saved to the project literature folder. Open-access copies are tried first, then publisher pages through your university library.'));
        if (library?.url || library?.proxy) dialog.append(paragraph(zh ? '订阅论文会在单独的浏览器窗口中打开；如需登录学校账号，只需登录一次。'
          : 'Subscription papers open in a separate browser window; if your university sign-in is needed, you sign in once.'));
        if (readOnly) dialog.append(paragraph(zh ? '此对话当前为“只读”模式。下载需要切换到“工作区写入”模式。'
          : 'This conversation is in Read-only mode. Downloading switches it to Workspace write mode.'));
        const finish = value => { signal?.removeEventListener('abort', abort); dialog.remove(); resolve(value); };
        const abort = () => { signal?.removeEventListener('abort', abort); dialog.remove(); reject(Object.assign(new Error('Request cancelled'), { code: 'OPERATION_ABORTED' })); };
        const approve = button(readOnly ? (zh ? '切换并下载' : 'Switch to Workspace write and download') : (zh ? '下载' : 'Download'),
          () => finish({ approved: true, permission: readOnly ? 'workspace_write' : permission }));
        dialog.append(approve, button(zh ? '暂不下载' : 'Not now', () => finish({ approved: false, permission })));
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish({ approved: false, permission }); });
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); else approve.focus();
      });
    },
    // Sign-in or a human check in the library browser. The download continues by
    // itself once the browser shows the user is through (autoCheck), or on Continue.
    wait({ jobId, signal, attention = null, language = 'en', autoCheck = null } = {}) {
      return new Promise((resolve, reject) => {
        const zh = language === 'zh';
        const challenge = attention?.kind === 'challenge', mixed = attention?.kind === 'mixed';
        const sites = Array.isArray(attention?.sites) && attention.sites.length ? attention.sites : attention?.site ? [attention.site] : [];
        const dialog = modal(challenge ? (zh ? '请完成网站验证' : 'Complete a website check') : mixed ? (zh ? '请完成登录和网站验证' : 'Sign in and complete website checks') : 'University library sign-in');
        const site = sites.length ? (zh ? `（${sites.join('、')}）` : ` (${sites.join(', ')})`) : '';
        const tabs = sites.length > 1 ? (zh ? ' 每个网站都有一个打开的标签页。' : ' Each site has its own open tab.') : '';
        const waiting = attention?.papers ? (zh ? `${attention.papers} 篇论文正在等待。` : ` ${attention.papers} paper(s) are waiting.`) : '';
        dialog.append(paragraph(challenge
          ? (zh ? `网站${site}要求确认您是真人。请在单独的浏览器窗口中完成验证；完成后下载会自动继续。${tabs}${waiting}`
            : `A website${site} asks to confirm you are human. Complete the check in the separate browser window; the download continues automatically afterwards.${tabs}${waiting}`)
          : mixed
            ? (zh ? `请在单独的浏览器窗口中完成学校登录和网站验证${site}。完成后下载会自动继续。${tabs}${waiting}`
              : `Complete your university sign-in and the website checks in the separate browser window${site}. The download continues automatically afterwards.${tabs}${waiting}`)
            : (zh ? `请在单独的浏览器窗口中完成学校登录和多重验证${site}。进度已保存；登录后下载会自动继续。${tabs}${waiting}`
              : `Complete your university sign-in and MFA directly in the separate browser window${site}. Your progress is saved; the download continues automatically once you are signed in.${tabs}${waiting}`)));
        let settled = false;
        const finish = value => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); dialog.remove(); resolve(value); };
        const abort = () => { if (settled) return; settled = true; dialog.remove(); reject(Object.assign(new Error('Request cancelled'), { code: 'OPERATION_ABORTED' })); };
        dialog.append(button('Continue after sign-in', () => finish(true)), button(zh ? '跳过这些论文' : 'Skip these papers', () => finish(false)));
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
        if (typeof autoCheck === 'function') Promise.resolve().then(autoCheck).then(cleared => { if (cleared) finish(true); }, () => {});
        void jobId;
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
