import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './turn-details.css';

const number = value => Number.isFinite(value) && value >= 0 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';
const seconds = value => Number.isFinite(value) && value >= 0 ? `${(value / 1000).toFixed(1)}s` : '—';
const label = (value, zh) => ({ completed: zh ? '已完成' : 'Completed', running: zh ? '进行中' : 'Running', pending: zh ? '等待结果' : 'Pending', failed: zh ? '失败' : 'Failed', cancelled: zh ? '已取消' : 'Cancelled', unknown: zh ? '结果未知' : 'Outcome unknown' }[value] || value);
const stageLabel = (stage, zh) => ({ 'model-request': zh ? '请求模型' : 'Model request', 'tool-running': zh ? '执行工具' : 'Tool call', 'preparing-request': zh ? '准备请求' : 'Preparing request', 'historical-replay': zh ? '加载对话历史' : 'Loading conversation history', 'search-completed': zh ? '搜索完成' : 'Search complete', 'web-search': zh ? '网页搜索' : 'Web search' }[stage] || stage.replaceAll('-', ' '));

export function UsageChart({ usage, zh = false }) {
  if (!usage?.rounds?.length) return <p className="turn-details-muted">{zh ? '尚无模型用量报告。' : 'No model usage report yet.'}</p>;
  const rounds = usage.rounds.slice(-8);
  const maximum = Math.max(1, ...rounds.map(round => (round.inputTokens || 0) + (round.outputTokens || 0)));
  return <section className="turn-usage-chart" aria-label={zh ? '最近模型请求用量' : 'Recent model request usage'}>
    <div className="turn-usage-totals"><span>{zh ? '输入' : 'Input'} <strong>{number(usage.totals?.inputTokens)}</strong></span><span>{zh ? '输出' : 'Output'} <strong>{number(usage.totals?.outputTokens)}</strong></span><span>{zh ? '缓存' : 'Cached'} <strong>{number(usage.totals?.cachedTokens)}</strong></span><span>{zh ? '模型耗时' : 'Model time'} <strong>{seconds(usage.generationMs)}</strong></span></div>
    <div className="turn-usage-bars" role="list">{rounds.map(round => {
      const known = Number.isFinite(round.inputTokens) || Number.isFinite(round.outputTokens);
      const input = round.inputTokens || 0, output = round.outputTokens || 0, cached = round.cachedTokens || 0;
      const tooltip = `${round.model}\n${round.stage} · ${round.ok ? (zh ? '完成' : 'completed') : (zh ? '未完成' : 'failed')}\n${zh ? '输入' : 'Input'}: ${number(round.inputTokens)}\n${zh ? '输出' : 'Output'}: ${number(round.outputTokens)}\n${zh ? '缓存' : 'Cached'}: ${number(round.cachedTokens)}\n${zh ? '耗时' : 'Time'}: ${seconds(round.durationMs)}`;
      return <div className="turn-usage-round" role="listitem" key={round.id}>
        <button type="button" className={`turn-usage-bar ${known ? '' : 'unknown'}`} aria-label={tooltip} title={tooltip} style={{ height: known ? `${Math.max(4, (input + output) / maximum * 110)}px` : '16px' }}>
          {known ? <><span className="turn-usage-output" style={{ flex: output }} /><span className="turn-usage-input" style={{ flex: input }}><span className="turn-usage-cache" style={{ height: input ? `${Math.min(100, cached / input * 100)}%` : 0 }} /></span></> : '?'}</button>
        <small>{round.sequence}</small>
      </div>;
    })}</div>
    <p className="turn-details-muted turn-usage-legend"><span className="input-key" />{zh ? '输入' : 'Input'} <span className="output-key" />{zh ? '输出' : 'Output'} <span className="cached-key" />{zh ? '缓存输入' : 'Cached input'}{usage.cacheHitRate !== null && Number.isFinite(usage.cacheHitRate) ? ` · ${Math.round(usage.cacheHitRate * 100)}% ${zh ? '缓存命中' : 'cache hit'}` : ''}</p>
    {!usage.complete && <p className="turn-details-muted">{zh ? '供应商用量报告不完整；总数仅含已报告的 token，重试可能未全部计入。' : 'Provider usage is incomplete. Totals include reported tokens only; some retry usage may be unavailable.'}</p>}
  </section>;
}

export function TurnUsagePopover({ details, turns = [], zh = false }) {
  const usages = turns.flatMap(item => item?.turnUsage || item?.usage || []).concat(details?.turnUsage || []).filter(item => item?.rounds?.length);
  const unique = [...new Map(usages.map(usage => [usage.turnId, usage])).values()].slice(-6);
  return <details className="turn-usage-popover"><summary aria-label={zh ? '查看模型用量' : 'Show model usage'} title={zh ? '模型用量' : 'Model usage'}>▥</summary><div className="turn-usage-popover-content"><strong>{zh ? '模型用量' : 'Model usage'}</strong>{unique.length ? unique.map(usage => <UsageChart key={usage.turnId} usage={usage} zh={zh} />) : <p>{zh ? '发送消息后可查看供应商报告的 token 用量。' : 'Send a message to view provider-reported token usage.'}</p>}</div></details>;
}

export function ArtifactDiff({ artifact, zh = false }) {
  if (artifact?.origin !== 'host-write') return null;
  if (artifact.baselineUnavailable) return <p className="turn-details-muted">{zh ? '已保存' : 'Saved'} {artifact.path} · {zh ? '旧版本不可读取，未计算差异。' : 'Previous content unavailable; no diff computed.'}</p>;
  if (!artifact.diff || !Array.isArray(artifact.diff.rows)) return null;
  const diff = artifact.diff;
  return <details className="turn-artifact-diff"><summary><span>{zh ? '已保存' : 'Saved'} {artifact.path}</span><span className="turn-diff-added">+{number(diff.added)}</span><span className="turn-diff-removed">−{number(diff.removed)}</span></summary>
    <div className="turn-diff-table" role="table" aria-label={`${zh ? '文件变更' : 'Changes to'} ${artifact.path}`}>
      {diff.rows.slice(0, 400).map((row, index) => <div className={`turn-diff-line ${['add', 'remove', 'context'].includes(row.type) ? row.type : 'context'}`} role="row" key={index}><span role="cell" className="turn-diff-number">{row.oldLine || ''}</span><span role="cell" className="turn-diff-number">{row.newLine || ''}</span><span role="cell">{row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ' '}</span><code role="cell">{String(row.content).slice(0, 64000)}</code></div>)}
    </div>
    {diff.unchanged && <p>{zh ? '内容未变更。' : 'Content unchanged.'}</p>}
    {(diff.truncated || diff.replacement) && <p className="turn-details-muted">{diff.truncated ? (zh ? '部分差异已省略。' : 'Some changes are omitted. ') : ''}{diff.replacement ? (zh ? '较大的变更显示为整块替换。' : 'Large changes are shown as replacement blocks.') : ''}{!diff.countsComplete ? (zh ? ' 行数统计不完整。' : ' Line counts are partial.') : ''}</p>}
  </details>;
}

// Per-call file counts from project-mode receipts.
const fileCounts = (summary, zh) => [['filesCreated', zh ? '个文件新建' : 'created'], ['filesChanged', zh ? '个文件修改' : 'changed'], ['filesDeleted', zh ? '个文件删除' : 'deleted']]
  .filter(([key]) => summary[key] > 0).map(([key, word]) => `${number(summary[key])} ${word}`);
const undoErrors = { TURN_ACTIVE: ['The turn is still running.', '该轮仍在运行。'], ALREADY_UNDONE: ['These changes were already undone.', '这些更改已撤销。'],
  UNDO_UNAVAILABLE: ['No backup was kept for this turn.', '这一轮没有保留备份。'], NO_OUTPUT_CHANGES: ['No recorded changes remain.', '没有可撤销的记录。'] };

// A project-mode turn's net changes to output/, as the host observed them. Undo
// is offered once the turn has finished and a backup was kept.
export function OutputChanges({ changes, zh = false, onUndo = null }) {
  const [state, setState] = useState({ status: 'idle' });
  if (!changes) return null;
  const parts = fileCounts({ filesCreated: changes.created, filesChanged: changes.changed, filesDeleted: changes.deleted }, zh);
  const undo = async () => {
    setState({ status: 'busy' });
    try { setState({ status: 'done', result: await onUndo() }); }
    catch (error) { setState({ status: 'error', code: error?.code || 'UNDO_FAILED' }); }
  };
  const result = state.result;
  return <div className="turn-output-changes">
    <p>{zh ? 'output/ 中的文件：' : 'Files in output/:'} {parts.join(' · ')}{!changes.complete && (zh ? '（记录不完整）' : ' (record incomplete)')}</p>
    {onUndo && changes.undoAvailable && state.status !== 'done' && <button type="button" className="secondary-button" disabled={state.status === 'busy'} onClick={undo}>{zh ? '撤销这些更改' : 'Undo these changes'}</button>}
    {state.status === 'done' && <p role="status">{zh
      ? `已恢复 ${number(result.restored.length)} 个、移除 ${number(result.removed.length)} 个文件${result.conflicts.length ? `；${number(result.conflicts.length)} 个之后被编辑的文件已保留` : ''}。`
      : `Restored ${number(result.restored.length)} and removed ${number(result.removed.length)} files${result.conflicts.length ? `; kept ${number(result.conflicts.length)} edited since` : ''}.`}</p>}
    {state.status === 'error' && <p role="alert">{(undoErrors[state.code] || ['The changes could not be undone.', '无法撤销这些更改。'])[zh ? 1 : 0]}</p>}
  </div>;
}

export function TurnDetails({ details, zh = false, onUndoOutput = null }) {
  if (!details || (!details.activities?.length && !details.turnUsage?.rounds?.length && !details.artifacts?.length)) return null;
  const elapsed = details.finishedAt ? Math.max(0, details.finishedAt - details.startedAt) : null;
  const activities = (details.activities || []).slice(-160);
  return <><details className="turn-details"><summary>{elapsed !== null ? (zh ? `耗时 ${seconds(elapsed)}` : `Worked for ${seconds(elapsed)}`) : (zh ? '活动详情' : 'Activity details')} <span>{activities.filter(item => item.kind === 'tool').length} {zh ? '次工具调用' : 'tool calls'}</span></summary>
    <ol className="turn-activity-list">{activities.map(item => {
      const unsettled = Number.isFinite(details.finishedAt) && ['running', 'pending'].includes(item.status);
      const status = unsettled ? 'unknown' : item.status;
      const statusText = unsettled && item.kind === 'stage' ? (zh ? '已记录' : 'Observed') : label(status, zh);
      return <li key={item.id} className={`turn-activity-${status}`}><span className="turn-activity-icon" aria-hidden="true">{status === 'completed' ? '✓' : status === 'failed' || status === 'cancelled' ? '!' : status === 'running' ? '◌' : '·'}</span><div><strong>{item.name || stageLabel(item.stage, zh)}</strong> <span>{statusText}</span>{Number.isFinite(item.durationMs) && <small> · {seconds(item.durationMs)}</small>}{item.summary && <p className="turn-details-muted">{[item.summary.code, item.summary.sourceCount !== undefined ? `${item.summary.sourceCount} ${zh ? '个来源' : 'sources'}` : '', item.summary.referenceCount !== undefined ? `${item.summary.referenceCount} ${zh ? '条证据引用' : 'evidence references'}` : '', item.summary.resultCount !== undefined ? `${item.summary.resultCount} ${zh ? '个结果' : 'results'}` : '', ...fileCounts(item.summary, zh), item.summary.evidenceStatus].filter(Boolean).join(' · ')}</p>}</div></li>; })}</ol>
    {(details.artifacts || []).map(artifact => <ArtifactDiff key={artifact.id} artifact={artifact} zh={zh} />)}
    <UsageChart usage={details.turnUsage} zh={zh} />
    {window.BioDesignFeedback && <button type="button" className="text-button turn-report" onClick={() => window.BioDesignFeedback.open({ turnId: details.turnId, turnDetails: details }).catch(() => {})}>{zh ? '报告本轮' : 'Report this turn'}</button>}
    {details.childUsage?.length > 0 && <details><summary>{zh ? '子代理用量（单独统计）' : 'Subagent usage (separate totals)'}</summary>{details.childUsage.map(usage => <UsageChart key={usage.turnId} usage={usage} zh={zh} />)}</details>}
  </details>
  <OutputChanges changes={details.outputChanges} zh={zh} onUndo={onUndoOutput && Number.isFinite(details.finishedAt) ? () => onUndoOutput(details.turnId) : null} /></>;
}

export function installTurnDetails() {
  if (window.BioDesignTurnDetails) return window.BioDesignTurnDetails;
  const mounted = new Map();
  const disposeDetached = () => {
    for (const [element, handle] of mounted) if (!element.isConnected) handle.destroy();
  };
  const observer = new MutationObserver(disposeDetached);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.BioDesignTurnDetails = {
    disposeDetached,
    mount(element, props = {}) {
      if (mounted.has(element)) { const handle = mounted.get(element); handle.update(props); return handle; }
      const root = createRoot(element);
      const render = next => root.render(next.usageOnly ? <TurnUsagePopover {...next} /> : <TurnDetails {...next} />);
      render(props);
      const handle = { update: render, destroy: () => { if (mounted.delete(element)) root.unmount(); } };
      mounted.set(element, handle);
      return handle;
    },
  };
  return window.BioDesignTurnDetails;
}
