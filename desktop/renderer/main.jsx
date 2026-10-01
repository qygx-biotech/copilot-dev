import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ServiceView } from './components/ServiceView.jsx';
import { ResizeHandle } from './components/ResizeHandle.jsx';
import './workbench.css';

// Adapted from nanobot's new-chat hero, project-grouped ChatList and PaneWorkbench.
// Its gateway hooks are replaced by the BioDesign service contract.
const adapter = window.BioDesignFrontend;
const shell = document.getElementById('appShell');
const views = Object.fromEntries(Object.entries({
  utilities: '.header-utility-row', status: '.header-status-row',
  side: '.side-chat-panel', agent: '.analysis-workspace-panel',
}).map(([key, selector]) => [key, document.querySelector(selector)]));
for (const node of Object.values(views)) node.remove();
// Old goal/explorer elements are detached. Existing services keep their state;
// neither panel is part of the new navigation or startup flow.
shell.replaceChildren();
// Move the existing bound selector; keep its model/turn handling intact.
const sideModel = views.side.querySelector('.side-chat-model-control');
views.side.querySelector('.side-chat-compose-actions').prepend(sideModel);
sideModel.querySelector('span').classList.remove('sr-only');


function usePreference(key, initial) {
  const storageKey = `biodesign.desktop.ui.v1.${key}`;
  const [value, setValue] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem(storageKey)); return typeof saved === typeof initial ? saved : initial; }
    catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch {} }, [storageKey, value]);
  return [value, setValue];
}

function Activity({ run, zh }) {
  if (!run) return null;
  const label = { running: zh ? '进行中' : 'Working', completed: zh ? '已完成' : 'Completed', failed: zh ? '失败' : 'Failed', cancelled: zh ? '已停止' : 'Stopped' }[run.status];
  return <details className={`turn-activity is-${run.status}`}>
    <summary><span className="activity-dot" />{label}<span>{run.steps.length ? `${run.steps.length} ${zh ? '条活动' : 'activity events'}` : ''}</span></summary>
    <ol>{run.steps.map((step, i) => <li key={i}>{step.message || step.stage.replaceAll('-', ' ')}{step.capability ? ` · ${step.capability}` : ''}</li>)}</ol>
    {run.error && <p role="alert">{run.error}</p>}
  </details>;
}

function Modal({ title, children, close, label }) {
  const dialog = useRef(null);
  useEffect(() => {
    const node = dialog.current;
    node.showModal();
    return () => node.close();
  }, []);
  return <dialog ref={dialog} className="shell-modal" aria-label={label || title} onCancel={event => { event.preventDefault(); close(); }}>
      <header><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}>×</button></header>
      {children}
  </dialog>;
}

function ProjectGoalEditor({ editor, busy, error, act, zh }) {
  const [goal, setGoal] = useState(editor.goal);
  const dismiss = () => { if (!busy) void act('project.goal.dismiss'); };
  return <Modal title={zh ? '项目目标' : 'Project goal'} label="Project goal" close={dismiss}>
    <form onSubmit={event => { event.preventDefault(); void act('project.goal.save', { catalogId: editor.catalogId, goal }); }}>
      <p><strong>{editor.name}</strong></p>
      <label className="project-goal-field">{zh ? '这个项目希望实现什么？' : 'What would you like this project to achieve?'}<textarea aria-label="Project goal text" autoFocus value={goal} maxLength={10000} rows={6} disabled={busy} onChange={event => setGoal(event.target.value)} /></label>
      <p>{zh ? '可随时右键点击侧栏中的项目，添加或编辑目标。' : 'You can add or edit this later by right-clicking the project in the sidebar.'}</p>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={dismiss}>{editor.optional ? (zh ? '暂时跳过' : 'Skip for now') : (zh ? '取消' : 'Cancel')}</button><button className="primary-button" disabled={busy}>{zh ? '保存目标' : 'Save goal'}</button></div>
    </form>
  </Modal>;
}

function ProjectMenu({ menu, close, edit, zh, label, rename }) {
  const element = useRef(null);
  useEffect(() => {
    element.current.querySelector('button').focus();
    const outside = event => { if (!element.current?.contains(event.target)) close(); };
    const escape = event => { if (event.key === 'Escape') { close(); menu.trigger?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menu]);
  return <div ref={element} className="project-context-menu" role="menu" aria-label={menu.chat ? 'Chat actions' : 'Project actions'} style={{ left: menu.x, top: menu.y }}>{rename && <button role="menuitem" onClick={rename}>{zh ? '重命名' : 'Rename'}</button>}<button role="menuitem" onClick={edit}>{label || (menu.project.hasGoal ? (zh ? '编辑项目目标' : 'Edit project goal') : (zh ? '添加项目目标' : 'Add project goal'))}</button></div>;
}

function RenameChat({ target, close, zh }) {
  const [title, setTitle] = useState(target.chat.title);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const dismiss = () => { if (!saving) close(); };
  const save = async event => {
    event.preventDefault();
    if (saving || !title.trim()) return;
    setSaving(true); setError('');
    try {
      const saved = await adapter.command('chat.rename', { projectId: target.projectId, catalogId: target.catalogId, role: 'agent_command', conversationId: target.chat.id, title });
      if (saved) close();
      else setError(adapter.getSnapshot().projectError || (zh ? '无法重命名对话。' : 'Could not rename this chat.'));
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  };
  return <Modal title={zh ? '重命名对话' : 'Rename chat'} label="Rename chat" close={dismiss}>
    <form onSubmit={save}>
      <label className="chat-name-field">{zh ? '对话名称' : 'Chat name'}<input aria-label="Chat name" autoFocus value={title} maxLength={120} disabled={saving} onFocus={event => event.target.select()} onChange={event => setTitle(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={saving} onClick={dismiss}>{zh ? '取消' : 'Cancel'}</button><button className="primary-button" disabled={saving || !title.trim()}>{zh ? '保存' : 'Save'}</button></div>
    </form>
  </Modal>;
}

function SideHistory({ conversations, activeId, disabled, select, context, zh }) {
  const [open, setOpen] = useState(false);
  const host = useRef(null), trigger = useRef(null);
  useEffect(() => { setOpen(false); }, [activeId, disabled]);
  useEffect(() => {
    const outside = event => { if (!host.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const title = chat => chat?.title === 'Side Chat' ? (zh ? '新问答' : 'New Side Chat') : chat?.title;
  return <div ref={host} className="side-history-picker" onKeyDown={event => {
    if (event.key === 'Escape') { setOpen(false); trigger.current.focus(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); setOpen(true);
      requestAnimationFrame(() => {
        const items = [...host.current.querySelectorAll('[role="option"]')], index = items.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      });
    }
  }}>
    <span>{zh ? '问答记录' : 'Side Chat history'} · {conversations.length}/5</span>
    <button ref={trigger} className="history-trigger" aria-label="Side Chat history" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>{title(conversations.find(chat => chat.id === activeId))}<span>⌄</span></button>
    {open && <div className="history-options" role="listbox" aria-label="Saved Side Chats">{conversations.map(chat => <button type="button" role="option" aria-selected={chat.id === activeId} key={chat.id} data-conversation-id={chat.id} onClick={() => { setOpen(false); select(chat.id); }} onContextMenu={event => context(event, chat)} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) context(event, chat); }}>{title(chat)}</button>)}</div>}
  </div>;
}

function Workbench() {
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot);
  const [sidebarWidth, setSidebarWidth] = usePreference('sidebarWidth', 260);
  const [ratio, setRatio] = usePreference('split', 50);
  const [sidebarOpen, setSidebarOpen] = usePreference('sidebarOpen', true);
  const [split, setSplit] = useState(false);
  const [focus, setFocus] = useState('agent_command');
  const [collapsed, setCollapsed] = useState({});
  const [search, setSearch] = useState('');
  const [picker, setPicker] = useState(null);
  const [library, setLibrary] = useState(false);
  const [projectMenu, setProjectMenu] = useState(null);
  const [chatMenu, setChatMenu] = useState(null), [deletion, setDeletion] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [error, setError] = useState('');
  const zh = state.language === 'zh';
  const projectId = state.project?.id;
  const activeProject = state.projects?.find(project => project.id === state.catalogId);
  const activeAgent = state.agents.find(chat => chat.id === state.activeAgentId);
  const activeSide = state.conversations.find(chat => chat.id === state.activeConversationId);
  const sideHistory = [...state.conversations].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  const busy = state.projectBusy || !projectId;
  const act = (name, extra = {}) => {
    setError('');
    return adapter.command(name, { projectId, ...extra }).catch(failure => setError(failure.message));
  };
  useEffect(() => {
    setFocus(state.surface || 'agent_command');
    if (state.surface === 'side_chat') setSplit(true);
  }, [state.surface, state.catalogId]);
  useEffect(() => { setError(''); setLibrary(false); setProjectMenu(null); setChatMenu(null); setDeletion(null); }, [projectId]);
  useEffect(() => {
    for (const card of views.agent.querySelectorAll('.analysis-panel')) card.hidden = card.dataset.panelId !== state.activeAgentId;
  }, [state]);
  useEffect(() => { if (state.revealSource) setLibrary(true); }, [state.revealSource?.sequence]);

  const liveChats = state.agents.filter(chat => chat.messageCount > 0 || chat.sideChatCount > 0);
  const groups = (state.projects || []).map(project => ({ ...project, conversations: project.id === state.catalogId ? liveChats : project.conversations || [] }));
  const filtered = chats => chats.filter(chat => chat.role === 'agent_command' && (!search || chat.title?.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const selectChat = (project, chat) => {
    setFocus(chat.role);
    if (chat.role === 'side_chat') setSplit(true);
    void act('chat.open', { catalogId: project.id, role: chat.role, conversationId: chat.id });
    if (innerWidth < 1000) setSidebarOpen(false);
  };
  const chatRows = project => filtered(project.conversations).map(chat => {
    const selected = project.id === state.catalogId && chat.id === state.activeAgentId;
    return <button key={`${chat.role}:${chat.id}`} className={`chat-row ${selected ? 'selected' : ''}`} disabled={state.projectBusy || state.sideBusy} title={chat.title} aria-current={selected ? 'page' : undefined} onClick={() => selectChat(project, chat)} onContextMenu={event => openChatMenu(event, chat, project.id)} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openChatMenu(event, chat, project.id); }}>
      <span className="chat-icon">◌</span><span>{chat.title}</span>{chat.status === 'running' && <i className="activity-dot" />}
    </button>;
  });
  const newChat = (catalogId = 'default', role = 'agent_command') => {
    setFocus(role); setPicker(null);
    if (role === 'side_chat') setSplit(true);
    void act('chat.new', { catalogId, role });
  };
  const projectControl = role => <button className="project-scope-control" disabled={state.projectBusy} onClick={() => setPicker(role)} title={activeProject?.path}>
    <span>▱</span>{activeProject?.managed || !activeProject ? (zh ? '选择项目' : 'Choose project') : activeProject.name}<span>⌄</span>
  </button>;
  const openProjectMenu = (event, project) => {
    event.preventDefault();
    if (state.projectBusy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setProjectMenu({ project, trigger: event.currentTarget.querySelector('button'), x: Math.max(8, Math.min(event.clientX || rect.left, innerWidth - 220)), y: Math.max(8, Math.min(event.clientY || rect.bottom, innerHeight - 65)) });
  };
  const openChatMenu = (event, chat, catalogId = state.catalogId) => {
    event.preventDefault(); event.stopPropagation();
    if (busy || state.sideBusy || state.agentBusy) return;
    setProjectMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    setChatMenu({ project: {}, trigger: event.currentTarget, chat, catalogId, projectId, agentPanelId: state.activeAgentId,
      x: Math.max(8, Math.min(event.clientX || rect.left, innerWidth - 220)), y: Math.max(8, Math.min(event.clientY || rect.bottom, innerHeight - (chat.role === 'agent_command' ? 110 : 65))) });
  };
  const confirmDelete = async () => {
    try {
      setError('');
      await adapter.command(deletion.chat.role === 'side_chat' ? 'side.delete' : 'chat.delete', {
        projectId: deletion.projectId, catalogId: deletion.catalogId, agentPanelId: deletion.agentPanelId,
        role: deletion.chat.role, conversationId: deletion.chat.id,
      });
      setDeletion(null);
    } catch (failure) { setError(failure.message); }
  };
  const pane = role => {
    const side = role === 'side_chat', chat = side ? activeSide : activeAgent;
    const run = state.runs[`${role}:${side ? state.activeConversationId : state.activeAgentId}`];
    const empty = !chat?.messageCount && run?.status !== 'running';
    return <section className={`copilot-pane ${side ? 'side-pane' : 'agent-pane'} ${empty ? 'is-empty' : ''}`} data-role={role} aria-label={side ? 'Side Chat pane' : 'Agent Work pane'} onFocusCapture={() => setFocus(role)} onPointerDown={() => setFocus(role)}>
      <div className="pane-heading"><h2>{side ? 'Side Chat' : 'Agent Work'}</h2><div className="pane-chat-actions"><button aria-label={`Copy ${side ? 'Side Chat' : 'Agent Work'} chat`} title={zh ? '复制对话文本' : 'Copy chat as text'} disabled={busy || !chat?.messageCount || (side ? state.sideBusy : chat.status === 'running')} onClick={() => void act(side ? 'side.copy' : 'agent.copy', { role, conversationId: chat.id, agentPanelId: state.activeAgentId })}>{zh ? '复制' : 'Copy'}</button><button aria-label={`Fork ${side ? 'Side Chat' : 'Agent Work'} chat`} title={zh ? '从此对话创建独立分支' : 'Continue a separate copy of this conversation'} disabled={busy || !chat?.messageCount || state.sideBusy || chat.status === 'running'} onClick={() => void act(side ? 'side.fork' : 'agent.fork', { role, conversationId: chat.id, agentPanelId: state.activeAgentId })}>{zh ? '分支' : 'Fork'}</button></div>{side && <button className="icon-button" aria-label="New Side Chat" disabled={state.sideBusy || busy} onClick={() => void act('side.new', { role: 'side_chat', agentPanelId: state.activeAgentId })}>＋</button>}{side && run?.status === 'running' && <button className="stop-turn" onClick={() => adapter.cancel({ projectId, role, conversationId: state.activeConversationId })}>{zh ? '停止' : 'Stop'}</button>}</div>
      {side && <SideHistory conversations={sideHistory} activeId={state.activeConversationId} disabled={state.sideBusy || busy || state.sideChatAgentId !== state.activeAgentId} zh={zh} select={conversationId => void act('side.open', { role: 'side_chat', agentPanelId: state.activeAgentId, conversationId })} context={openChatMenu} />}
      {empty && <div className="hero-heading"><div className="hero-mark">b<span>∙</span></div><h1>{side ? (zh ? '一起探索问题' : 'What would you like to explore?') : (zh ? '今天想研究什么？' : 'What would you like to work on?')}</h1></div>}
      <Activity run={run} zh={zh} />
      <ServiceView node={side ? views.side : views.agent} className={`thread-host ${side ? '' : 'agent-host'}`} />
      <div className="thread-footer">{empty && !side ? projectControl(role) : <span title={activeProject?.path}>▱ {activeProject?.managed ? (zh ? '默认工作区' : 'Default workspace') : activeProject?.name}</span>}<span>{side ? (zh ? '讨论 · 只读' : 'Side Chat · Read only') : (zh ? '研究助手' : 'Agent Work')}</span></div>
    </section>;
  };

  return <div className={`copilot-workbench ${sidebarOpen ? '' : 'sidebar-closed'} ${split ? 'is-split' : 'is-single'}`} style={{ '--sidebar-width': `${Math.min(420, Math.max(230, sidebarWidth))}px`, '--pane-split': `${Math.min(70, Math.max(30, ratio))}%` }} data-focused-pane={focus}>
    <aside className="copilot-sidebar" id="copilot-sidebar" aria-label={zh ? '对话与项目' : 'Chats and projects'}>
      <div className="brand"><span className="brand-mark">b∙</span><strong>BioDesign</strong><button className="icon-button" aria-label="Collapse sidebar" onClick={() => setSidebarOpen(false)}>‹</button></div>
      <button className="new-conversation" disabled={state.projectBusy || state.sideBusy} onClick={() => newChat()}><span>＋</span>{zh ? '新对话' : 'New chat'}</button>
      <label className="conversation-search"><span>⌕</span><input aria-label="Search conversations" placeholder={zh ? '搜索对话' : 'Search conversations'} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="sidebar-scroll">
        <nav aria-label="Chats"><div className="section-label">{zh ? '对话' : 'Chats'}</div>{groups.filter(project => project.managed).map(project => <div key={project.id}>{chatRows(project)}{!filtered(project.conversations).length && <p className="sidebar-empty">{zh ? '开始第一个对话' : 'Start your first conversation'}</p>}</div>)}</nav>
        <nav aria-label="Projects"><div className="section-label">{zh ? '项目' : 'Projects'}<button className="icon-button" aria-label="Add project" disabled={state.projectBusy} onClick={() => void act('project.choose')}>＋</button></div>
          {groups.filter(project => !project.managed).map(project => <div className="project-group" key={project.id}>
            <div className="project-group-heading" onContextMenu={event => openProjectMenu(event, project)} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openProjectMenu(event, project); }}><button className="project-disclosure" aria-expanded={!collapsed[project.id]} title={project.path} onClick={() => setCollapsed(current => ({ ...current, [project.id]: !current[project.id] }))}><span>{collapsed[project.id] ? '▸' : '▾'}</span><span>▱</span><strong>{project.name}</strong></button><button className="icon-button" aria-label={`New chat in ${project.name}`} disabled={state.projectBusy || state.sideBusy} onClick={() => newChat(project.id)}>＋</button></div>
            {!collapsed[project.id] && <div className="project-chats">{chatRows(project)}{!filtered(project.conversations).length && <button className="empty-project" disabled={state.projectBusy || state.sideBusy} onClick={() => newChat(project.id)}>{zh ? '新对话' : 'New conversation'}</button>}</div>}
          </div>)}
        </nav>
      </div>
      <div className="sidebar-footer">
        <details className="account-menu">
          <summary aria-label={zh ? '账号' : 'Account'}><span className="account-avatar" aria-hidden="true">{(state.account || 'A').slice(0, 1).toUpperCase()}</span><span><strong>{zh ? '账号' : 'Account'}</strong><small>{state.account || 'BioDesign Copilot'}</small></span><span aria-hidden="true">⌃</span></summary>
          <div className="account-options"><button type="button" onClick={event => { event.currentTarget.closest('details').open = false; void act('account.library'); }}>Library URL</button><button type="button" onClick={event => { event.currentTarget.closest('details').open = false; void act('account.libraryJobs'); }}>{zh ? '图书馆任务' : 'Library jobs'}</button></div>
        </details>
      </div>
      <ResizeHandle value={sidebarWidth} min={230} max={420} onChange={setSidebarWidth} controls="copilot-sidebar" label="Resize sidebar" />
    </aside>
    <div className="copilot-main">
      <header className="copilot-topbar"><div className="topbar-title"><button className="icon-button" aria-label="Toggle sidebar" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button><strong>{(focus === 'side_chat' ? activeSide?.messageCount && activeSide.title : activeAgent?.title) || (zh ? '新对话' : 'New chat')}</strong></div><ServiceView node={views.utilities} className="utilities-host" /></header>
      <div className="thread-toolbar"><ServiceView node={views.status} /><div><button aria-label="Open literature" disabled={busy} onClick={() => setLibrary(true)}>{zh ? '文献' : 'Literature'}{state.literature?.length ? ` (${state.literature.length})` : ''}</button><button aria-label="Toggle Side Chat" aria-pressed={split} onClick={() => { setSplit(!split); setFocus(split ? 'agent_command' : 'side_chat'); }}>Side Chat</button></div></div>
      {(error || state.projectError) && <div className="adapter-error" role="alert">{error || state.projectError}<button onClick={() => void act('project.retry')}>{zh ? '重试' : 'Retry'}</button></div>}
      {state.projectBusy && <div className="project-loading" role="status">{zh ? '正在打开对话…' : 'Opening conversation…'}</div>}
      <nav className="narrow-pane-tabs" aria-label="Workbench panes"><button aria-pressed={focus === 'agent_command'} onClick={() => setFocus('agent_command')}>Agent Work</button><button aria-pressed={focus === 'side_chat'} onClick={() => setFocus('side_chat')}>Side Chat</button></nav>
      <div className="copilot-panes" id="copilot-panes" inert={state.projectBusy ? '' : undefined}>
        {pane('agent_command')}<ResizeHandle value={ratio} min={30} max={70} onChange={setRatio} controls="copilot-panes" ratio label="Resize Side Chat and Agent Work" />{pane('side_chat')}
      </div>
    </div>
    {chatMenu && <ProjectMenu menu={chatMenu} close={() => setChatMenu(null)} zh={zh} rename={chatMenu.chat.role === 'agent_command' ? () => { setRenaming(chatMenu); setChatMenu(null); } : undefined} label={zh ? '删除对话' : 'Delete chat'} edit={() => { setDeletion(chatMenu); setChatMenu(null); }} />}
    {renaming && <RenameChat target={renaming} close={() => setRenaming(null)} zh={zh} />}
    {deletion && <Modal title={zh ? '删除对话？' : 'Delete chat?'} label="Delete chat" close={() => { if (!busy) setDeletion(null); }}>
      <p>{zh ? '确定要删除此对话吗？' : 'Are you sure you want to delete this chat?'}</p><p><strong>{deletion.chat.title}</strong></p>
      <p>{deletion.chat.role === 'agent_command' ? (zh ? '同时删除其所有 Side Chat。项目文件与研究结果将保留。' : 'This also deletes its Side Chats. Project files and research results are kept.') : (zh ? '此问答记录将被删除。' : 'This Side Chat history will be deleted.')}</p>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions"><button autoFocus className="secondary-button" disabled={busy} onClick={() => setDeletion(null)}>{zh ? '取消' : 'Cancel'}</button><button className="primary-button delete-confirm" disabled={busy || state.sideBusy || state.agentBusy} onClick={confirmDelete}>{zh ? '删除' : 'Delete'}</button></div>
    </Modal>}
    {projectMenu && <ProjectMenu menu={projectMenu} close={() => setProjectMenu(null)} zh={zh} edit={() => { const catalogId = projectMenu.project.id; setProjectMenu(null); void act('project.goal.edit', { catalogId }); }} />}
    {state.goalEditor && !state.pendingProject && <ProjectGoalEditor key={state.goalEditor.projectId} editor={state.goalEditor} busy={state.projectBusy} error={state.projectError || error} act={act} zh={zh} />}
    {picker && <Modal title={zh ? '选择项目' : 'Choose project'} close={() => setPicker(null)}><p>{zh ? '无需选择文件夹即可开始。' : 'Start a chat without choosing a folder, or use a project.'}</p><div className="project-options">{groups.map(project => <button key={project.id} title={project.path} onClick={() => { setPicker(null); void act('project.activate', { catalogId: project.id, role: picker }); }}><span>▱</span><div><strong>{project.managed ? (zh ? '无项目' : 'No project') : project.name}</strong><small>{project.managed ? (zh ? '使用默认工作区' : 'Use the default workspace') : project.path}</small></div>{project.id === state.catalogId && <span>✓</span>}</button>)}</div><button className="secondary-button" onClick={() => { setPicker(null); void act('project.choose', { role: picker }); }}>{zh ? '选择文件夹…' : 'Choose folder…'}</button></Modal>}
    {state.pendingProject && <Modal title={zh ? '使用此项目？' : 'Use this project?'} close={() => void act('project.cancel')} label="Initialize project"><p>{state.pendingProject.name}</p><p>{zh ? 'BioDesign 将在此文件夹创建 .biodesign 数据，并保留已有文件。' : 'BioDesign will create its .biodesign data in this folder and keep existing files.'}</p><div className="dialog-actions"><button className="secondary-button" onClick={() => void act('project.cancel')}>{zh ? '取消' : 'Cancel'}</button><button className="primary-button" disabled={state.projectBusy} onClick={() => void act('project.confirm')}>{zh ? '使用项目' : 'Use project'}</button></div></Modal>}
    {library && <Modal title={zh ? '文献' : 'Literature'} close={() => setLibrary(false)}><div className="library-heading"><p>{activeProject?.managed ? (zh ? '默认工作区' : 'Default workspace') : activeProject?.name}</p><button className="secondary-button" onClick={() => void act('sources.refresh')}>{zh ? '刷新' : 'Refresh'}</button></div><p className="library-path">{activeProject?.path}</p><p>{zh ? '选择文献限定证据范围。下载的 PDF 会在后续研究请求使用时进行准备。' : 'Select papers to scope the evidence. Downloaded PDFs are prepared when a research request uses them.'}</p><div className="library-files">{state.revealSource && <p className="revealed-source">{state.revealSource.path}</p>}{(state.literature || []).map(paper => <label key={paper.path}><input type="checkbox" checked={paper.selected} onChange={event => void act('sources.select', { path: paper.path, selected: event.target.checked })} /><div><strong>{paper.name}</strong><small>{paper.path} · {paper.prepared ? (zh ? '已准备' : 'Prepared') : (zh ? '尚未准备' : 'Not prepared')}</small></div></label>)}{!state.literature?.length && <p>{zh ? '让 Agent Work 查找并下载文献，即可在这里查看。' : 'Ask Agent Work to find and download papers. Saved PDFs will appear here.'}</p>}</div></Modal>}
  </div>;
}

class Boundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? <div role="alert">The workbench could not load. Restart the application.</div> : this.props.children; }
}
createRoot(shell).render(<Boundary><Workbench /></Boundary>);
document.documentElement.dataset.renderer = 'biodesign-react';
