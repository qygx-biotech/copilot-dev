import React, { useEffect, useRef, useState } from 'react';
import './runtime-extensions.css';

const skillTemplate = '---\nname: my-skill\ndescription: Describe when the agent should use this skill.\nalways: false\n---\n\n# Instructions\n\nDescribe the workflow, expected evidence, and desired output.\n';
const mcpTemplate = { transport: 'stdio', command: '', args: [], enabledTools: [], timeoutMs: 30000 };

async function workflow(workflowId, input = {}) {
  const execution = window.biodesignDesktop?.execution;
  if (!execution?.runWorkflow) throw new Error('Open a desktop project to manage runtime extensions.');
  return execution.runWorkflow({ workflowId, input });
}

function SkillSettings({ zh }) {
  const [skills, setSkills] = useState([]), [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [editor, setEditor] = useState(null);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [removeName, setRemoveName] = useState('');
  const fileInput = useRef(null);
  const visibleSkills = skills.filter(skill => (!query || `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || filter === 'enabled' && skill.enabled || filter === 'unavailable' && !skill.available));
  const refresh = async () => {
    const result = await workflow('runtime_skills_list');
    setSkills(result.skills || []); setErrors(result.errors || []);
  };
  const act = async operation => {
    setBusy(true); setError('');
    try { await operation(); }
    catch (failure) { setError(failure.message || String(failure)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void act(refresh); }, []);
  const edit = skill => act(async () => {
    const result = await workflow('runtime_skills_read', { name: skill.name });
    setEditor({ name: skill.name, content: result.content, existing: true });
  });
  const save = event => {
    event.preventDefault();
    void act(async () => {
      await workflow(editor.imported ? 'runtime_skills_import' : 'runtime_skills_save', { name: editor.name, content: editor.content });
      await refresh(); setEditor(null);
    });
  };
  return <section aria-label={zh ? '技能设置' : 'Skill settings'}>
    <div className="runtime-section-heading"><p>{zh ? '使用 $技能名称 调用技能。标记为 always 的技能会自动加载，其余技能按需读取。' : 'Invoke a skill with $skill-name. Always-active skills load automatically; other instructions load when needed.'}</p><button className="secondary-button" disabled={busy} onClick={() => setEditor({ name: 'my-skill', content: skillTemplate, existing: false })}>{zh ? '新建技能' : 'New skill'}</button><button className="secondary-button" disabled={busy} onClick={() => fileInput.current?.click()}>{zh ? '导入 SKILL.md' : 'Import SKILL.md'}</button></div>
    <input type="file" ref={fileInput} hidden accept=".md,text/markdown" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void act(async () => { if (file.size > 65536) throw new Error('Each skill is limited to 64 KiB.'); const content = await file.text(); const name = /^name:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(content)?.[1] || 'imported-skill'; setEditor({ name, content, existing: false, imported: true }); }); }} />
    <p>{zh ? '技能仅提供指令；项目范围、证据检查和工具权限仍由 BioDesign 控制。项目覆盖保存在 .biodesign/skills。' : 'Skills supply instructions. BioDesign still enforces project scope, evidence checks, and tool permissions. Project overrides are saved under .biodesign/skills.'}</p>
    {error && <p className="runtime-error" role="alert">{error}</p>}
    {errors.map((item, index) => <p key={`${item.path}-${index}`} className="runtime-error" role="alert">{item.path}: {item.message}</p>)}
    {editor ? <form className="runtime-editor" onSubmit={save}>
      {editor.imported && <p>{zh ? '导入后默认禁用。检查指令后再启用；不会覆盖现有技能，也不会运行安装脚本。' : 'Imports start disabled. Review the instructions before enabling. Existing skills are never overwritten and installation scripts are never run.'}</p>}
      <label>{zh ? '名称' : 'Name'}<input autoFocus value={editor.name} disabled={busy || editor.existing} maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" required onChange={event => {
        const name = event.target.value;
        setEditor(current => ({ ...current, name, content: current.content.replace(/^name:.*$/m, `name: ${name}`) }));
      }} /></label>
      <label>SKILL.md<textarea aria-label="Skill Markdown" className="runtime-code" rows={14} value={editor.content} maxLength={65536} disabled={busy} required spellCheck={false} onChange={event => setEditor({ ...editor, content: event.target.value })} /></label>
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditor(null)}>{zh ? '取消' : 'Cancel'}</button><button className="primary-button" disabled={busy}>{zh ? '保存技能' : 'Save skill'}</button></div>
    </form> : <><div className="runtime-filters"><input aria-label={zh ? '搜索技能' : 'Search skills'} type="search" value={query} placeholder={zh ? '搜索技能…' : 'Search skills…'} onChange={event => setQuery(event.target.value)} /><select aria-label={zh ? '技能筛选' : 'Skill filter'} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{zh ? '全部' : 'All'}</option><option value="enabled">{zh ? '已启用' : 'Enabled'}</option><option value="unavailable">{zh ? '缺少依赖' : 'Unavailable'}</option></select></div><div className="runtime-items" aria-busy={busy}>
      {visibleSkills.map(skill => <article className="runtime-item" key={skill.name}>
        <div className="runtime-item-heading"><strong>${skill.name}</strong><label className="runtime-toggle"><input type="checkbox" aria-label={`${zh ? '启用' : 'Enable'} ${skill.name}`} checked={skill.enabled} disabled={busy || skill.invalid} onChange={event => { const enabled = event.target.checked; void act(async () => { await workflow('runtime_skills_enable', { name: skill.name, enabled }); await refresh(); }); }} />{zh ? '启用' : 'Enabled'}</label></div>
        <p>{skill.description}</p><small>{skill.path}{skill.always ? ` · ${zh ? '自动加载' : 'always active'}` : ''}{skill.source === 'bundled' ? ` · ${zh ? '内置' : 'bundled'}` : ''}</small>
        {!skill.available && <p className="runtime-error">{skill.invalid ? (zh ? '技能元数据无效。' : 'Invalid skill metadata.') : `${zh ? '缺少依赖' : 'Missing requirements'}: ${[...(skill.missing?.bins || []).map(name => `${name} (binary)`), ...(skill.missing?.env || []).map(name => `${name} (env)`)].join(', ')}`}</p>}
        <button className="secondary-button" disabled={busy || skill.invalid} onClick={() => void edit(skill)}>{skill.source === 'bundled' ? (zh ? '查看 / 创建项目覆盖' : 'View / customize for project') : (zh ? '查看 / 编辑' : 'View / edit')}</button>
        {skill.removable && <button className="secondary-button" disabled={busy} onClick={() => setRemoveName(skill.name)}>{zh ? '移除' : 'Remove'}</button>}
        {removeName === skill.name && <div className="runtime-remove"><p>{zh ? '移除此项目管理的技能及其文件？同名的仓库或内置技能将保持禁用。' : 'Remove this managed skill and its files? Any repository or bundled fallback with the same name will stay disabled.'}</p><button className="secondary-button" onClick={() => setRemoveName('')}>{zh ? '保留' : 'Keep'}</button><button className="secondary-button" disabled={busy} onClick={() => void act(async () => { await workflow('runtime_skills_remove', { name: skill.name }); setRemoveName(''); await refresh(); })}>{zh ? '确认移除' : 'Confirm removal'}</button></div>}
      </article>)}
      {!busy && !skills.length && <p>{zh ? '尚无技能。新建技能，或将 SKILL.md 放入 skills/技能名称/。' : 'No skills yet. Create one here or place SKILL.md in skills/skill-name/.'}</p>}
      {!busy && skills.length > 0 && !visibleSkills.length && <p>{zh ? '没有匹配的技能。' : 'No matching skills.'}</p>}
    </div></>}
  </section>;
}

function McpSettings({ zh, initialPreset }) {
  const [servers, setServers] = useState([]), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [editor, setEditor] = useState(null), [removeName, setRemoveName] = useState('');
  const refresh = async () => { const result = await workflow('runtime_mcp_list'); setServers(result.servers || []); };
  const act = async operation => {
    setBusy(true); setError('');
    try { await operation(); }
    catch (failure) { setError(failure.message || String(failure)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void act(refresh); }, []);
  const edit = server => {
    const { enabled, allowLocalhost, env, headers, ...config } = server?.config || mcpTemplate;
    setEditor({ name: server?.name || '', config: JSON.stringify(config, null, 2), enabled: enabled === true, allowLocalhost: allowLocalhost === true, secrets: '', headers: '', existing: Boolean(server?.name), envKeys: server?.envKeys || [], headerKeys: server?.headerKeys || [] });
    setError('');
  };
  useEffect(() => { if (initialPreset) edit({ config: initialPreset.config, name: '' }); }, [initialPreset]);
  const save = event => {
    event.preventDefault();
    void act(async () => {
      const config = JSON.parse(editor.config);
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(zh ? '配置必须是 JSON 对象。' : 'Configuration must be a JSON object.');
      // The explicit switches own activation and local endpoint authorization.
      config.enabled = editor.enabled; config.allowLocalhost = editor.allowLocalhost;
      if (editor.secrets.trim()) config.env = JSON.parse(editor.secrets);
      if (editor.headers.trim()) config.headers = JSON.parse(editor.headers);
      await workflow('runtime_mcp_save', { name: editor.name, config });
      await refresh(); setEditor(null);
    });
  };
  return <section aria-label="MCP plugin settings">
    <div className="runtime-section-heading"><p>{zh ? '为此项目连接额外的 MCP 服务。内置论文与浏览器服务继续由 BioDesign 管理。' : 'Connect additional MCP servers for this project. BioDesign continues to manage its integrated paper and browser services.'}</p><button className="secondary-button" disabled={busy} onClick={() => edit(null)}>{zh ? '添加 MCP' : 'Add MCP'}</button></div>
    <p>{zh ? '插件工具仅供具有完整访问权限的 Agent Work 使用。保存后点击连接；enabledTools 使用工具名称数组，或 ["*"] 允许全部。空数组不允许任何工具。' : 'Plugin tools are available to Agent Work with Full access. Save, then connect. Set enabledTools to tool names, or ["*"] to allow all; [] allows none.'}</p>
    {error && <p className="runtime-error" role="alert">{error}</p>}
    {editor ? <form className="runtime-editor" onSubmit={save}>
      <label>{zh ? '服务名称' : 'Server name'}<input autoFocus value={editor.name} maxLength={32} required pattern="[a-z][a-z0-9_-]*" disabled={busy || editor.existing} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
      <label>{zh ? 'JSON 配置' : 'JSON configuration'}<textarea aria-label="MCP JSON configuration" className="runtime-code" rows={12} value={editor.config} maxLength={32768} disabled={busy} spellCheck={false} onChange={event => setEditor({ ...editor, config: event.target.value })} /></label>
      <p>{zh ? 'transport 支持 stdio、sse 和 streamableHttp。远程服务使用 url；本地程序使用 command 与 args。' : 'transport accepts stdio, sse, or streamableHttp. Use url for a remote service, or command and args for a local program.'}</p>
      <label className="runtime-toggle"><input type="checkbox" checked={editor.enabled} disabled={busy} onChange={event => setEditor({ ...editor, enabled: event.target.checked })} />{zh ? '允许此 MCP 服务' : 'Enable this MCP server'}</label>
      <label className="runtime-toggle"><input type="checkbox" checked={editor.allowLocalhost} disabled={busy} onChange={event => setEditor({ ...editor, allowLocalhost: event.target.checked })} />{zh ? '允许连接本机 HTTP 服务' : 'Allow localhost HTTP endpoints'}</label>
      <label>{zh ? '替换环境变量（JSON，可选）' : 'Replace environment variables (optional JSON)'}<input type="password" autoComplete="new-password" aria-label="MCP environment JSON" value={editor.secrets} maxLength={32768} disabled={busy} placeholder='{"API_KEY":"…"}' onChange={event => setEditor({ ...editor, secrets: event.target.value })} /></label>
      <p>{zh ? '留空以保留现有变量；输入 {} 清除。值仅保存在本机项目配置中，不回传模型。' : 'Leave blank to keep existing variables; enter {} to clear them. Values stay in the local project configuration and are not sent to the model.'}{editor.envKeys.length ? ` ${zh ? '现有变量' : 'Existing keys'}: ${editor.envKeys.join(', ')}` : ''}</p>
      <label>{zh ? '替换 HTTP 请求头（JSON，可选）' : 'Replace HTTP headers (optional JSON)'}<input type="password" autoComplete="new-password" aria-label="MCP headers JSON" value={editor.headers} maxLength={32768} disabled={busy} placeholder='{"Authorization":"Bearer …"}' onChange={event => setEditor({ ...editor, headers: event.target.value })} /></label>
      <p>{zh ? '留空以保留现有请求头；输入 {} 清除。OAuth 登录暂不支持。' : 'Leave blank to keep existing headers; enter {} to clear them. OAuth sign-in is not supported yet.'}{editor.headerKeys.length ? ` ${zh ? '现有请求头' : 'Existing headers'}: ${editor.headerKeys.join(', ')}` : ''}</p>
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditor(null)}>{zh ? '取消' : 'Cancel'}</button><button className="primary-button" disabled={busy}>{zh ? '保存配置' : 'Save configuration'}</button></div>
    </form> : <div className="runtime-items" aria-busy={busy}>
      {servers.map(server => <article className="runtime-item" key={server.name}>
        <div className="runtime-item-heading"><strong>{server.name}</strong><span className="runtime-status">{server.status || 'disconnected'} · {server.config?.enabled ? (zh ? '已启用' : 'enabled') : (zh ? '已禁用' : 'disabled')}</span></div>
        <small>{server.config?.transport} · {server.config?.url || server.config?.command}</small>
        {server.error && <p className="runtime-error" role="alert">{typeof server.error === 'string' ? server.error : server.error.message || server.error.code}</p>}
        {server.tools?.length > 0 && <details><summary>{server.tools.length} {zh ? '个工具' : 'tools'}</summary><ul>{server.tools.map(tool => <li key={tool.name}><strong title={tool.name}>{tool.rawName || tool.name}</strong>{tool.description ? ` — ${tool.description}` : ''}</li>)}</ul></details>}
        <div className="runtime-item-actions"><button className="secondary-button" disabled={busy} onClick={() => edit(server)}>{zh ? '编辑' : 'Edit'}</button><button className="secondary-button" disabled={busy || (!server.config?.enabled && server.status !== 'connected')} onClick={() => void act(async () => { await workflow(server.status === 'connected' ? 'runtime_mcp_disconnect' : 'runtime_mcp_connect', { name: server.name }); await refresh(); })}>{server.status === 'connected' ? (zh ? '断开' : 'Disconnect') : (zh ? '连接' : 'Connect')}</button><button className="secondary-button" disabled={busy} onClick={() => setRemoveName(server.name)}>{zh ? '移除' : 'Remove'}</button></div>
        {removeName === server.name && <div className="runtime-remove"><p>{zh ? '移除此项目的连接配置？' : 'Remove this project’s connection configuration?'}</p><button className="secondary-button" disabled={busy} onClick={() => setRemoveName('')}>{zh ? '保留' : 'Keep'}</button><button className="secondary-button" disabled={busy} onClick={() => void act(async () => { await workflow('runtime_mcp_remove', { name: server.name }); setRemoveName(''); await refresh(); })}>{zh ? '确认移除' : 'Confirm removal'}</button></div>}
      </article>)}
      {!busy && !servers.length && <p>{zh ? '尚未配置额外的 MCP 服务。' : 'No additional MCP servers configured.'}</p>}
    </div>}
  </section>;
}

const bundleExample = JSON.stringify({ version: 1, id: 'research-guide', name: 'Research guide', description: 'Local instructions and optional MCP configuration.', skills: [{ name: 'research-guide', path: 'research-guide/SKILL.md' }], mcpServers: [] }, null, 2);

function AppsSettings({ zh, configureMcp, selectTab }) {
  const [catalog, setCatalog] = useState({ apps: [], presets: [] }), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [manifestPath, setManifestPath] = useState(''), [preview, setPreview] = useState(null);
  const refresh = async () => setCatalog(await workflow('runtime_apps_list'));
  const act = async operation => { setBusy(true); setError(''); try { await operation(); } catch (failure) { setError(failure.message || String(failure)); } finally { setBusy(false); } };
  useEffect(() => { void act(refresh); }, []);
  const apps = catalog.apps.filter(app => (!query || `${app.name} ${app.description}`.toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || filter === 'enabled' && app.enabled || filter === 'ready' && ['connected', 'integrated'].includes(app.status)));
  return <section aria-label={zh ? '应用目录' : 'Apps catalog'}>
    <p>{zh ? '现有文献和浏览器集成保持原样。额外应用可以组合技能与 MCP 连接；每个成员独立启用。' : 'The existing paper and browser integrations remain available. Additional Apps can combine skills and MCP connections, with each member enabled independently.'}</p>
    {error && <p className="runtime-error" role="alert">{error}</p>}
    <div className="runtime-filters"><input type="search" aria-label={zh ? '搜索应用' : 'Search Apps'} placeholder={zh ? '搜索应用…' : 'Search Apps…'} value={query} onChange={event => setQuery(event.target.value)} /><select aria-label={zh ? '应用筛选' : 'App filter'} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{zh ? '全部' : 'All'}</option><option value="ready">{zh ? '已连接 / 内置' : 'Ready'}</option><option value="enabled">{zh ? '已启用' : 'Enabled'}</option></select></div>
    <div className="runtime-items" aria-busy={busy}>{apps.map(app => <article key={app.id} className="runtime-item"><div className="runtime-item-heading"><strong>{app.name}</strong><span className="runtime-status">{app.status}</span></div><p>{app.description}</p>
      {app.kind === 'mcp' && <button className="secondary-button" onClick={() => selectTab('mcp')}>{zh ? '管理连接' : 'Manage connection'}</button>}
      {app.kind === 'bundle' && <><small>{zh ? '技能' : 'Skills'}: {app.skills.join(', ') || '—'} · MCP: {app.servers.join(', ') || '—'}</small><div className="runtime-item-actions"><button className="secondary-button" onClick={() => selectTab('skills')}>{zh ? '管理技能' : 'Manage skills'}</button><button className="secondary-button" onClick={() => selectTab('mcp')}>{zh ? '管理 MCP' : 'Manage MCP'}</button></div></>}
    </article>)}</div>
    {!busy && !apps.length && <p>{zh ? '没有匹配的应用。' : 'No matching Apps.'}</p>}
    <h3>{zh ? '连接模板' : 'Connection templates'}</h3><div className="runtime-preset-grid">{catalog.presets.map(preset => <article className="runtime-item" key={preset.id}><strong>{preset.name}</strong><p>{preset.description}</p><button className="secondary-button" onClick={() => configureMcp(preset)}>{zh ? '配置' : 'Configure'}</button></article>)}</div>
    <h3>{zh ? '导入本地应用包' : 'Import a local App bundle'}</h3>
    <p>{zh ? '选择项目内的 JSON 清单路径。预览后导入；所有成员默认禁用，不执行程序或安装脚本。MCP 的凭据在连接设置中单独填写。' : 'Enter a JSON manifest path inside this project, preview, then import. Every member starts disabled. Import runs no programs or installation scripts; MCP credentials are entered separately in connection settings.'}</p>
    <form className="runtime-editor" onSubmit={event => { event.preventDefault(); void act(async () => setPreview(await workflow('runtime_apps_inspect', { path: manifestPath }))); }}><label>{zh ? '项目内的清单路径' : 'Project-relative manifest path'}<input required placeholder="plugins/research/app.json" value={manifestPath} onChange={event => { setManifestPath(event.target.value); setPreview(null); }} /></label><button className="secondary-button" disabled={busy}>{zh ? '预览应用包' : 'Preview bundle'}</button></form>
    <details className="runtime-example"><summary>{zh ? '清单格式示例' : 'Manifest format example'}</summary><pre>{bundleExample}</pre><p>{zh ? 'mcpServers 支持 {name, config} 条目；config 与 MCP 设置一致，但不包含 enabled、env 或 headers。每个技能路径相对于清单，且必须是 SKILL.md。导入仅复制指令文件。' : 'mcpServers accepts {name, config} entries using MCP connection fields, excluding enabled, env, and headers. Each skill path is relative to this manifest and must end in SKILL.md. Import copies instruction files only.'}</p></details>
    {preview && <article className="runtime-item"><strong>{preview.name}</strong><p>{preview.description}</p><ul>{preview.skills.map(skill => <li key={`skill-${skill.name}`}>${skill.name} — {skill.description}</li>)}{preview.servers.map(server => <li key={`mcp-${server.name}`}>{server.name}: {server.config.url || `${server.config.command} ${server.config.args.join(' ')}`}<small>{zh ? '允许工具' : 'Allowed tools'}: {server.config.enabledTools.join(', ') || 'none'}{server.config.allowLocalhost ? ' · localhost allowed' : ''}</small></li>)}</ul>{preview.conflicts.map(conflict => <p role="alert" className="runtime-error" key={conflict}>{conflict}</p>)}<button className="primary-button" disabled={busy || preview.conflicts.length > 0} onClick={() => void act(async () => { await workflow('runtime_apps_install', { path: preview.path, expectedDigest: preview.digest }); setPreview(null); setManifestPath(''); await refresh(); })}>{zh ? '导入（保持禁用）' : 'Import disabled'}</button></article>}
  </section>;
}

function WorkbenchSettings({ zh, close }) {
  const [presets, setPresets] = useState([]), [editor, setEditor] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(true);
  const refresh = async () => setPresets((await workflow('runtime_settings_read')).presets);
  const act = async operation => { setBusy(true); setError(''); try { await operation(); } catch (failure) { setError(failure.message || String(failure)); } finally { setBusy(false); } };
  useEffect(() => { void act(refresh); }, []);
  return <section aria-label={zh ? '工作台设置' : 'Workbench settings'}><div className="runtime-section-heading"><p>{zh ? '为现有 Requesty 模型保存项目预设。权限、来源范围和账户路由保持现有设置。' : 'Save named project presets for existing Requesty models. Presets keep the current permissions, source scope, and account routing.'}</p><button className="secondary-button" disabled={busy} onClick={() => setEditor({ id: '', name: '', modelId: '' })}>{zh ? '新建预设' : 'New preset'}</button></div>{error && <p className="runtime-error" role="alert">{error}</p>}
    {editor && <form className="runtime-editor" onSubmit={event => { event.preventDefault(); void act(async () => { await workflow('runtime_settings_save', { id: editor.id, name: editor.name, modelId: editor.modelId }); setEditor(null); await refresh(); }); }}><label>{zh ? '预设名称' : 'Preset name'}<input required maxLength={80} value={editor.name} onChange={event => { const name = event.target.value; setEditor({ ...editor, name, id: editor.existing ? editor.id : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'model-preset' }); }} /></label><label>Requesty model ID<input required maxLength={256} value={editor.modelId} placeholder="provider/model-id" onChange={event => setEditor({ ...editor, modelId: event.target.value })} /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setEditor(null)}>{zh ? '取消' : 'Cancel'}</button><button className="primary-button" disabled={busy}>{zh ? '保存' : 'Save preset'}</button></div></form>}
    <div className="runtime-items">{presets.map(preset => <article className="runtime-item" key={preset.id}><strong>{preset.name}</strong><small>{preset.modelId}</small><div className="runtime-item-actions"><button className="primary-button" disabled={busy} onClick={() => { window.dispatchEvent(new CustomEvent('biodesign:model-preset', { detail: { name: preset.name, modelId: preset.modelId } })); close(); }}>{zh ? '应用预设' : 'Use preset'}</button><button className="secondary-button" disabled={busy} onClick={() => setEditor({ ...preset, existing: true })}>{zh ? '编辑' : 'Edit'}</button><button className="secondary-button" disabled={busy} onClick={() => void act(async () => { await workflow('runtime_settings_remove', { id: preset.id }); await refresh(); })}>{zh ? '移除' : 'Remove'}</button></div></article>)}</div>{!busy && !presets.length && <p>{zh ? '尚未保存模型预设。' : 'No model presets saved yet.'}</p>}
  </section>;
}

// Memory across this project's conversations (docs/project-memory.js), after
// Codex's memories settings: off by default, viewable, and forgettable.
const memoryCommand = (name, payload = {}) => window.BioDesignFrontend.command(name, { projectId: window.BioDesignFrontend.getSnapshot().project?.id, ...payload });
function MemorySettings({ zh }) {
  const [view, setView] = useState(null), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [showing, setShowing] = useState(false), [confirmForget, setConfirmForget] = useState(false);
  const refresh = async () => setView(await memoryCommand('memory.view'));
  const act = async operation => { setBusy(true); setError(''); try { await operation(); } catch (failure) { setError(failure.message || String(failure)); } finally { setBusy(false); } };
  useEffect(() => { void act(refresh); }, []);
  const status = view?.status, when = value => value ? new Date(value).toLocaleString() : (zh ? '从未' : 'never');
  return <section aria-label={zh ? '项目记忆' : 'Project memory'} className="memory-settings">
    <div className="runtime-section-heading"><p>{zh
      ? '开启后，BioDesign 会总结本项目中已结束的对话，并把值得记住的内容（你的偏好、项目约定、决定和经验）保存在 .biodesign/memory/。新对话会带上一份简短摘要，并可以搜索记忆。记忆是以往对话的上下文，不是证据。开启后会再次把以往对话发送给模型，这会消耗 token。'
      : 'When this is on, BioDesign summarizes finished conversations in this project and keeps what is worth remembering — your preferences, project conventions, decisions and lessons — in .biodesign/memory/. New conversations start with a short summary and can search the rest. Memories are earlier conversation context, not evidence. Turning this on sends past conversations to the model again, which uses tokens.'}</p></div>
    {!view ? <p>{busy ? (zh ? '加载中…' : 'Loading…') : (zh ? '请先打开项目。' : 'Open a project first.')}</p> : <>
      <label className="memory-toggle"><input type="checkbox" checked={status?.enabled === true} disabled={busy}
        onChange={event => { const enabled = event.target.checked; void act(async () => { await memoryCommand('memory.setEnabled', { enabled }); await refresh(); }); }} /> {zh ? '在本项目的对话之间记忆' : 'Remember across conversations in this project'}</label>
      <p className="memory-status" role="status">{zh
        ? `已处理 ${status?.conversationsProcessed || 0} 个对话 · 上次运行：${when(status?.lastRunAt)} · 记忆更新：${when(status?.memoryUpdatedAt)}${status?.lastError ? ` · 上次错误：${status.lastError}` : ''}`
        : `${status?.conversationsProcessed || 0} conversations processed · last run: ${when(status?.lastRunAt)} · memory updated: ${when(status?.memoryUpdatedAt)}${status?.lastError ? ` · last error: ${status.lastError}` : ''}`}</p>
      <div className="runtime-item-actions">
        <button className="secondary-button" disabled={busy || !status?.enabled} onClick={() => void act(async () => { await memoryCommand('memory.run'); await refresh(); })}>{zh ? '立即更新' : 'Update now'}</button>
        <button className="secondary-button" disabled={!status?.hasMemory} aria-expanded={showing} onClick={() => setShowing(!showing)}>{showing ? (zh ? '隐藏记忆' : 'Hide memory') : (zh ? '查看记忆' : 'View memory')}</button>
        <button className="text-button" disabled={busy || (!status?.hasMemory && !status?.conversationsProcessed)} onClick={() => setConfirmForget(true)}>{zh ? '全部忘记' : 'Forget all'}</button>
      </div>
      {confirmForget && <div className="memory-forget" role="alertdialog" aria-label={zh ? '忘记全部记忆' : 'Forget all memory'}>
        <p>{zh ? '删除本项目记住的所有内容？此操作无法撤销；开关设置保持不变。' : 'Delete everything remembered for this project? This cannot be undone; the on/off setting stays.'}</p>
        <button className="primary-button" disabled={busy} onClick={() => void act(async () => { await memoryCommand('memory.forget'); setConfirmForget(false); setShowing(false); await refresh(); })}>{zh ? '忘记' : 'Forget'}</button>
        <button className="secondary-button" onClick={() => setConfirmForget(false)}>{zh ? '取消' : 'Cancel'}</button>
      </div>}
      {showing && <div className="memory-view"><h3>memory_summary.md</h3><pre>{view.summary || '—'}</pre><h3>MEMORY.md</h3><pre>{view.memory || '—'}</pre></div>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function RuntimeExtensions({ close, zh = false, initialTab = 'skills' }) {
  const dialog = useRef(null), [tab, setTab] = useState(initialTab), [mcpPreset, setMcpPreset] = useState(null);
  useEffect(() => { const element = dialog.current; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="shell-modal runtime-extensions" aria-label={zh ? '技能与 MCP 插件' : 'Skills and MCP plugins'} onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2>{zh ? '应用、技能与设置' : 'Apps, skills and settings'}</h2><button className="icon-button" aria-label={zh ? '关闭' : 'Close dialog'} onClick={close}>×</button></header>
    <nav className="runtime-tabs" aria-label={zh ? '扩展类型' : 'Extension type'}>{[['apps', zh ? '应用' : 'Apps'], ['skills', zh ? '技能' : 'Skills'], ['mcp', 'MCP'], ['memory', zh ? '记忆' : 'Memory'], ['settings', zh ? '设置' : 'Settings']].map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => { setMcpPreset(null); setTab(id); }}>{label}</button>)}</nav>
    {tab === 'apps' ? <AppsSettings zh={zh} configureMcp={preset => { setMcpPreset(preset); setTab('mcp'); }} selectTab={setTab} /> : tab === 'skills' ? <SkillSettings zh={zh} /> : tab === 'settings' ? <WorkbenchSettings zh={zh} close={close} /> : tab === 'memory' ? <MemorySettings zh={zh} /> : <McpSettings zh={zh} initialPreset={mcpPreset} />}
  </dialog>;
}
