const ratio = (a, b) => b ? a / b : null;
export function scoreLiterature({ data, labels, topics, elapsedMs, mode, inputUsdPerMillion, outputUsdPerMillion }) {
  const selection = data.academicSelection?.shortlist || [];
  const sources = new Map((data.academicSources || []).map(p => [p.paper_ref, p]));
  const key = item => sources.get(item.paper_ref)?.doi || item.paper_ref;
  const unique = new Set(selection.map(key));
  const judged = selection.map(item => labels?.[key(item)]).filter(item => typeof item?.relevant === 'boolean' && Array.isArray(item.topics));
  const completeJudgments = selection.length > 0 && judged.length === selection.length;
  const covered = new Set(judged.filter(item => item.relevant).flatMap(item => item.topics || []));
  const downloads = data.downloadResults || [], saved = downloads.filter(item => item.status === 'downloaded');
  const model = data.academicSearchStatus?.model || {};
  const priced = Number.isFinite(inputUsdPerMillion) && inputUsdPerMillion >= 0 && Number.isFinite(outputUsdPerMillion) && outputUsdPerMillion >= 0 && Number.isFinite(model.input_tokens) && Number.isFinite(model.output_tokens);
  return { mode, selected: selection.length, saved: saved.length, requested: data.taskOutcome?.requestedPaperCount ?? null,
    relevance_precision: completeJudgments ? ratio(judged.filter(item => item.relevant).length, selection.length) : null,
    topic_coverage: completeJudgments ? ratio(topics.filter(topic => covered.has(topic)).length, topics.length) : null,
    selection_duplicate_rate: ratio(selection.length - unique.size, selection.length),
    download_success_rate: ratio(saved.length, downloads.length),
    latency_ms: elapsedMs, search_ms: data.academicSearchStatus?.discoveryMs ?? null, model_ms: model.latency_ms ?? null,
    model_calls: model.calls ?? null, input_tokens: model.input_tokens ?? null, output_tokens: model.output_tokens ?? null,
    estimated_model_cost_usd: priced ? (model.input_tokens * inputUsdPerMillion + model.output_tokens * outputUsdPerMillion) / 1e6 : null,
    stop_reason: data.taskOutcome?.stopReason ?? null, judgments_complete: completeJudgments,
    cost_basis: priced ? 'Observed token counts and explicitly supplied per-million-token prices; not a billing invoice.' : 'Unmeasured: no complete model usage and price pair. Replay makes no paid calls.',
  };
}
