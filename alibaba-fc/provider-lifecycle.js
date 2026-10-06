'use strict';
const { readEvents } = require('./shared/event-stream.js');
const { checkContextSize } = require('./requesty-tool-context.js');
const fail = code => Object.assign(new Error(code), { code });
const clone = value => JSON.parse(JSON.stringify(value));
const profile = config => require('node:crypto').createHash('sha256').update(JSON.stringify([config.api,config.endpoint,config.model,config.reasoning || null])).digest('hex');
// Configuration is server-owned and keyed by the selected BioDesign model ID.
// Never guess protocol support from a model's name.
function configuration(env, model) {
  const entry = JSON.parse(env.AGENT_PROVIDER_ADAPTERS_JSON || '{}')[model];
  if (!entry) return { api: 'chat_completions', completedToolBoundary: false, dispatch: 'complete_response' };
  const url = new URL(entry.endpoint);
  if (entry.api !== 'responses' || url.protocol !== 'https:' || url.username || url.password || !entry.model || !env[entry.apiKeyEnv]) throw fail('INVALID_AGENT_PROVIDER_CONFIG');
  return { ...entry, endpoint: url.href, apiKey: env[entry.apiKeyEnv], completedToolBoundary: true, dispatch: 'completed_output_item', supportsTools: entry.supportsTools === true, supportsImages: entry.supportsImages === true, supportsWebSearch: entry.webSearch?.adapter === 'responses_web_search' };
}
function capabilities(config) {
  return { api: config.api, completedToolBoundary: config.completedToolBoundary, dispatch: config.dispatch,
    reasoningReplay: config.api === 'responses' ? 'ordered_native_items' : 'provider_chat_metadata', contextContinuation: 'explicit_history', supportsTools: config.supportsTools, supportsImages: config.supportsImages, supportsWebSearch: config.supportsWebSearch };
}
function inputContent(content, config) {
  if (typeof content === 'string') return content;
  return (content || []).map(part => {
    if (['text', 'input_text'].includes(part.type)) return { type: 'input_text', text: part.text };
    if (part.type === 'image_url' && config.supportsImages) return { type: 'input_image', image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
    if (part.type === 'input_image' && config.supportsImages) return clone(part);
    throw fail('PROVIDER_CONTENT_UNSUPPORTED');
  });
}
function requestBody(chat, config) {
  const input = [];
  for (const message of chat.messages) {
    if (message.role === 'tool') { input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: inputContent(message.content, config) }); continue; }
    if (message.role === 'assistant') {
      if (message.provider_context && message.provider_context.profile !== profile(config)) throw fail('PROVIDER_CONTEXT_MISMATCH');
      if (message.provider_context?.items) {
        if (message.provider_context.items.some(item => !['message', 'reasoning', 'function_call', 'web_search_call'].includes(item?.type) || item.type === 'message' && item.role && item.role !== 'assistant')) throw fail('PROVIDER_ITEM_UNSUPPORTED');
        input.push(...clone(message.provider_context.items)); continue;
      }
      // Read older saved continuations without inventing ordering that was not retained.
      for (const item of message.provider_context?.reasoning || []) input.push(clone(item));
      if (message.content) input.push({ role: 'assistant', content: typeof message.content === 'string' ? [{ type: 'output_text', text: message.content }] : message.content });
      for (const call of message.tool_calls || []) {
        if (call.type !== 'function') throw fail('PROVIDER_TOOL_UNSUPPORTED');
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    } else input.push({ role: message.role, content: inputContent(message.content, config) });
  }
  const tools = (chat.tools || []).map(tool => {
    // Translate BioDesign's existing hosted-search capability, not Codex web tools.
    if (tool.type === 'web_search' && config.supportsWebSearch) return { type: 'web_search' };
    if (tool.type !== 'function') throw fail('PROVIDER_TOOL_UNSUPPORTED'); return { type: 'function', ...tool.function }; });
  return { model: config.model, input, ...(chat.response_format?.type === 'json_object' ? { text: { format: { type: 'json_object' } } } : {}), store: false, include: ['reasoning.encrypted_content'], max_output_tokens: chat.max_tokens,
    ...(tools.length ? { tools } : {}), ...(config.reasoning ? { reasoning: clone(config.reasoning) } : {}),
    ...(config.supportsTemperature === true ? { temperature: chat.temperature } : {}) };
}
function normalize(response, config) {
  if (response.status !== 'completed') throw fail(response.status === 'incomplete' ? 'PROVIDER_INCOMPLETE' : 'PROVIDER_RESPONSE_FAILED');
  const output = response.output || [], calls = [], text = [];
  for (const item of output) {
    if (item.type === 'function_call') { if (item.status !== 'completed' || !item.call_id || !item.name || typeof item.arguments !== 'string') throw fail('PROVIDER_CALL_INVALID'); calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }); }
    if (!['message', 'reasoning', 'function_call', 'web_search_call'].includes(item.type)) throw fail('PROVIDER_ITEM_UNSUPPORTED');
    if (item.type === 'web_search_call' && !config.supportsWebSearch) throw fail('PROVIDER_ITEM_UNSUPPORTED');
    if (item.type === 'message') for (const part of item.content || []) {
      if (part.type === 'output_text') text.push(part.text);
      else if (part.type === 'refusal') text.push(part.refusal);
    }
  }
  const explicit = typeof response.end_turn === 'boolean' ? response.end_turn : output.findLast(item => item.type === 'message')?.end_turn;
  const message = checkContextSize({ role: 'assistant', content: text.join('') || null, ...(calls.length ? { tool_calls: calls } : {}),
    ...(typeof explicit === 'boolean' ? { end_turn: explicit } : {}), provider_context: { api: 'responses', profile: profile(config), items: clone(output) },
    ...(output.findLast(item => item.type === 'message')?.phase ? { phase: output.findLast(item => item.type === 'message').phase } : {}) });
  if (!message.content && !calls.length && explicit !== false) throw fail('EmptyLlmResponse');
  return { ok: true, message, providerMessage: message, attempts: 1, finishReason: 'completed', ...require('./shared/web-search.js').normalizeResponse(response, 'responses'), providerLifecycle: { responseId: response.id, status: response.status }, usage: response.usage };
}
async function responses(config, chat, { signal, onText = async () => {}, onCompletedCall = async () => {}, fetchImpl = fetch } = {}) {
  let emitted = false;
  try {
    const response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...requestBody(chat, config), stream: true }) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      // Preserve classified quota measurements/cooldowns, not raw provider
      // error prose (which may contain credentials or request contents).
      const inputQuota = require('./input-quota.js').inputQuota({ status: response.status, error: body.error, headers: response.headers });
      const error = ['context_length_exceeded','rate_limit_exceeded','insufficient_quota','model_not_found','invalid_api_key'].includes(body.error?.code) ? body.error.code : 'PROVIDER_REQUEST_FAILED';
      const contextOverflow = inputQuota ? null : require('./context-recovery.js').overflow({ status: response.status, error: body.error });
      return { ok: false, status: response.status, error, attempts: 1, usage: body.usage,
        ...(contextOverflow ? { verifiedContextLengthError: true, contextOverflow } : {}), ...(inputQuota ? { inputQuota } : {}) };
    }
    if (!/text\/event-stream/i.test(response.headers.get('content-type') || '')) return { ...normalize(await response.json(), config), providerCapabilities: { ...capabilities(config), dispatch: 'complete_response', transport: 'json' } };
    let completed, responseId; const items = new Map(), calls = new Set();
    await readEvents(response, async event => {
      const data = JSON.parse(event.data);
      if (data.type === 'response.created') { if (responseId) throw fail('STREAM_IDENTITY_CONFLICT'); responseId = data.response?.id; }
      if (data.type === 'response.output_text.delta') await onText(String(data.delta || ''));
      if (data.type === 'response.output_item.done') {
        const item = checkContextSize(data.item);
        if (!responseId || !item?.id || !Number.isInteger(data.output_index) || data.output_index < 0 || data.output_index > 63) throw fail('STREAM_IDENTITY_CONFLICT');
        const previous = items.get(data.output_index);
        if (previous) { if (JSON.stringify(previous) !== JSON.stringify(item)) throw fail('STREAM_IDENTITY_CONFLICT'); return; }
        items.set(data.output_index, clone(item));
        if (item.type === 'function_call') {
          if (item.status !== 'completed' || !/^[\w:-]{1,160}$/.test(item.call_id || '') || calls.has(item.call_id)) throw fail('STREAM_IDENTITY_CONFLICT');
          calls.add(item.call_id);
          // Parsing alone never admits a call. Only the completed output item does.
          const args = JSON.parse(item.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('PROVIDER_CALL_INVALID');
          emitted = true; await onCompletedCall({ id: item.call_id, name: item.name, args }, { responseId, itemId: item.id, index: data.output_index });
        }
      }
      if (['response.failed','response.incomplete','error'].includes(data.type)) throw fail('STREAM_INTERRUPTED');
      if (data.type === 'response.completed') {
        if (!responseId || data.response?.id !== responseId) throw fail('STREAM_IDENTITY_CONFLICT');
        completed = data.response;
        for (const [index,item] of items) if (JSON.stringify(completed.output?.[index]) !== JSON.stringify(item)) throw fail('STREAM_IDENTITY_CONFLICT');
        return false;
      }
    }, { signal });
    if (!completed) throw fail('STREAM_INTERRUPTED');
    return { ...normalize(completed, config), providerCapabilities: { ...capabilities(config), transport: 'sse' } };
  } catch (error) {
    if (signal?.aborted) throw fail('OPERATION_ABORTED');
    // Never retry a provider stream after completed calls have been admitted.
    const code = ['STREAM_INTERRUPTED','STREAM_IDENTITY_CONFLICT','STREAM_TOO_LARGE','PROVIDER_TOOL_CONTEXT_LIMIT','PROVIDER_TOOL_UNSUPPORTED','PROVIDER_CONTEXT_MISMATCH','PROVIDER_CONTENT_UNSUPPORTED','PROVIDER_CALL_INVALID','PROVIDER_ITEM_UNSUPPORTED','PROVIDER_INCOMPLETE','PROVIDER_RESPONSE_FAILED','EmptyLlmResponse'].includes(error.code) ? error.code : 'STREAM_INTERRUPTED';
    return { ok: false, error: code, attempts: 1, terminalProviderFailure: emitted, earlyCallsPossible: emitted };
  }
}
module.exports = { configuration, capabilities, requestBody, normalize, responses, profile };
