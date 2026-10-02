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
      await workflow('runtime_skills_save', { name: editor.name, content: editor.content });
      await refresh(); setEditor(null);
    });
  };
  return <section aria-label={zh ? '技能设置' : 'Skill settings'}>
    <div className="runtime-section-heading"><p>{zh ? '使用 $技能名称 调用技能。标记为 always 的技能会自动加载，其余技能按需读取。' : 'Invoke a skill with $skill-name. Always-active skills load automatically; other instructions load when needed.'}</p><button className="secondary-button" disabled={busy} onClick={() => setEditor({ name: 'my-skill', content: skillTemplate, existing: false })}>{zh ? '新建技能' : 'New skill'}</button></div>
    <p>{zh ? '技能仅提供指令；项目范围、证据检查和工具权限仍由 BioDesign 控制。项目覆盖保存在 .biodesign/skills。' : 'Skills supply instructions. BioDesign still enforces project scope, evidence checks, and tool permissions. Project overrides are saved under .biodesign/skills.'}</p>
    {error && <p className="runtime-error" role="alert">{error}</p>}
    {errors.map((item, index) => <p key={`${item.path}-${index}`} className="runtime-error" role="alert">{item.path}: {item.message}</p>)}
    {editor ? <form className="runtime-editor" onSubmit={save}>
      <label>{zh ? '名称' : 'Name'}<input autoFocus value={editor.name} disabled={busy || editor.existing} maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" required onChange={event => {
        const name = event.target.value;
        setEditor(current => ({ ...current, name, content: current.content.replace(/^name:.*$/m, `name: ${name}`) }));
      }} /></label>
      <label>SKILL.md<textarea aria-label="Skill Markdown" className="runtime-code" rows={14} value={editor.content} maxLength={65536} disabled={busy} required spellCheck={false} onChange={event => setEditor({ ...editor, content: event.target.value })} /></label>
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditor(null)}>{zh ? '取消' : 'Cancel'}</button><button className="primary-button" disabled={busy}>{zh ? '保存技能' : 'Save skill'}</button></div>
    </form> : <div className="runtime-items" aria-busy={busy}>
      {skills.map(skill => <article className="runtime-item" key={skill.name}>
        <div className="runtime-item-heading"><strong>${skill.name}</strong><label className="runtime-toggle"><input type="checkbox" aria-label={`${zh ? '启用' : 'Enable'} ${skill.name}`} checked={skill.enabled} disabled={busy || skill.invalid} onChange={event => { const enabled = event.target.checked; void act(async () => { await workflow('runtime_skills_enable', { name: skill.name, enabled }); await refresh(); }); }} />{zh ? '启用' : 'Enabled'}</label></div>
        <p>{skill.description}</p><small>{skill.path}{skill.always ? ` · ${zh ? '自动加载' : 'always active'}` : ''}{skill.source === 'bundled' ? ` · ${zh ? '内置' : 'bundled'}` : ''}</small>
        {!skill.available && <p className="runtime-error">{skill.invalid ? (zh ? '技能元数据无效。' : 'Invalid skill metadata.') : `${zh ? '缺少依赖' : 'Missing requirements'}: ${[...(skill.missing?.bins || []).map(name => `${name} (binary)`), ...(skill.missing?.env || []).map(name => `${name} (env)`)].join(', ')}`}</p>}
        <button className="secondary-button" disabled={busy || skill.invalid} onClick={() => void edit(skill)}>{skill.source === 'bundled' ? (zh ? '查看 / 创建项目覆盖' : 'View / customize for project') : (zh ? '查看 / 编辑' : 'View / edit')}</button>
      </article>)}
      {!busy && !skills.length && <p>{zh ? '尚无技能。新建技能，或将 SKILL.md 放入 skills/技能名称/。' : 'No skills yet. Create one here or place SKILL.md in skills/skill-name/.'}</p>}
    </div>}
  </section>;
}

function McpSettings({ zh }) {
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
    setEditor({ name: server?.name || '', config: JSON.stringify(config, null, 2), enabled: enabled === true, allowLocalhost: allowLocalhost === true, secrets: '', headers: '', existing: Boolean(server), envKeys: server?.envKeys || [], headerKeys: server?.headerKeys || [] });
    setError('');
  };
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

export function RuntimeExtensions({ close, zh = false }) {
  const dialog = useRef(null), [tab, setTab] = useState('skills');
  useEffect(() => { const element = dialog.current; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="shell-modal runtime-extensions" aria-label={zh ? '技能与 MCP 插件' : 'Skills and MCP plugins'} onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2>{zh ? '技能与 MCP 插件' : 'Skills and MCP plugins'}</h2><button className="icon-button" aria-label={zh ? '关闭' : 'Close dialog'} onClick={close}>×</button></header>
    <nav className="runtime-tabs" aria-label={zh ? '扩展类型' : 'Extension type'}><button type="button" aria-pressed={tab === 'skills'} onClick={() => setTab('skills')}>{zh ? '技能' : 'Skills'}</button><button type="button" aria-pressed={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP</button></nav>
    {tab === 'skills' ? <SkillSettings zh={zh} /> : <McpSettings zh={zh} />}
  </dialog>;
}
