"use strict";

// Turn-level exploration budget for the shared agent loop. The model decides
// when the task is finished; these bounds only stop runaway turns. When one is
// reached, the existing tool-free final synthesis answers from the collected
// receipts, so cheap small-window models still end with a usable answer.
//
// The budget is captured once per turn and carried in the turn's continuation
// state, so a policy change cannot alter the bounds of a turn already running.

const DEFAULTS = Object.freeze({ maxSteps: 64, maxToolCalls: 192, turnMs: 30 * 60 * 1000, turnTokens: null });
const BOUNDS = Object.freeze({ maxSteps: [2, 512], maxToolCalls: [1, 2048], turnMs: [60000, 6 * 60 * 60 * 1000], turnTokens: [1000, 1e9] });
const ENV = Object.freeze({ maxSteps: "AGENT_MAX_STEPS", maxToolCalls: "AGENT_MAX_TOOL_CALLS", turnMs: "AGENT_TURN_BUDGET_MS", turnTokens: "AGENT_TURN_TOKEN_BUDGET" });
// Time and token budgets may be disabled with 0; step/tool bounds may not.
const OPTIONAL = new Set(["turnMs", "turnTokens"]);

function value(raw, name, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const number = Number(raw);
  if (OPTIONAL.has(name) && number === 0) return null;
  const [min, max] = BOUNDS[name];
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

function normalize(input = {}) {
  return Object.freeze(Object.fromEntries(Object.keys(DEFAULTS).map(name => [name, value(input?.[name], name, DEFAULTS[name])])));
}

function configFromEnv(env = {}) {
  return normalize(Object.fromEntries(Object.entries(ENV).map(([name, key]) => [name, env[key]])));
}

// Wall-clock and token bounds span every FC request of the turn. Step and
// tool-call bounds are checked by the loop, which also reserves synthesis.
function turnExhausted(budget, usage, now = Date.now()) {
  if (budget.turnMs !== null && Number.isFinite(usage?.startedAt) && now - usage.startedAt >= budget.turnMs) return "turn_time_budget_exhausted";
  if (budget.turnTokens !== null && Number(usage?.totals?.totalTokens) >= budget.turnTokens) return "turn_token_budget_exhausted";
  return null;
}

module.exports = { DEFAULTS, BOUNDS, configFromEnv, normalize, turnExhausted };
