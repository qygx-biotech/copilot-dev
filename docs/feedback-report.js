// Bug reports, after Codex's /feedback: a category, a note, and only the parts
// the user chose, listed before saving. The desktop host adds diagnostics,
// removes secrets and the home folder path, and saves a local file for the user
// to email (desktop/services/feedback-report.mjs). Nothing is uploaded.
(function (root) {
  'use strict';
  const zh = () => document.documentElement.lang.startsWith('zh');
  const say = (en, cn) => zh() ? cn : en;
  const CATEGORIES = [
    ['bug', 'Bug', '问题', 'Crash, error message, hang, or broken behavior', '崩溃、错误信息、卡住或功能异常'],
    ['bad_result', 'Bad result', '结果不佳', 'Output was off-target, incorrect, incomplete, or unhelpful', '输出偏题、错误、不完整或没有帮助'],
    ['good_result', 'Good result', '结果很好', 'Helpful, correct, high-quality result worth celebrating', '有帮助、正确、值得肯定的高质量结果'],
    ['safety_check', 'Blocked by safety', '被安全检查拦截', 'Benign work blocked by safety checks or refusals', '正常工作被安全检查或拒绝拦截'],
    ['other', 'Other', '其他', 'Slowness, feature suggestion, UX feedback, or anything else', '速度慢、功能建议、体验反馈或其他'],
  ];
  // The app supplies the turn's details and conversation for a turn report.
  let resolveTurn = () => ({});
  const element = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };

  function contentsList({ turn, logs, conversation }) {
    return [
      say('The category and your note', '类别和你的说明'),
      say('App version and system (operating system and architecture)', '应用版本和系统（操作系统和架构）'),
      say('Diagnostics: whether a project is open, sandbox and Python runtime state', '诊断：是否打开了项目、沙盒和 Python 运行环境状态'),
      ...(turn ? [say("This turn's activity details (tools, timing and token usage)", '本轮的活动详情（工具、耗时和 token 用量）')] : []),
      ...(logs ? [say('Debug Console events and the app log', '调试控制台事件和应用日志')] : []),
      ...(conversation ? [say("This conversation's text", '本对话的文本')] : []),
    ];
  }

  async function open({ turnId = null, turnDetails = null } = {}) {
    const api = root.biodesignDesktop?.feedback;
    if (!api) throw Object.assign(new Error(say('Bug reports need the BioDesign desktop app.', '问题报告需要 BioDesign 桌面应用。')), { code: 'DESKTOP_APP_REQUIRED' });
    const turn = turnId ? { turnDetails, ...resolveTurn(turnId) } : {};
    const dialog = element('dialog', { className: 'feedback-dialog' });
    dialog.style.cssText = 'max-width:600px;width:calc(100vw - 32px);padding:22px;border:1px solid #bbb;border-radius:12px;color:inherit;background:Canvas';
    const form = element('form', { method: 'dialog' });
    form.append(element('h2', { textContent: turnId ? say('Report this turn', '报告本轮') : say('Report a problem', '报告问题') }));
    const categories = element('fieldset', { className: 'feedback-categories' }, element('legend', { textContent: say('How was this?', '情况如何？') }));
    CATEGORIES.forEach(([value, en, cn, enHint, cnHint], index) => {
      const input = element('input', { type: 'radio', name: 'category', value, checked: index === 0 });
      categories.append(element('label', { className: 'feedback-category' }, input, element('strong', { textContent: ` ${say(en, cn)}` }), element('span', { textContent: ` — ${say(enHint, cnHint)}` })));
    });
    const note = element('textarea', { name: 'note', rows: 4, maxLength: 4000, placeholder: say('What happened, and what did you expect?', '发生了什么？你原本期望什么？') });
    note.setAttribute('aria-label', say('Note', '说明'));
    const logs = element('input', { type: 'checkbox', name: 'includeLogs', checked: true });
    const conversation = element('input', { type: 'checkbox', name: 'includeConversation', checked: false });
    const options = element('fieldset', { className: 'feedback-options' }, element('legend', { textContent: say('Include', '包含') }),
      element('label', {}, logs, document.createTextNode(` ${say('Debug Console events and the app log', '调试控制台事件和应用日志')}`)));
    if (turn.conversation) options.append(element('label', {}, conversation, document.createTextNode(` ${say("This conversation's text", '本对话的文本')}`)));
    const list = element('ul', { className: 'feedback-contents' });
    const renderList = () => list.replaceChildren(...contentsList({ turn: Boolean(turn.turnDetails), logs: logs.checked, conversation: Boolean(turn.conversation) && conversation.checked })
      .map(item => element('li', { textContent: item })));
    logs.addEventListener('change', renderList); conversation.addEventListener('change', renderList); renderList();
    const privacy = element('p', { className: 'feedback-privacy', textContent: say(
      'Keys, tokens and your home folder path are removed. Project files and papers are never included. Nothing is uploaded: you save the file and email it.',
      '密钥、令牌和你的主目录路径会被移除；项目文件和论文永远不会包含在内。不会上传任何内容：你保存文件后通过邮件发送。') });
    const status = element('p', { className: 'feedback-status' }); status.setAttribute('role', 'status');
    const cancel = element('button', { type: 'button', className: 'secondary-button', textContent: say('Cancel', '取消') });
    const save = element('button', { type: 'submit', className: 'primary-button', textContent: say('Save report…', '保存报告…') });
    const actions = element('div', { className: 'feedback-actions' }, cancel, save);
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap';
    form.append(categories, note, options, element('p', { textContent: say('The report will contain:', '报告将包含：') }), list, privacy, status, actions);
    dialog.append(form); document.body.append(dialog); dialog.showModal();

    return new Promise(resolve => {
      let result = null;
      const close = () => { dialog.close(); dialog.remove(); resolve(result); };
      cancel.addEventListener('click', close);
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (result?.saved) return close();
        save.disabled = true; status.textContent = say('Preparing the report…', '正在准备报告…');
        try {
          const include = { logs: logs.checked, conversation: Boolean(turn.conversation) && conversation.checked };
          const response = await api.save({
            category: form.elements.category.value, note: note.value, includeLogs: include.logs, includeConversation: include.conversation, language: zh() ? 'zh' : 'en',
            ...(include.logs ? { rendererLog: (root.BioDesignRuntimeLog?.entries?.() || []).slice(-1000) } : {}),
            ...(turn.turnDetails ? { turnDetails: turn.turnDetails } : {}),
            ...(include.conversation ? { conversation: turn.conversation } : {}),
          });
          if (!response.saved) { status.textContent = say('Not saved.', '未保存。'); save.disabled = false; return; }
          result = response;
          status.textContent = say(`Saved ${response.fileName} (report ${response.id.slice(0, 8)}). Attach it to an email to the BioDesign team.`,
            `已保存 ${response.fileName}（报告 ${response.id.slice(0, 8)}）。请将其作为附件发送给 BioDesign 团队。`);
          const show = element('button', { type: 'button', className: 'secondary-button', textContent: say('Show in folder', '在文件夹中显示') });
          show.addEventListener('click', () => api.reveal().catch(() => {}));
          cancel.remove(); actions.prepend(show);
          save.textContent = say('Close', '关闭'); save.disabled = false;
        } catch (error) {
          status.textContent = say(`The report could not be saved (${error?.code || 'ERROR'}).`, `无法保存报告（${error?.code || 'ERROR'}）。`);
          save.disabled = false;
        }
      });
    });
  }

  root.BioDesignFeedback = Object.freeze({ open, setTurnResolver(resolver) { resolveTurn = typeof resolver === 'function' ? resolver : () => ({}); } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
