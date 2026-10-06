'use strict';
const continuation = require('./agent-continuation.js');
const binding = (account, scope) => ({ purpose: 'completed-stream-call-v1', account, turnId: scope.turnId, projectId: scope.projectId, model: scope.model });
function seal(call, identity, scope, account, secret) {
  if (call.name !== 'host_project_status' || Object.keys(call.args).length || !identity.step.toolNames.includes(call.name)) throw new Error('Invalid early tool');
  return { ticket: continuation.seal({ call, identity, scope }, binding(account, scope), secret), scope };
}
function verify(ticket, scope, account, secret) {
  const result = continuation.open(ticket, binding(account, scope), secret);
  if (result.call.name !== 'host_project_status' || Object.keys(result.call.args).length) throw new Error('Invalid early tool');
  return result;
}
module.exports = { seal, verify };
