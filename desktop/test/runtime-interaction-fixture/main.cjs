const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'biodesign-runtime-interaction-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
(async () => {
  try {
    fs.copyFileSync(path.resolve(__dirname, '../../../docs/runtime-interaction.js'), path.join(temporary, 'interaction.js'));
    fs.writeFileSync(path.join(temporary, 'fixture.html'), '<!doctype html><html><body><script src="interaction.js"></script></body></html>');
    await app.whenReady();
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(temporary, 'fixture.html'));
    const passed = await win.webContents.executeJavaScript(`(async () => {
      let count = 0;
      const check = (value, label) => { if (!value) throw new Error(label); count++; };
      const click = text => [...document.querySelectorAll('button')].find(node => node.textContent === text).click();
      let current = true, delivered = 0;
      const ui = BioDesignRuntimeInteraction.create({ document, isCurrent: () => current });
      ui.message('<img src=x onerror="window.executed=true">');
      check(!document.querySelector('img') && !window.executed, 'Model strings render as text');
      ui.plan({ plan: [{ step: 'Read evidence', status: 'pending' }] });
      ui.plan({ plan: [{ step: 'Read evidence', status: 'completed' }] });
      check(document.querySelectorAll('ol').length === 1 && document.querySelector('li').textContent.includes('completed'), 'Plan replaces its previous UI');
      const request = ui.ask({ asynchronous: true, questions: [{ id: 'choice', question: 'Choose a focus', options: [{ label: 'Evidence' }] }], deliver: () => { delivered++; } });
      let answered = false; request.answer.then(() => { answered = true; });
      await Promise.resolve(); check(!answered && delivered === 0, 'No automatic answer');
      click('Evidence'); await Promise.resolve(); check(!answered, 'Choice needs explicit submission');
      click('Send answers'); const result = await request.answer;
      check(result.answers.choice.answers[0] === 'Evidence' && delivered === 1, 'Submission delivers once');
      let full = true;
      const retry = ui.ask({ questions: [{ id: 'retry', question: 'Retry?' }], deliver: () => { if (full) throw new Error('Queue full'); } });
      document.querySelector('textarea').value = 'Keep this answer'; click('Send answers');
      check(document.querySelector('textarea').value === 'Keep this answer' && document.querySelector('[role=alert]').textContent === 'Queue full', 'Queue rejection preserves input');
      full = false; click('Send answers'); check((await retry.answer).answers.retry.answers[0] === 'Keep this answer', 'Retry succeeds');
      const controller = new AbortController();
      const cancelled = ui.ask({ signal: controller.signal, questions: [{ id: 'cancel', question: 'Cancelled?' }] });
      controller.abort(); check(await cancelled.answer === null && !document.querySelector('form'), 'Abort removes question');
      const skipped = ui.ask({ questions: [{ id: 'skip', question: 'Skip?' }] }); click('Skip'); check(await skipped.answer === null, 'Skip grants no answer');
      const approval = ui.confirm({ title: 'Permit scratch execution?' });
      let granted = null; approval.then(value => { granted = value; }); await Promise.resolve(); check(granted === null, 'No implicit permission');
      click('Approve'); check(await approval === true, 'Explicit approval');
      const decline = ui.confirm({ title: 'Import bundle?' }); click('Decline'); check(await decline === false, 'Explicit decline');
      ui.result({ content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }); check(document.querySelector('img').src.startsWith('data:image/png;base64,'), 'Structured image rendering');
      const stale = ui.ask({ questions: [{ id: 'stale', question: 'Old scope?' }] }); current = false;
      document.querySelector('textarea').value = 'answer'; click('Send answers'); check(await stale.answer === null, 'Old source scope cannot answer');
      ui.close(); check(!document.querySelector('.runtime-interaction'), 'Close cleans up');
      return count;
    })()`);
    const { imagePreview } = await import(require('node:url').pathToFileURL(path.resolve(__dirname, '../../services/runtime-image.mjs')));
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
    const preview = imagePreview(require('electron').nativeImage, pixel);
    if (preview.mimeType !== 'image/jpeg' || preview.data.length > 32000) throw new Error('Native image preview failed');
    console.log('RUNTIME_INTERACTION_RESULT ' + JSON.stringify({ passed }));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack || error); app.exit(1); }
  finally { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {} }
})();
