(function expose(root, factory) {
  const dependency = (globalName, file) => root?.[globalName] || (typeof require === 'function' ? require(file) : null);
  const api = factory(dependency('BioDesignGenericSubagent', '../shared/generic-subagent.js'),
    dependency('BioDesignGenericSubagents', './generic-subagents.js'),
    dependency('BioDesignRuntimeExtensions', '../shared/runtime-extensions.js'),
    dependency('BioDesignRuntimeTools', '../shared/runtime-tools.js'),
    dependency('BioDesignRuntimeToolRegistry', './runtime-tool-registry.js'),
    dependency('BioDesignRuntimeTurns', './runtime-turns.js'),
    dependency('BioDesignAdvancedTools', '../shared/advanced-tools.js'),
    dependency('BioDesignRuntimeStateTools', './runtime-state-tools.js'),
    dependency('BioDesignRuntimeConcurrency', '../shared/runtime-concurrency.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioDesignRuntimeSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contract, agents, runtime, tools, registryApi, turns, advanced, stateTools, concurrency) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message = code) => Object.assign(new Error(message), { code });
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const MAX_RECEIPT_CHARACTERS = 80000;
  function boundedReceipt(receipt) {
    if (JSON.stringify(receipt).length <= MAX_RECEIPT_CHARACTERS) return receipt;
    const failure = { id: receipt.id, result: { ok: false, runtimeCall: receipt.result.runtimeCall, ...(receipt.result.nestedToolCalls ? { nestedToolCalls: receipt.result.nestedToolCalls } : {}),
      error: { code: 'RUNTIME_RESULT_TOO_LARGE',
        message: 'A tool response was received but exceeds the continuation delivery limit. Its output and evidence were not delivered; existing host receipts remain intact. Do not repeat a side-effecting call. Request a narrower read of the result.' } } };
    if (JSON.stringify(failure).length > MAX_RECEIPT_CHARACTERS) throw fail('RUNTIME_CALL_TOO_LARGE', 'The original tool arguments exceed the lossless continuation delivery limit.');
    return failure;
  }
  function canonical(value) {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    throw fail('INVALID_RUNTIME_TOOL_CALL');
  }
  function serializeCompletion(completion) {
    let content;
    try { content = JSON.stringify(completion); } catch {}
    if (!content || content.length > 64000) {
      // Dropping a citation/provenance tail would turn partial evidence into an
      // apparently complete result. Report failure explicitly instead.
      return JSON.stringify({ version: 1, task_id: completion.task_id, label: completion.label,
        status: 'failed', error: 'SUBAGENT_RESULT_TOO_LARGE', evidenceStatus: 'unavailable',
        message: 'The delegated result exceeded the 64,000-character delivery limit. No result or evidence was injected. Delegate a more focused task.' });
    }
    return content;
  }
  async function create({ options, queue, service, workflow, requestChild, isCurrent, onStatus = () => {}, interaction } = {}) {
    if (!contract || !agents || !runtime || !record(options) || !queue || !service || typeof workflow !== 'function' || typeof requestChild !== 'function' || typeof isCurrent !== 'function') throw fail('RUNTIME_SESSION_UNAVAILABLE');
    const captured = { turnId: options.callContext?.turnId, projectId: options.localWorkspaceContext?.project?.workspaceId || options.desktopTools?.projectId,
      requestedModel: options.model, surface: options.mode === 'side_chat' ? 'side_chat' : 'agent_command',
      permission: options.desktopTools?.permission || options.permission || 'read_only',
      originalRequest: options.originalRequest || options.messages?.findLast(message => message.role === 'user')?.content || '', signal: options.signal };
    if (typeof captured.turnId !== 'string' || !captured.turnId || typeof captured.projectId !== 'string' || !captured.projectId) throw fail('INVALID_SUBAGENT_PARENT');
    const runtimeChild = options.runtimeChild ? contract.normalizeChild(options.runtimeChild,
      { model: captured.requestedModel, projectId: captured.projectId }) : null;
    const sessionId = globalThis.crypto.randomUUID();
    let closed = false, resolvedModel = '', manager, contextSnapshot = null;
    const lifetime = new AbortController();
    const signal = captured.signal ? AbortSignal.any([captured.signal, lifetime.signal]) : lifetime.signal;
    const permissionRank = { read_only: 0, workspace_write: 1, full_access: 2 };
    const check = () => {
      const livePermission = options.livePermission?.();
      if (livePermission !== undefined && (permissionRank[livePermission] ?? -1) < (permissionRank[captured.permission] ?? 0)) {
        lifetime.abort(); throw fail('PERMISSION_REVOKED', 'Permission was reduced; this captured turn has been cancelled.');
      }
      if (closed || signal.aborted || !isCurrent()) throw fail('OPERATION_ABORTED', 'The project request was stopped.');
    };
    const emitStatus = event => { try { Promise.resolve(onStatus(event)).catch(() => {}); } catch {} };
    check();
    const skills = await workflow('runtime_skills_context', { text: captured.originalRequest }); check();
    let catalog = Array.isArray(skills?.catalog) ? clone(skills.catalog) : [];
    const enabledSkills = new Set(catalog.filter(skill => skill.enabled === true && skill.available === true && !skill.invalid).map(skill => skill.name));
    const originalSkills = new Set(enabledSkills), revokedTools = new Set();
    const mcp = !runtimeChild && captured.surface === 'agent_command' && captured.permission === 'full_access'
      ? await workflow('runtime_mcp_definitions', {}) : { tools: [] };
    check();
    const advancedEnabled = skills.advancedRuntimeVersion === 1;
    const capabilities = advancedEnabled && !runtimeChild ? await workflow('runtime_advanced_open', { owner: sessionId, surface: captured.surface, permission: captured.permission }) : {};
    let advancedClosing;
    const closeAdvanced = () => {
      if (!advancedEnabled || runtimeChild) return Promise.resolve();
      return advancedClosing ||= workflow('runtime_advanced_close', { owner: sessionId }).catch(() => {});
    };
    if (advancedEnabled && !runtimeChild) { signal.addEventListener('abort', closeAdvanced, { once: true }); if (signal.aborted || !isCurrent()) { await closeAdvanced(); check(); } }
    const extraTools = !advancedEnabled ? [] : runtimeChild ? stateTools.boardNames : advanced.catalog.map(tool => tool.function.name).filter(name => {
      const group = advanced.group(name);
      return group === 'state' || group === 'memory_write' && typeof service.saveExplicitMemory === 'function' ||
        ['scratch','vision'].includes(group) && capabilities.scratch && typeof interaction?.confirm === 'function' || group === 'permission' && capabilities.scratch && typeof interaction?.confirm === 'function' ||
        group === 'provider' && capabilities.image && typeof interaction?.confirm === 'function' || group === 'plugins' && capabilities.plugins && typeof interaction?.confirm === 'function';
    });
    const extensions = runtime.normalize({ version: 1, skills: { catalog: JSON.stringify(catalog), active: skills?.active || [] },
      mcpTools: mcp?.tools || [], genericSubagents: !runtimeChild,
      ...(capabilities.dynamicTools?.length ? { dynamicTools: capabilities.dynamicTools } : {}),
      runtimeTools: [...extraTools, ...(runtimeChild ? [] : tools.available({ interactionAvailable: Boolean(interaction),
        mcpAvailable: mcp?.resourcesAvailable === true && captured.surface === 'agent_command' && captured.permission === 'full_access' }))],
      ...(runtimeChild ? { child: runtimeChild } : {}) });
    const mcpNames = new Set(extensions.mcpTools.map(tool => tool.function.name));
    const resources = clone((mcp.resources || []).filter(item => mcpNames.has(item.tool)));
    const resourceTemplateServers = clone(mcp.resourceTemplateServers || []);
    const receipts = new Map(), childContexts = new Map(), childQueues = new Map(), activeMcp = new Map(), undelivered = [];
    const earlyCalls = new Map();
    function executeEarly(envelope, verify) {
      check();
      if (runtimeChild || envelope.scope?.turnId !== captured.turnId || envelope.scope?.projectId !== captured.projectId ||
          captured.requestedModel !== 'default' && envelope.scope?.model !== captured.requestedModel) throw fail('INVALID_STREAM_CALL');
      if (earlyCalls.has(envelope.ticket)) return;
      const pending = (async () => {
        const verified = await verify(envelope); check();
        if (canonical(verified.scope) !== canonical(envelope.scope) || verified.call?.name !== 'host_project_status' ||
            Object.keys(verified.call.args || {}).length || !verified.identity?.step?.toolNames?.includes(verified.call.name) ||
            verified.identity.authority?.surface !== captured.surface || verified.identity.authority?.permission !== captured.permission) throw fail('INVALID_STREAM_CALL');
        const call = verified.call;
        // Authenticated ticket only bypasses the *previous* step's advertised
        // snapshot, never the registry, owner, live checks, budget or journal.
        domainCalls.set(call.id, canonical({ name: call.name, args: call.args }));
        return execute(call);
      })();
      earlyCalls.set(envelope.ticket, pending);
      pending.catch(error => emitStatus({ type: 'early-tool', status: 'failed', code: error.code || 'EARLY_TOOL_FAILED' }));
    }
    let parentTranscript = clone(options.conversationTranscript || { version: 1, turns: [], summaries: [] });
    const observeTranscript = turn => {
      check();
      if (!turn || !Array.isArray(turn.messages) || typeof turn.turnId !== 'string') throw fail('INVALID_CONVERSATION_TRANSCRIPT');
      parentTranscript = { ...parentTranscript, turns: [...(parentTranscript.turns || []).filter(item => item.turnId !== turn.turnId), clone(turn)] };
    };
    let verifiedStateContext = null;
    const state = stateTools.create({ owner: runtimeChild?.taskId || '/root', sharedBoard: options.runtimeBoard,
      context: () => verifiedStateContext || service.agentTurns?.get(captured.turnId)?.context || options.localWorkspaceContext,
      transcript: () => parentTranscript, memory: () => service.workspace?.state?.memory,
      saveMemory: note => service.saveExplicitMemory(note, { turnId: captured.turnId }),
      notify: message => { check(); queue.enqueue(JSON.stringify({ board: message }), { kind: 'subagent' }); } });
    let advertised = null, domainCatalog = [], nestedRemaining = 24;
    const nestedCounts = new Map();
    const cellPermissions = new Map(), cellReplies = new Map();
    const observeTools = (definitions, remaining) => {
      if (Number.isInteger(remaining) && remaining >= 0 && remaining <= 24) nestedRemaining = remaining;
      if (!Array.isArray(definitions)) return;
      advertised = new Set(definitions.map(tool => tool.function?.name).filter(Boolean)); domainCatalog = clone(definitions);
    };
    const pendingQuestions = new Set();
    const registry = new registryApi.Registry(check);
    const domainHandlers = new Map(), domainCalls = new Map();
    const parentIdentity = { sessionId, requestId: captured.turnId, projectId: captured.projectId };
    const parent = () => {
      if (!resolvedModel) throw fail('MODEL_NOT_RESOLVED');
      const turn = service.agentTurns?.get(captured.turnId);
      if (!turn) throw fail('OPERATION_ABORTED', 'The parent project scope is no longer available.');
      return contract.captureParent({ ...parentIdentity, model: resolvedModel,
        sourceScope: { hardSelection: turn.hardSelection, sourceIds: turn.hardSelection ? turn.selected : Object.keys(turn.sourceVersions), paths: turn.paths },
        sourceVersions: turn.sourceVersions,
        permissions: { surface: captured.surface, permission: captured.permission }, allowedTools: contract.READ_TOOLS });
    };
    manager = new agents.SubagentManager({
      prepareChild: child => {
        check();
        childContexts.set(child.taskId, service.forkAgentTurn(captured.turnId, child.taskId, child.originalRequest, captured.signal, child.parent.sourceScope.sourceIds));
        childQueues.set(child.taskId, new turns.InjectionQueue());
      },
      onMessage: (id, message) => {
        check();
        const inbox = childQueues.get(id);
        if (!inbox) throw fail('SUBAGENT_MAILBOX_UNAVAILABLE');
        inbox.enqueue(message, { kind: 'subagent' });
      },
      runChild: async (child, { signal, onTranscript }) => {
        check();
        const context = childContexts.get(child.taskId);
        const turn = service.agentTurns?.get(child.taskId);
        if (!context || !turn) throw fail('OPERATION_ABORTED');
        // Host evidence preparation must use the same resolved model as the
        // child's FC request, including an originally selected default model.
        turn.options = Object.freeze({ ...turn.options, signal,
          callContext: Object.freeze({ ...turn.options.callContext, model: child.model }) });
        try {
          const result = await requestChild(child, { context, signal, queue: childQueues.get(child.taskId), onTranscript, board: state.board }); check();
          if (!record(result)) return result;
          if (result.conversationTurn) onTranscript?.(result.conversationTurn);
          // The child journal is retained by the manager, not injected as a
          // second source of evidence or an executable continuation in its parent.
          const { conversationTurn, desktopContinuation, agentCheckpoint, ...publicResult } = result;
          return publicResult;
        }
        finally { childContexts.delete(child.taskId); childQueues.delete(child.taskId); service.agentTurns?.delete(child.taskId); }
      },
      onStatus: status => {
        if (['completed', 'failed', 'cancelled'].includes(status.status)) {
          const id = status.run_id || status.task_id;
          childContexts.delete(id); childQueues.get(id)?.cancel(); childQueues.delete(id); service.agentTurns?.delete(id);
        }
        emitStatus({ type: 'subagent', ...status });
      },
    });
    const bindModel = model => {
      check();
      if (typeof model !== 'string' || !model || model === 'default' || model.length > 300) throw fail('MODEL_NOT_RESOLVED');
      if ((resolvedModel && resolvedModel !== model) || (captured.requestedModel && captured.requestedModel !== 'default' && captured.requestedModel !== model)) throw fail('SUBAGENT_MODEL_CHANGED');
      resolvedModel = model;
      return model;
    };
    function observeContext(snapshot) {
      check();
      if (!snapshot) return;
      if (snapshot.estimated !== true || !['tokens_left', 'input_budget_tokens'].every(key => snapshot[key] === null || Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0)
        || !['estimated_input_tokens', 'output_reserve_tokens'].every(key => Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0)
        || typeof snapshot.measured_at !== 'string' || !Number.isFinite(Date.parse(snapshot.measured_at))) throw fail('INVALID_RUNTIME_CONTEXT');
      contextSnapshot = { tokens_left: snapshot.tokens_left, input_budget_tokens: snapshot.input_budget_tokens,
        estimated_input_tokens: snapshot.estimated_input_tokens, output_reserve_tokens: snapshot.output_reserve_tokens,
        estimated: true, measured_at: snapshot.measured_at,
        ...( ['oss','local_filesystem'].includes(snapshot.archiveDurability) ? { archiveDurability: snapshot.archiveDurability } : {}),
        ...(snapshot.providerCapabilities && ['chat_completions','responses'].includes(snapshot.providerCapabilities.api) ? { providerCapabilities: clone(snapshot.providerCapabilities) } : {}) };
    }
    const skillRead = async call => {
      if (runtimeChild && !runtimeChild.allowedTools.includes('read_skill')) throw fail('SUBAGENT_TOOL_DENIED');
      if (Object.keys(call.args).some(key => key !== 'name') || !enabledSkills.has(call.args.name)) throw fail('SKILL_UNAVAILABLE');
      const { content, ...skill } = await workflow('runtime_skills_read', { name: call.args.name, forAgent: true });
      return { ...skill, body: skill.body ?? content };
    };
    const mcpCall = async call => {
      if (runtimeChild || captured.surface !== 'agent_command' || captured.permission !== 'full_access') throw fail('RUNTIME_TOOL_NOT_ALLOWED');
      const callId = `${sessionId}:${call.id}`;
      let cancellation;
      const cancel = () => {
        if (cancellation) return cancellation;
        try { cancellation = Promise.resolve(workflow('runtime_mcp_cancel', { callId })).catch(() => {}); }
        catch { cancellation = Promise.resolve(); }
        return cancellation;
      };
      check(); activeMcp.set(callId, cancel);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        check();
        return await workflow('runtime_mcp_call', { call: { ...clone(call), id: callId }, surface: captured.surface, permission: captured.permission });
      } finally { signal.removeEventListener('abort', cancel); activeMcp.delete(callId); }
    };
    const sleep = duration => new Promise((resolve, reject) => {
      const start = performance.now();
      let timer;
      const finish = (error, interrupted = false) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve({ elapsed_ms: Math.round(performance.now() - start), interrupted });
      };
      const abort = () => finish(fail('OPERATION_ABORTED'));
      const tick = () => {
        try { check(); } catch (error) { finish(error); return; }
        if (queue.batch().some(item => item.kind === 'user')) { finish(null, true); return; }
        const remaining = duration - (performance.now() - start);
        if (remaining <= 0) finish(null); else timer = setTimeout(tick, Math.min(remaining, 100));
      };
      signal.addEventListener('abort', abort, { once: true }); tick();
    });
    async function builtin(call) {
      tools.validate(call.name, call.args);
      const args = call.args;
      switch (call.name) {
        case 'clock_curr_time': return { current_time: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC' };
        case 'get_context_remaining':
          if (!contextSnapshot) throw fail('RUNTIME_CONTEXT_UNAVAILABLE', 'No model-request measurement is available for this turn.');
          return clone(contextSnapshot);
        case 'clock_sleep': return sleep(args.duration_ms);
        case 'update_plan': {
          const plan = clone(args);
          interaction?.plan(plan); emitStatus({ type: 'plan', status: 'updated', ...plan });
          return { updated: true, ...plan };
        }
        case 'skills_list': return { skills: catalog.filter(skill => enabledSkills.has(skill.name)).map(clone) };
        case 'skills_read': return skillRead(call);
        case 'tool_search': {
          const words = args.query.toLowerCase().split(/\s+/);
          const definitions = new Map([...domainCatalog, ...registry.definitions().filter(tool => !domainHandlers.has(tool.function.name) && (!advertised || advertised.has(tool.function.name)))].map(tool => [tool.function.name, tool]));
          const matches = [...definitions.values()].filter(tool => !revokedTools.has(tool.function.name) && words.every(word => `${tool.function.name} ${tool.function.description}`.toLowerCase().includes(word)));
          return { tools: matches.slice(0, args.limit || 10), total: matches.length };
        }
        case 'list_mcp_resources': {
          const items = resources.filter(item => !revokedTools.has(item.tool) && (!args.server || item.server === args.server));
          const prefix = `resource:${sessionId}:${args.server || '*'}:`;
          const offset = args.cursor ? Number(args.cursor.slice(prefix.length)) : 0;
          if (args.cursor && (!args.cursor.startsWith(prefix) || !/^\d+$/.test(args.cursor.slice(prefix.length)) || !Number.isSafeInteger(offset) || offset >= items.length)) throw fail('INVALID_RESOURCE_CURSOR');
          const end = Math.min(offset + 20, items.length);
          return { resources: items.slice(offset, end).map(({ tool, ...item }) => item),
            ...(end < items.length ? { nextCursor: prefix + end } : {}) };
        }
        case 'read_mcp_resource': {
          const matches = resources.filter(item => item.server === args.server && item.uri === args.uri);
          if (!matches.length) throw fail('MCP_TOOL_NOT_ALLOWED');
          if (matches.length !== 1) throw fail('MCP_RESOURCE_AMBIGUOUS');
          const resource = matches[0];
          return mcpCall({ ...call, name: resource.tool, args: {} });
        }
        case 'list_mcp_resource_templates': {
          const servers = resourceTemplateServers.filter(item => !args.server || item.server === args.server);
          if (args.server && !servers.length) throw fail('MCP_TOOL_NOT_ALLOWED');
          const pages = [];
          for (const item of servers) pages.push(await mcpCall({ id: `${call.id}:templates:${item.server}`, name: item.tool,
            args: args.cursor ? { cursor: args.cursor } : {} }));
          return { pages };
        }
        case 'send_message_to_user_async':
          interaction.message(args.message); return { accepted: true };
        case 'request_user_input': case 'request_user_input_async': {
          if (pendingQuestions.size >= 4) throw fail('USER_INPUT_LIMIT');
          const async = call.name === 'request_user_input_async';
          const questions = async ? args.questions.map((item, i) => ({ id: `q${i + 1}`, question: item.title, options: (item.options || []).map(label => ({ label })) })) : args.questions;
          const deliver = value => {
            check();
            if (async && value) queue.enqueue(JSON.stringify({ request_id: call.id, questions, answers: value.answers }), { id: `user:${globalThis.crypto.randomUUID()}`, kind: 'user' });
          };
          const request = interaction.ask({ questions: clone(questions), signal, asynchronous: async, deliver });
          pendingQuestions.add(request);
          const answer = Promise.resolve(request.answer).then(value => {
            check();
            return value || { answers: {}, cancelled: true };
          }).finally(() => { clearInterval(watch); pendingQuestions.delete(request); });
          // Source-selection changes invalidate the captured turn even when the
          // owning UI has not aborted its signal yet. Never strand a question.
          const watch = setInterval(() => { if (!isCurrent()) { lifetime.abort(); request.close(); } }, 100);
          if (!async) return answer;
          // A cancelled/closed async question has no answer and grants nothing.
          answer.catch(error => { if (!closed && !signal.aborted) emitStatus({ type: 'interaction', status: 'failed', error: error.code || 'USER_INPUT_FAILED' }); });
          return { accepted: true };
        }
        default: throw fail('RUNTIME_TOOL_NOT_ALLOWED');
      }
    }
    async function approve(title) {
      check();
      if (!interaction?.confirm) throw fail('APPROVAL_UI_UNAVAILABLE');
      const result = await interaction.confirm({ title, signal }); check(); return result === true;
    }
    async function extendedCall(call) {
      if (advanced.has(call.name)) tools.validate(call.name, call.args);
      const group = advanced.group(call.name);
      if (group === 'state' || group === 'memory_write') {
        if (/^(history_|memories_)/.test(call.name)) {
          if (typeof service.runtimeStateContext !== 'function') throw fail('SOURCE_VERIFICATION_UNAVAILABLE');
          verifiedStateContext = await service.runtimeStateContext(captured.turnId); check();
        }
        if (call.name === 'post' && call.args.target_agent) manager.resolve(call.args.target_agent, parentIdentity);
        const result = await state.call(call.name, call.args);
        if (call.name === 'post' && call.args.target_agent) {
          try { result.notification = manager.sendMessage(call.args.target_agent, JSON.stringify({ board_post: result }), parentIdentity); }
          catch (error) { result.notification = { delivered: false, error: error.code }; }
        }
        return result;
      }
      if (call.name === 'request_permissions') {
        if (!await approve('Allow isolated scratch execution for this turn? No project files, network or browser access. Reason: ' + call.args.reason)) return { granted: false, capability: call.args.capability };
        return workflow('runtime_advanced_grant', { owner: sessionId });
      }
      let result = await workflow('runtime_advanced_call', { owner: sessionId, call }); check();
      if (call.name === 'request_plugin_install') {
        if (!await approve('Import this plugin bundle disabled? ' + JSON.stringify(result.preview))) return { installed: false, declined: true };
        return workflow('runtime_advanced_install', { owner: sessionId, plugin_id: call.args.plugin_id, digest: result.preview.digest, call_id: call.id });
      }
      if (call.name === 'run_code') cellPermissions.set(result.cell_id, new Set(advertised || registry.definitions().map(tool => tool.function.name)));
      if (['run_code', 'wait_code'].includes(call.name)) {
        const permitted = cellPermissions.get(result.cell_id);
        if (!permitted) throw fail('CELL_NOT_FOUND');
        // Execute only explicit runtime subcalls. Root-only coordination and
        // recursive evaluators cannot use Code Mode to multiply authority/budgets.
        const outputStart = result.output_start, stderrStart = result.stderr_start;
        let rounds = 0; const outputs = [], errors = [], media = [];
        while (result.tool_calls?.length && rounds++ < 24) {
          if (result.output) outputs.push(result.output);
          if (result.stderr) errors.push(result.stderr);
          const replies = [];
          for (const subcall of result.tool_calls) {
            const key = canonical(subcall);
            if (!cellReplies.has(key)) {
              const withinBudget = nestedRemaining > 0;
              if (withinBudget) { nestedRemaining--; nestedCounts.set(call.id, (nestedCounts.get(call.id) || 0) + 1); }
              const denied = !withinBudget || domainHandlers.has(subcall.name) || !permitted.has(subcall.name) || advertised && !advertised.has(subcall.name) || contract.isAgentTool(subcall.name) ||
                ['spawn','run_code','wait_code','request_permissions','request_plugin_install','apply_patch','view_image','image_gen_imagegen'].includes(subcall.name) || /^mcp_/.test(subcall.name);
              cellReplies.set(key, denied ? Promise.resolve({ id: subcall.id, result: { ok: false, error: { code: 'NESTED_TOOL_DENIED', message: 'This tool is not available to the cell.' } } }) : execute(subcall).catch(error => ({ id: subcall.id, result: { ok: false, error: { code: error.code || 'NESTED_TOOL_FAILED', message: error.message } } })));
            }
            const reply = await cellReplies.get(key);
            for (const item of reply.result?.value?.content || []) if (item.type === 'image') media.push({ ...item, originating_call_id: subcall.id });
            replies.push(reply);
          }
          result = await workflow('runtime_advanced_reply', { owner: sessionId, cell_id: result.cell_id, results: replies }); check();
        }
        if ((JSON.stringify(outputs.join('') + (result.output || '')).length > 16000 || JSON.stringify(errors.join('') + (result.stderr || '')).length > 4000) && Number.isInteger(outputStart)) {
          // Intermediate subcall polls consumed chunks. Reread one bounded chunk
          // from the retained cell buffer, resetting its continuation cursor.
          result = await workflow('runtime_advanced_call', { owner: sessionId, call: { id: call.id + ':output', name: 'wait_code',
            args: { cell_id: result.cell_id, output_cursor: outputStart, stderr_cursor: stderrStart || 0, yield_time_ms: 0 } } }); check();
        } else { result.output = outputs.join('') + (result.output || ''); result.stderr = errors.join('') + (result.stderr || ''); if (Number.isInteger(outputStart)) result.output_start = outputStart; if (Number.isInteger(stderrStart)) result.stderr_start = stderrStart; }
        if (media.length) {
          result.content = media.map(item => ({ type: 'image', mimeType: item.mimeType, originating_call_id: item.originating_call_id, delivered_as_pixels: false, omission_reason: 'CELL_IMAGE_DELIVERY_LIMIT' }));
          for (let i = media.length - 1; i >= 0; i--) {
            const omitted = result.content[i]; result.content[i] = media[i];
            if (JSON.stringify(result).length + JSON.stringify(call).length > 70000) result.content[i] = omitted;
          }
        }
      }
      interaction?.result?.(result);
      return result;
    }
    async function agentCall(call) {
      contract.validateAgentCall(call.name, call.args);
      const args = call.args, owner = parent();
      if (call.name === 'spawn_agent') {
        const receipt = await manager.spawn({ task: args.message, label: args.task_name }, owner, {
          signal, callId: call.id, taskName: `/root/${args.task_name}`,
          conversationTranscript: contract.forkHistory(parentTranscript, args.fork_turns || 'all'),
        });
        return { agent_id: receipt.task_id, task_name: receipt.task_name, status: receipt.status };
      }
      if (call.name === 'send_message') return manager.sendMessage(args.target, args.message, owner);
      if (call.name === 'followup_task') return manager.followup(args.target, args.message, owner);
      if (call.name === 'interrupt_agent') return manager.interrupt(args.target, owner);
      if (call.name === 'list_agents') return { agents: manager.list(owner).filter(item => item.reusable && (!args.path_prefix || item.task_name === args.path_prefix || item.task_name.startsWith(args.path_prefix + '/'))) };
      if (call.name === 'wait_agent') return manager.waitForUpdate(owner, { signal, timeoutMs: args.timeout_ms, interrupted: () => queue.hasPending() || !isCurrent() });
      throw fail('RUNTIME_TOOL_NOT_ALLOWED');
    }
    for (const definition of runtime.definitions(extensions, captured.surface, captured.permission, contract.spawnTool)) {
      const name = definition.function.name;
      registry.register(definition, name === 'read_skill' ? skillRead : name === 'spawn' ? async call => {
        const value = await manager.spawn(call.args, parent(), { signal, callId: call.id });
        return call.args.wait === true ? JSON.parse(serializeCompletion(value)) : value;
      } : contract.isAgentTool(name) ? agentCall : mcpNames.has(name) ? mcpCall : advanced.has(name) || name.startsWith('host_') ? extendedCall : builtin, {
        coordinator: ['run_code', 'wait_code'].includes(name),
        parallelSafe: concurrency.parallelSafe(name),
      });
    }
    let totalAdmissions = 0;
    async function execute(call) {
      check();
      if (!record(call) || typeof call.id !== 'string' || !call.id || call.id.length > 160 || typeof call.name !== 'string' || !record(call.args || {})) throw fail('INVALID_RUNTIME_TOOL_CALL');
      call = { ...call, args: call.args || {} };
      const fingerprint = canonical({ name: call.name, args: call.args || {} });
      const prior = receipts.get(call.id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail('RUNTIME_RECEIPT_CONFLICT');
        const value = await prior.promise; check(); return clone(value);
      }
      if (advancedEnabled && ++totalAdmissions > 24) throw fail('TOOL_BUDGET_EXCEEDED');
      if (revokedTools.has(call.name)) throw fail('TOOL_CAPABILITY_REVOKED');
      if (advertised && !advertised.has(call.name) && domainCalls.get(call.id) !== fingerprint) throw fail('STEP_TOOL_NOT_ADVERTISED');
      const promise = (async () => {
        const runtimeCall = { name: call.name, args: clone(call.args) };
        try {
          if (runtimeChild && call.name === 'spawn') throw fail('SUBAGENT_RECURSION_DENIED');
          if (runtimeChild && call.name === 'read_skill' && !runtimeChild.allowedTools.includes('read_skill')) throw fail('SUBAGENT_TOOL_DENIED');
          const value = await registry.execute(call);
          check();
          if (domainHandlers.has(call.name)) return value;
          return boundedReceipt({ id: call.id, result: { ok: true, runtimeCall, value, ...(nestedCounts.has(call.id) ? { nestedToolCalls: nestedCounts.get(call.id) } : {}) } });
        } catch (error) {
          check();
          if (domainHandlers.has(call.name)) throw error;
          if (['OPERATION_ABORTED', 'RUNTIME_CALL_TOO_LARGE'].includes(error?.code)) throw error;
          return boundedReceipt({ id: call.id, result: { ok: false, runtimeCall, ...(nestedCounts.has(call.id) ? { nestedToolCalls: nestedCounts.get(call.id) } : {}),
            error: { code: /^[A-Z_]{1,100}$/.test(error?.code || '') ? error.code : 'RUNTIME_TOOL_FAILED',
              message: String(error?.message || 'The runtime tool failed.').slice(0, 1000) } } });
        }
      })();
      receipts.set(call.id, { fingerprint, promise });
      return clone(await promise);
    }
    async function executeDomain(call, handler) {
      check();
      // Only the trusted signed-handoff consumer installs these service handlers.
      // Preserve their canonical domain receipts (including evidence and acquisition state).
      if (registry.has(call.name) && !domainHandlers.has(call.name)) throw fail('RUNTIME_TOOL_COLLISION');
      domainHandlers.set(call.name, handler);
      if (!registry.has(call.name)) registry.register({ type: 'function', function: { name: call.name, description: 'Internal authorized domain handoff' } }, input => domainHandlers.get(input.name)(input));
      domainCalls.set(call.id, canonical({ name: call.name, args: call.args || {} }));
      return execute(call);
    }
    async function executeBatch(calls) {
      check();
      // A batch is accepted only after the signed handoff. Drain all admitted
      // work before propagating cancellation; never retry partially run batches.
      const outcomes = await Promise.allSettled(calls.map(execute));
      check();
      const failure = outcomes.find(item => item.status === 'rejected');
      if (failure) throw failure.reason;
      return outcomes.map(item => item.value);
    }
    function drain() {
      undelivered.push(...manager.drain(parentIdentity));
      while (undelivered.length) {
        const completion = undelivered[0];
        queue.enqueue(serializeCompletion(completion), { id: `completion:${completion.run_id || completion.task_id}`, kind: 'subagent', taskId: completion.task_id });
        undelivered.shift();
      }
    }
    async function atCheckpoint(data = {}) {
      check();
      queue.acknowledge(Array.isArray(data.runtimeAccepted) ? data.runtimeAccepted : []);
      const final = data.agentCheckpoint?.final === true;
      drain();
      if (final) { await manager.waitForIdle(parentIdentity); check(); drain(); }
      if (advancedEnabled) {
        const refreshed = await workflow('runtime_skills_context', { text: captured.originalRequest }); check();
        catalog = clone(refreshed.catalog || []).filter(item => originalSkills.has(item.name));
        enabledSkills.clear();
        for (const item of catalog) if (item.enabled && item.available && !item.invalid) enabledSkills.add(item.name);
        if (mcpNames.size) {
          const live = await workflow('runtime_mcp_definitions', {}); check();
          const available = new Map((live.tools || []).map(tool => [tool.function.name, canonical(tool)]));
          for (const definition of extensions.mcpTools) if (available.get(definition.function.name) !== canonical(definition)) revokedTools.add(definition.function.name);
        }
        if (typeof service.runtimeStateContext === 'function') {
          const context = await service.runtimeStateContext(captured.turnId); check();
          const turn = service.agentTurns?.get(captured.turnId);
          const old = turn?.context?.sourceMap?.paperSources || [];
          const current = new Map((context.sourceMap?.paperSources || []).map(s => [s.sourceId,s.contentHash]));
          if (old.some(s => { const version = turn?.sourceVersions?.[s.sourceId] || s.contentHash; return version && current.get(s.sourceId) !== version; })) {
            lifetime.abort(); throw fail('SOURCE_SCOPE_INVALIDATED', 'A captured source changed; start a new turn to prepare current evidence.');
          }
          verifiedStateContext = context;
        }
      }
      const injections = queue.batch();
      const shouldContinue = !final || injections.length > 0;
      if (!shouldContinue && !queue.finish()) throw fail('INJECTION_QUEUE_RACE');
      return { injections, shouldContinue, revokedTools: [...revokedTools] };
    }
    async function close() {
      if (closed) return;
      closed = true;
      clearInterval(authorityWatch);
      lifetime.abort();
      try {
        await Promise.allSettled([...activeMcp.values()].map(cancel => cancel()));
        await closeAdvanced(); signal.removeEventListener('abort', closeAdvanced);
        await Promise.allSettled([...earlyCalls.values()]); earlyCalls.clear();
        await manager.close();
        state.close(); if (!options.runtimeBoard) state.board.closed = true;
        for (const id of childContexts.keys()) service.agentTurns?.delete(id);
        childContexts.clear(); childQueues.clear(); receipts.clear(); undelivered.length = 0;
        for (const request of pendingQuestions) request.close();
        pendingQuestions.clear(); interaction?.close(); registry.clear();
      } finally {
        scopeTurn.runtimeUsers = Math.max(0, (Number(scopeTurn.runtimeUsers) || 0) - 1);
        service.pruneAgentTurns?.();
      }
    }
    // Acquire only after successful setup. Retain the actual scope object so
    // closing an old session never releases a replacement using the same ID.
    const scopeTurn = service.agentTurns?.get(captured.turnId);
    if (!scopeTurn) throw fail('OPERATION_ABORTED', 'The project scope is no longer available.');
    scopeTurn.runtimeUsers = (Number(scopeTurn.runtimeUsers) || 0) + 1;
    const authorityWatch = setInterval(() => { try { check(); } catch { lifetime.abort(); } }, 200);
    authorityWatch.unref?.();
    return { extensions, signal, execute, executeEarly, executeDomain, executeBatch, atCheckpoint, close, bindModel, observeContext, observeTranscript, observeTools, acknowledge: ids => queue.acknowledge(ids), manager, parent: parentIdentity };
  }
  return { create, serializeCompletion };
});
