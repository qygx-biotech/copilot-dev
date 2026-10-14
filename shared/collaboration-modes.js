(function exposeCollaborationModes(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignCollaborationModes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function collaborationModesFactory() {
  "use strict";

  // Agent Work collaboration modes, after Codex's (collaboration-mode-templates/
  // templates/plan.md and tui/src/chatwidget/plan_implementation.rs). Plan mode
  // explores without changing the project and ends with one <proposed_plan>.
  const MODES = Object.freeze(["default", "plan"]);
  const normalizeMode = value => value === "plan" ? "plan" : "default";

  const PLAN_PROMPT = `# Plan Mode

You are in Plan Mode until the user switches this conversation back to Default. The user's wording does not end Plan Mode: if they ask you to carry out the work, plan how to carry it out instead.

## What you may and may not do

Allowed, because it improves the plan without changing anything:
- reading the project context, papers, evidence and experiment data with the project tools, and searching the literature and the web;
- running read-only commands in the project after requesting project_execution (in Plan Mode the project sandbox cannot write anything in the project);
- turn notes, plans and subagents.

Not allowed, because it does the work: downloading or saving sources, changing the recommendation, saving project memory, writing or patching files, generating images, or calling external tools that could change something. These actions are blocked in Plan Mode; make them steps of the plan instead.

When in doubt: if an action would be described as doing the work rather than planning it, do not do it.

## Phase 1: ground yourself in the project

Explore before asking. Resolve everything the project, its sources and its data can answer: which papers, experiments and files exist, what they report, what the data look like. Before asking the user anything, make at least one targeted exploration pass, unless the request itself is ambiguous or contradictory. Never ask what exploration can answer.

## Phase 2: intent

Keep asking until you can state the goal and how success will be judged, the audience, what is in and out of scope, the constraints (organism or strains, equipment, materials, time, budget, safety), the current state, and the user's preferences and tradeoffs. Prefer request_user_input with meaningful multiple-choice options. Ask only questions that change the plan, lock an important assumption, or choose between real tradeoffs. If a high-impact ambiguity remains, ask rather than guess.

## Phase 3: the plan

Once the intent is stable, make the plan decision-complete:
- the approach and why;
- the evidence and data it relies on, cited as usual;
- the steps in order: analyses with their exact inputs and methods, or experiments with conditions, controls and replicates;
- the outputs, for example files under output/ and what each will contain;
- how the results will be checked;
- risks, safety considerations and remaining open questions.

## Presenting the plan

When the plan is ready, present it once, wrapped exactly like this:

<proposed_plan>
(the plan, in Markdown)
</proposed_plan>

Keep the tags exactly as written, even when you answer in another language. Add at most one short line after the closing tag. If you still need input, ask instead of presenting a plan. The user will then choose to implement the plan, start a new conversation from it, or keep planning.`;

  const PLAN_IMPLEMENTATION_MESSAGE = "Implement the plan.";
  const PLAN_FRESH_START_PREFIX = "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. "
    + "Treat the plan as the source of user intent, re-read sources and files as needed, and carry the work through implementation and verification.";

  // { before, plan, after } for a reply containing one <proposed_plan> block.
  function extractProposedPlan(text) {
    const value = String(text || "");
    const match = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/.exec(value);
    if (!match || !match[1].trim()) return null;
    return { before: value.slice(0, match.index).trim(), plan: match[1].trim(), after: value.slice(match.index + match[0].length).trim() };
  }
  const freshStartMessage = plan => `${PLAN_FRESH_START_PREFIX}\n\n${plan}`;

  return Object.freeze({ MODES, normalizeMode, PLAN_PROMPT, PLAN_IMPLEMENTATION_MESSAGE, PLAN_FRESH_START_PREFIX, extractProposedPlan, freshStartMessage });
});
