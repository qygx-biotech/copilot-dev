import React, { useRef } from 'react';
import './topic-navigation.css';

export function TopicNavigationControls({ archived, setArchived, sort, setSort, zh }) {
  return <div className="topic-navigation-controls">
    <button type="button" aria-pressed={archived} onClick={() => setArchived(!archived)}>{archived ? (zh ? '显示活跃对话' : 'Show active') : (zh ? '归档对话' : 'Archived')}</button>
    <label><span className="sr-only">{zh ? '对话排序' : 'Conversation order'}</span><select aria-label="Conversation order" value={sort} onChange={event => setSort(event.target.value)}><option value="manual">{zh ? '手动排序' : 'Manual order'}</option><option value="recent">{zh ? '最近更新' : 'Most recent'}</option></select></label>
  </div>;
}

/** The host owns persistence and project activation. This view never reads
 * another workspace's contents or attaches a topic to an agent implicitly. */
export function TopicRows({ project, currentCatalogId, activeId, query = '', archived = false, sort = 'manual', zh = false,
  disabled = false, select, context, update, reorder }) {
  const root = useRef(null), api = window.BioDesignTopicNavigation;
  const topics = api.orderTopics(api.searchTopics(api.decorateTopics((project.conversations || []).filter(chat => chat.role === 'agent_command'), project.topicNavigation), query), { archived, sort });
  const navigate = event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target.tagName === 'SUMMARY') return;
    const buttons = [...root.current.querySelectorAll('[data-topic-select]:not(:disabled)')];
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };
  const move = (topic, delta) => {
    const partition = topics.filter(item => item.pinned === topic.pinned), index = partition.findIndex(item => item.topicKey === topic.topicKey);
    if (index + delta < 0 || index + delta >= partition.length) return;
    [partition[index], partition[index + delta]] = [partition[index + delta], partition[index]];
    reorder(project, partition.map(item => item.topicKey));
  };
  return <div ref={root} className="topic-navigation" onKeyDown={navigate}>
    {!topics.length && <p className="sidebar-empty">{query ? (zh ? '无匹配的对话' : 'No matching conversations') : archived ? (zh ? '没有归档对话' : 'No archived conversations') : (zh ? '开始第一个对话' : 'Start your first conversation')}</p>}
    {topics.map(topic => {
      const selected = project.id === currentCatalogId && topic.id === activeId;
      const partition = topics.filter(item => item.pinned === topic.pinned), index = partition.findIndex(item => item.topicKey === topic.topicKey);
      return <div key={topic.topicKey} className={`topic-row-group ${selected ? 'selected' : ''}`}>
        <button type="button" data-topic-select className={`chat-row topic-chat-row ${selected ? 'selected' : ''}`} aria-current={selected ? 'page' : undefined} disabled={disabled}
          title={`${topic.title || 'Agent Work'}${topic.preview ? `\n${topic.preview}` : ''}`} onClick={() => select(project, topic)} onContextMenu={event => context?.(event, topic, project.id)}
          onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) context?.(event, topic, project.id); }}>
          <span className="topic-handle">@{topic.handle}</span><span className="topic-title">{topic.title || 'Agent Work'}{query && topic.preview && <small>{topic.preview}</small>}</span>
          {topic.pinned && <span className="topic-pin" aria-label={zh ? '已置顶' : 'Pinned'}>⌖</span>}{topic.status === 'running' && <i className="activity-dot" />}
        </button>
        <details className="topic-actions"><summary aria-label={`${zh ? '管理对话' : 'Manage conversation'} ${topic.title || topic.handle}`}>⋯</summary><div>
          <button type="button" disabled={disabled || !update} onClick={event => { event.currentTarget.closest('details').open = false; update(project, topic, { pinned: !topic.pinned }); }}>{topic.pinned ? (zh ? '取消置顶' : 'Unpin') : (zh ? '置顶' : 'Pin')}</button>
          <button type="button" disabled={disabled || !update || topic.status === 'running'} onClick={event => { event.currentTarget.closest('details').open = false; update(project, topic, { archived: !topic.archived }); }}>{topic.archived ? (zh ? '恢复对话' : 'Restore') : (zh ? '归档对话' : 'Archive')}</button>
          <button type="button" disabled={disabled || !reorder || sort !== 'manual' || index === 0} onClick={() => move(topic, -1)}>{zh ? '上移' : 'Move up'}</button>
          <button type="button" disabled={disabled || !reorder || sort !== 'manual' || index === partition.length - 1} onClick={() => move(topic, 1)}>{zh ? '下移' : 'Move down'}</button>
        </div></details>
      </div>;
    })}
  </div>;
}

export function TopicReferencePicker({ topics, onChoose, close, zh = false }) {
  return <div className="topic-reference-picker" role="dialog" aria-label={zh ? '引用同项目对话' : 'Reference a conversation in this project'}>
    <div><strong>{zh ? '引用同项目对话' : 'Reference a conversation'}</strong><button type="button" aria-label="Close conversation picker" onClick={close}>×</button></div>
    <p>{zh ? '引用仅作为历史上下文，不会扩大文献范围或权限。' : 'References add historical context and preserve the current source scope and permissions.'}</p>
    {topics.filter(topic => !topic.archived).map(topic => <button type="button" key={topic.topicKey || topic.id} onClick={() => onChoose(topic)}><span>@{topic.handle}</span> {topic.title}</button>)}
  </div>;
}
