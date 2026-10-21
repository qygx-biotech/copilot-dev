'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const modes = require('../../shared/collaboration-modes.js');
const { authorizeTool, ToolEffect } = require('../../shared/agent/side-chat-agent.js');

test('a proposed plan is found with the text around it; anything else is not a plan', () => {
  assert.deepEqual(modes.extractProposedPlan('Grounded in two papers.\n\n<proposed_plan>\n## Steps\n1. Assay.\n</proposed_plan>\nReady when you are.'),
    { before: 'Grounded in two papers.', plan: '## Steps\n1. Assay.', after: 'Ready when you are.' });
  for (const text of ['No plan here.', '<proposed_plan>   </proposed_plan>', '<proposed_plan>unterminated', null]) assert.equal(modes.extractProposedPlan(text), null, String(text));
  assert.deepEqual([modes.normalizeMode('plan'), modes.normalizeMode('PLAN'), modes.normalizeMode(undefined)], ['plan', 'default', 'default']);
  assert.ok(modes.freshStartMessage('1. Assay.').startsWith(modes.PLAN_FRESH_START_PREFIX) && modes.freshStartMessage('1. Assay.').endsWith('\n\n1. Assay.'));
  assert.match(modes.PLAN_PROMPT, /<proposed_plan>[\s\S]*<\/proposed_plan>/);
});

test('in plan mode Agent Work may read and prepare evidence but not write sources, the recommendation or memory', () => {
  for (const tool of ['retrieve_project_evidence', 'read_workspace_item', 'run_corpus_workflow', 'list_papers'])
    assert.equal(authorizeTool('agent_command', tool, 'full_access', 'plan').allowed, true, tool);
  for (const [tool, effect] of [['update_recommendation', ToolEffect.RESULT_PRODUCING], ['download_sources', ToolEffect.SOURCE_WRITE], ['update_project_memory', ToolEffect.INTERNAL_STATE]]) {
    const result = authorizeTool('agent_command', tool, 'full_access', 'plan');
    assert.deepEqual([result.allowed, result.code, result.effect], [false, 'PLAN_MODE_READ_ONLY', effect], tool);
    if (tool !== 'download_sources') assert.equal(authorizeTool('agent_command', tool, 'full_access').allowed, true, `${tool} outside plan mode`);
  }
  assert.equal(authorizeTool('side_chat', 'update_project_memory', 'read_only', 'plan').allowed, true, 'Plan mode applies to Agent Work only');
});
