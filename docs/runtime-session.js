(function expose(root, factory) {
  const dependency = (globalName, file) => root?.[globalName] || (typeof require === 'function' ? require(file) : null);
  const api = factory(dependency('BioDesignGenericSubagent', '../shared/generic-subagent.js'),
    dependency('BioDesignGenericSubagents', './generic-subagents.js'),
    dependency('BioDesignRuntimeExtensions', '../shared/runtime-extensions.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioDesignRuntimeSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contract, agents, runtime) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message = code) => Object.assign(new Error(message), { code });
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const MAX_RECEIPT_CHARACTERS = 80000;
  function boundedReceipt(receipt) {
    if (JSON.stringify(receipt).length <= MAX_RECEIPT_CHARACTERS) return receipt;
    const failure = { id: receipt.id, result: { ok: false, runtimeCall: receipt.result.runtimeCall,
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
  async function create({ options, queue, service, workflow, requestChild, isCurrent, onStatus = () => {} } = {}) {
    if (!contract || !agents || !runtime || !record(options) || !queue || !service || typeof workflow !== 'function' || typeof requestChild !== 'function' || typeof isCurrent !== 'function') throw fail('RUNTIME_SESSION_UNAVAILABLE');
    const captured = { turnId: options.callContext?.turnId, projectId: options.localWorkspaceContext?.project?.workspaceId || options.desktopTools?.projectId,
      requestedModel: options.model, surface: options.mode === 'side_chat' ? 'side_chat' : 'agent_command',
      permission: options.desktopTools?.permission || options.permission || 'read_only',
      originalRequest: options.originalRequest || options.messages?.findLast(message => message.role === 'user')?.content || '', signal: options.signal };
    if (typeof captured.turnId !== 'string' || !captured.turnId || typeof captured.projectId !== 'string' || !captured.projectId) throw fail('INVALID_SUBAGENT_PARENT');
    const runtimeChild = options.runtimeChild ? contract.normalizeChild(options.runtimeChild,
      { model: captured.requestedModel, projectId: captured.projectId }) : null;
    const sessionId = globalThis.crypto.randomUUID();
    let closed = false, resolvedModel = '', manager;
    const check = () => { if (closed || captured.signal?.aborted || !isCurrent()) throw fail('OPERATION_ABORTED', 'The project request was stopped.'); };
    const emitStatus = event => { try { Promise.resolve(onStatus(event)).catch(() => {}); } catch {} };
    check();
    const skills = await workflow('runtime_skills_context', { text: captured.originalRequest }); check();
    const catalog = Array.isArray(skills?.catalog) ? clone(skills.catalog) : [];
    const enabledSkills = new Set(catalog.filter(skill => skill.enabled === true && skill.available === true && !skill.invalid).map(skill => skill.name));
    const mcp = !runtimeChild && captured.surface === 'agent_command' && captured.permission === 'full_access'
      ? await workflow('runtime_mcp_definitions', {}) : { tools: [] };
    check();
    const extensions = runtime.normalize({ version: 1, skills: { catalog: JSON.stringify(catalog), active: skills?.active || [] },
      mcpTools: mcp?.tools || [], genericSubagents: !runtimeChild, ...(runtimeChild ? { child: runtimeChild } : {}) });
    const mcpNames = new Set(extensions.mcpTools.map(tool => tool.function.name));
    const receipts = new Map(), childContexts = new Map(), activeMcp = new Map(), undelivered = [];
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
        childContexts.set(child.taskId, service.forkAgentTurn(captured.turnId, child.taskId, child.originalRequest, captured.signal));
      },
      runChild: async (child, { signal }) => {
        check();
        const context = childContexts.get(child.taskId);
        const turn = service.agentTurns?.get(child.taskId);
        if (!context || !turn) throw fail('OPERATION_ABORTED');
        // Host evidence preparation must use the same resolved model as the
        // child's FC request, including an originally selected default model.
        turn.options = Object.freeze({ ...turn.options, signal,
          callContext: Object.freeze({ ...turn.options.callContext, model: child.model }) });
        try { const result = await requestChild(child, { context, signal }); check(); return result; }
        finally { childContexts.delete(child.taskId); service.agentTurns?.delete(child.taskId); }
      },
      onStatus: status => {
        if (['completed', 'failed', 'cancelled'].includes(status.status)) {
          childContexts.delete(status.task_id); service.agentTurns?.delete(status.task_id);
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
      const promise = (async () => {
        const runtimeCall = { name: call.name, args: clone(call.args) };
        try {
          let value;
          if (call.name === 'read_skill') {
            if (runtimeChild && !runtimeChild.allowedTools.includes('read_skill')) throw fail('SUBAGENT_TOOL_DENIED');
            if (Object.keys(call.args).some(key => key !== 'name') || !enabledSkills.has(call.args.name)) throw fail('SKILL_UNAVAILABLE');
            const { content, ...skill } = await workflow('runtime_skills_read', { name: call.args.name, forAgent: true });
            // Metadata and instruction body are sufficient for the model. The
            // full Markdown repeats the body and can exceed receipt transport.
            value = { ...skill, body: skill.body ?? content };
          } else if (call.name === 'spawn') {
            if (runtimeChild) throw fail('SUBAGENT_RECURSION_DENIED');
            value = await manager.spawn(call.args, parent(), { signal: captured.signal, callId: call.id });
            if (call.args.wait === true) value = JSON.parse(serializeCompletion(value));
          } else if (mcpNames.has(call.name) && captured.surface === 'agent_command' && captured.permission === 'full_access') {
            const callId = `${sessionId}:${call.id}`;
            const cancel = () => {
              try { return Promise.resolve(workflow('runtime_mcp_cancel', { callId })).catch(() => {}); }
              catch { return Promise.resolve(); }
            };
            check();
            activeMcp.set(callId, cancel);
            captured.signal?.addEventListener('abort', cancel, { once: true });
            try {
              check();
              value = await workflow('runtime_mcp_call', { call: { ...clone(call), id: callId }, surface: captured.surface, permission: captured.permission });
            } finally {
              captured.signal?.removeEventListener('abort', cancel); activeMcp.delete(callId);
            }
          } else throw fail('RUNTIME_TOOL_NOT_ALLOWED');
          check();
          return boundedReceipt({ id: call.id, result: { ok: true, runtimeCall, value } });
        } catch (error) {
          check();
          if (['OPERATION_ABORTED', 'RUNTIME_CALL_TOO_LARGE'].includes(error?.code)) throw error;
          return boundedReceipt({ id: call.id, result: { ok: false, runtimeCall,
            error: { code: /^[A-Z_]{1,100}$/.test(error?.code || '') ? error.code : 'RUNTIME_TOOL_FAILED',
              message: String(error?.message || 'The runtime tool failed.').slice(0, 1000) } } });
        }
      })();
      receipts.set(call.id, { fingerprint, promise });
      return clone(await promise);
    }
    function drain() {
      undelivered.push(...manager.drain(parentIdentity));
      while (undelivered.length) {
        const completion = undelivered[0];
        queue.enqueue(serializeCompletion(completion), { id: `completion:${completion.task_id}`, kind: 'subagent', taskId: completion.task_id });
        undelivered.shift();
      }
    }
    async function atCheckpoint(data = {}) {
      check();
      queue.acknowledge(Array.isArray(data.runtimeAccepted) ? data.runtimeAccepted : []);
      const final = data.agentCheckpoint?.final === true;
      drain();
      if (final) { await manager.waitForIdle(parentIdentity); check(); drain(); }
      const injections = queue.batch();
      const shouldContinue = !final || injections.length > 0;
      if (!shouldContinue && !queue.finish()) throw fail('INJECTION_QUEUE_RACE');
      return { injections, shouldContinue };
    }
    async function close() {
      if (closed) return;
      closed = true;
      try {
        await Promise.allSettled([...activeMcp.values()].map(cancel => cancel()));
        await manager.close();
        for (const id of childContexts.keys()) service.agentTurns?.delete(id);
        childContexts.clear(); receipts.clear(); undelivered.length = 0;
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
    return { extensions, execute, atCheckpoint, close, bindModel, acknowledge: ids => queue.acknowledge(ids), manager, parent: parentIdentity };
  }
  return { create, serializeCompletion };
});
