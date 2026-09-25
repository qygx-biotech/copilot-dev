// Production React bundle + app.js + sandboxed preload + validated IPC + real
// project files. Only FC/preparation and source HTTP bytes are test doubles.
const { app, BrowserWindow, ipcMain, clipboard, ClipboardItem, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'biodesign-react-ui-'));
const projectA = path.join(profile, 'Enzyme Engineering');
const projectB = path.join(profile, 'Separate Project');
for (const project of [projectA, projectB]) { fs.mkdirSync(path.join(project, 'literature'), { recursive: true }); fs.writeFileSync(path.join(project, 'literature/evidence.pdf'), '%PDF-1.7\nfixture evidence\n%%EOF'); }
// A pre-association project keeps its original history files and is assigned a
// single legacy owner when opened by the desktop shell.
const legacyChat = { schemaVersion: 1, id: 'legacy-side', title: 'Earlier project discussion', summary: '', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', messages: [{ id: 'legacy-message', role: 'user', content: 'Existing legacy evidence discussion', createdAt: '2026-09-01T00:00:00.000Z' }] };
fs.mkdirSync(path.join(projectB, '.biodesign/chat/conversations'), { recursive: true });
fs.writeFileSync(path.join(projectB, '.biodesign/chat/conversations/legacy-side.json'), JSON.stringify(legacyChat));
fs.writeFileSync(path.join(projectB, '.biodesign/chat/index.json'), JSON.stringify({ schemaVersion: 1, activeConversationId: legacyChat.id, updatedAt: legacyChat.updatedAt, conversations: [{ ...legacyChat, messages: undefined, messageCount: 1 }] }));
fs.mkdirSync(path.join(projectB, '.biodesign/literature'), { recursive: true });
fs.writeFileSync(path.join(projectB, '.biodesign/literature/index.json'), JSON.stringify({ schemaVersion: 1, documents: [], updatedAt: legacyChat.updatedAt }));
fs.writeFileSync(path.join(projectB, '.biodesign/state.json'), JSON.stringify({ schemaVersion: 1, project: { goal: '' }, ui: {}, agent: {}, memory: {}, updatedAt: legacyChat.updatedAt }));
fs.writeFileSync(path.join(projectB, '.biodesign/workspace.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'legacy-project-b', name: 'Separate Project', createdAt: legacyChat.createdAt, updatedAt: legacyChat.updatedAt }));
app.setPath('userData', path.join(profile, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
let win, sessions, dispose;
const errors = [];
(async () => {
  try {
    await app.whenReady();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const { ProjectSessionManager } = await import(pathToFileURL(path.join(root, 'desktop/services/project-session.mjs')));
    const { ProjectCatalog } = await import(pathToFileURL(path.join(root, 'desktop/services/project-catalog.mjs')));
    const { registerIpcHandlers } = await import(pathToFileURL(path.join(root, 'desktop/ipc/register-handlers.mjs')));
    const { downloadSources } = await import(pathToFileURL(path.join(root, 'desktop/services/source-downloader.mjs')));
    sessions = new ProjectSessionManager({ appPath: root });
    sessions.initializeKnowledge = async () => ({ available: false });
    const open = sessions.open.bind(sessions);
    sessions.open = async project => {
      const result = await open(project);
      const active = sessions.active;
      active.execution.register({ id: 'download_sources', effect: 'source_write' }, (input, context) => downloadSources(input,
        { ...context, signal: active.sourceDownloads.signal, isCurrent: () => sessions.active === active },
        { localFetch: async url => ({ bytes: Buffer.from('%PDF-1.7\nfixture paper\n%%EOF'), contentType: 'application/pdf', resolvedUrl: url, contentDisposition: '' }) }));
      return result;
    };
    const folders = [projectA, projectB];
    let pickerCount = 0;
    win = new BrowserWindow({ width: 1540, height: 1020, show: false, webPreferences: { preload: path.join(root, 'desktop/preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error' && !event.message.startsWith('[BioDesign]')) errors.push(event.message); });
    win.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message));
    // No real remote requests in this fixture.
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
    dispose = registerIpcHandlers({ ipcMain, sessionManager: sessions, getWindow: () => win,
      writeClipboardText: async text => {
        // Exercise native clipboard access, then immediately restore its formats.
        const previous = await Promise.all((await clipboard.read()).map(async item =>
          new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
        let copied;
        try {
          await clipboard.writeText(text);
          copied = await clipboard.readText();
          if (copied !== text) throw new Error('Native clipboard text did not match the copied transcript');
        } finally {
          if (previous.length) await clipboard.write(previous);
          else clipboard.clear();
        }
        await win.webContents.executeJavaScript(`window.copiedChats.push(${JSON.stringify(copied)})`);
      },
      projectCatalog: new ProjectCatalog(path.join(profile, 'projects')),
      dialog: { showOpenDialog: async () => { pickerCount++; return { canceled: false, filePaths: [folders.shift()] }; } },
      runtimeInfo: () => ({ version: 'test', updates: { eligible: false, canCheck: false } }), openExternal: async () => {} });
    let renderer = path.join(root, 'docs/desktop.html');
    if (process.argv.includes('asar')) {
      const archive = path.join(profile, 'renderer.asar');
      await require('@electron/asar').createPackage(path.join(root, 'docs'), archive);
      renderer = path.join(archive, 'desktop.html');
    }
    await win.loadFile(renderer);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'scenarios.js'), 'utf8') + '\nvoid 0;');
    await win.webContents.executeJavaScript('runWorkbenchHome()');
    if (pickerCount !== 0) throw new Error('Startup unexpectedly opened the folder picker');
    const homeImage = path.join(profile, 'new-chat.png');
    fs.writeFileSync(homeImage, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('runWorkbenchScenarios()');
    const screenshots = [homeImage];
    for (const label of ['Resize sidebar', 'Resize Side Chat and Agent Work']) {
      const selector = `[aria-label="${label}"]`;
      const position = await win.webContents.executeJavaScript(`(() => { const node = document.querySelector(${JSON.stringify(selector)}), rect = node.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), value: node.getAttribute('aria-valuenow') }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: position.x, y: position.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: position.x, y: position.y });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: position.x + 30, y: position.y });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: position.x + 30, y: position.y });
      await win.webContents.executeJavaScript(`waitFor(() => document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-valuenow') !== ${JSON.stringify(position.value)}, 'native pointer resize'); check(true, ${JSON.stringify(label + ' works with native pointer input')}); document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`);
    }
    for (const width of [1540, 1100, 768, 390]) {
      win.setSize(width, 1020);
      await win.webContents.executeJavaScript(`checkWorkbenchLayout(${width})`);
      const filename = path.join(profile, `workbench-${width}.png`);
      fs.writeFileSync(filename, (await win.webContents.capturePage()).toPNG()); screenshots.push(filename);
    }
    win.setSize(1540, 1020);
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Toggle sidebar"]').click(); document.querySelector('.agent-result-actions details').open = true; document.querySelector('.agent-result-actions details').scrollIntoView({ block: 'start' }); document.querySelector('.side-pane .turn-activity').open = true; tick();`);
    const reviewImage = path.join(profile, 'recommendation-and-activity.png');
    fs.writeFileSync(reviewImage, (await win.webContents.capturePage()).toPNG()); screenshots.push(reviewImage);
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Side Chat history"]').click(); tick()`);
    const historyImage = path.join(profile, 'history-dropdown.png');
    fs.writeFileSync(historyImage, (await win.webContents.capturePage()).toPNG()); screenshots.push(historyImage);
    await win.webContents.executeJavaScript(`requestChatDeletion(document.querySelector('[role="option"][aria-selected="true"]'))`);
    const deleteImage = path.join(profile, 'delete-confirmation.png');
    fs.writeFileSync(deleteImage, (await win.webContents.capturePage()).toPNG()); screenshots.push(deleteImage);
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Delete chat"] .secondary-button').click(); tick()`);
    await win.webContents.executeJavaScript(`openGoalMenu('Enzyme Engineering')`);
    const menuImage = path.join(profile, 'project-menu.png');
    fs.writeFileSync(menuImage, (await win.webContents.capturePage()).toPNG()); screenshots.push(menuImage);
    await win.webContents.executeJavaScript(`document.querySelector('[role="menuitem"]').click(); waitFor(() => snapshot().goalEditor && !snapshot().projectBusy, 'goal visual review').then(tick)`);
    const goalImage = path.join(profile, 'project-goal.png');
    fs.writeFileSync(goalImage, (await win.webContents.capturePage()).toPNG()); screenshots.push(goalImage);
    const result = await win.webContents.executeJavaScript('({ passed: window.passed, failed: window.failed })');
    const state = JSON.parse(fs.readFileSync(path.join(projectA, '.biodesign/state.json'), 'utf8'));
    const files = fs.readdirSync(path.join(projectA, 'literature'));
    if (!files.includes('enzyme-paper.pdf')) result.failed.push('download did not create an actual PDF');
    if (files.includes('side-only.pdf')) result.failed.push('Side Chat executed a forbidden download');
    if (state.agent?.workbench?.panels?.length < 1) result.failed.push('Agent Work was not saved in project state');
    if (state.project.goal !== 'Compare enzyme variants at matched pH.') result.failed.push('Project goal was not persisted in existing project state');
    if (JSON.parse(fs.readFileSync(path.join(projectB, '.biodesign/state.json'), 'utf8')).project.goal !== 'Review the separate project evidence.') result.failed.push('Inactive project goal was not saved to the correct folder');
    if (pickerCount !== 2) result.failed.push('Remembered projects unexpectedly reopened the folder picker');
    console.log('REACT_WORKBENCH_RESULT ' + JSON.stringify({ ...result, screenshots, errors, projectA, projectB }));
    dispose(); await sessions.close(); win.destroy(); app.exit(result.failed.length || errors.length ? 1 : 0);
  } catch (error) { console.error(error.stack, errors, await win?.webContents.executeJavaScript('({ checks: window.passed?.slice(-6), navigationError: window.BioDesignFrontend?.getSnapshot().projectError, alerts: [...document.querySelectorAll("[role=alert]")].map(node => node.textContent), clipboardBridge: typeof window.biodesignDesktop?.clipboard?.writeText })').catch(() => ({}))); dispose?.(); await sessions?.close().catch(() => {}); app.exit(1); }
})();
