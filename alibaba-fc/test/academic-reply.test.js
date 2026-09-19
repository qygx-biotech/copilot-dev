"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const semantic = require("../../shared/semantic-intent.js"), citations = require("../../shared/source-citations.js");
const { runSideChatAgent, resolveSideChatAnswerCitations, createSideChatKnowledgeBase } = require("../side-chat-agent.js");
const continuation = require("../agent-continuation.js");
const query = "Find AI and synthetic biology papers and download five relevant papers.";
const refs = Array.from({ length: 5 }, (_, i) => "paper_" + String(i + 1).padStart(24, "0"));
const papers = refs.map((paper_ref, i) => ({ paper_ref, title: `AI and synthetic biology study ${i + 1}`, authors: ["Author"],
  doi: `10.1000/study-${i + 1}`, abstract: "Design and validation evidence.", providers: [], locations: [{ kind: "landing_page", url: `https://papers.example.org/study-${i + 1}` }] }));
const ir = { ...semantic.interpretLocal({ query }), matchedPattern: null, retrievalScope: "web", objects: ["literature"], operations: ["search", "store"],
  capabilityHints: ["search_papers", "download_sources"], requestedOutput: { type: "papers", limit: 5 }, answerLanguage: "zh" };
const run = options => runSideChatAgent({ surface: "agent_command", desktopAcademic: true, desktopDownloads: true, downloadPermission: "workspace_write",
  originalRequest: query, systemPrompt: "Complete the literature request.", conversationMessages: [{ role: "user", content: query }],
  workspaceContext: { localWorkspaceContext: { semantic: { ir } } }, parseFinalAnswer: JSON.parse, ...options });
const call = (name, args) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
const actions = (...tool_calls) => ({ ok: true, message: { tool_calls } });
function resumeWith(pending, result) {
  const binding = { project: "reply-fixture", account: "test" };
  const state = continuation.open(continuation.seal(pending.continuationState, binding, "secret"), binding, "secret");
  return continuation.withResults(state, [{ id: pending.data.desktopToolCalls[0].id, result }]);
}
async function attempted(count) {
  const found = await run({ requestTurn: async () => actions(call("plan_literature_search", {
    request_kind: "topic", subtopics: ["design"], synonyms: [], queries: ["AI synthetic biology", "AI design validation"], requested_count: 5,
  }), call("search_academic_papers", { query: "AI synthetic biology", queries: ["AI design validation"] })) });
  const selected = await run({ resume: resumeWith(found, { version: 1, status: "completed", papers }), requestTurn: async () => actions(
    call("select_literature_papers", { shortlist: refs.map(paper_ref => ({ paper_ref, covers: ["subtopic_1"], relevance: 5, evidence: "title_abstract", reason: "Host-stored selection reason." })),
      stop_reason: "sufficient_candidates", remaining_gaps: ["Host-stored coverage gap."] }), call("download_papers", { paper_refs: refs })) });
  const resume = resumeWith(selected, { version: 1, status: count === 5 ? "completed" : "partial", results: refs.map((paper_ref, i) => i < count
    ? { paper_ref, status: "downloaded", path: `literature/study-${i + 1}.pdf`, contentType: "application/pdf" }
    : { paper_ref, status: "failed", error: { code: "NO_ACCESSIBLE_PDF" } }) });
  resume.academicState.downloadRecoveryUsed = true; // Final handoff after the existing bounded recovery.
  return resume;
}

for (const count of [5, 3, 0]) test(`final academic reply remains model-authored with ${count}/5 files saved`, async () => {
  const reply = `已筛选出5篇相关文献，成功下载${count}篇。\n\n**下载结果**\n- 已下载：${count}篇。\n- 未下载：${5 - count}篇。\n\n请根据这些结果继续阅读。`;
  const final = await run({ resume: await attempted(count), requestTurn: async () => ({ ok: true, message: { content: JSON.stringify({ reply,
    project: { summary: "Model project summary." }, taskOutcome: { status: "completed", downloadSuccessCount: 999 }, downloadResults: [] }) } }) });
  assert.equal(final.data.reply, reply);
  assert.equal(final.data.taskOutcome.status, count === 5 ? "completed" : "incomplete");
  assert.equal(final.data.taskOutcome.downloadSuccessCount, count);
  assert.equal(final.data.downloadResults.length, 5);
  assert.equal(final.data.academicSelection.download_selections.length, 5);
  assert.deepEqual(final.data.academicSelection.remaining_gaps, ["Host-stored coverage gap."]);
  assert.equal(final.data.project.summary, "Model project summary.");
});

test("reported partial reply retains prose and citations through host finalization and display resolution", async () => {
  const prefix = "本次检索筛选出5篇相关文献，并成功下载了其中3篇。未能下载的文献返回 NO_ACCESSIBLE_PDF。\n\n已下载的文献包括：\n";
  const reply = prefix + refs.slice(0, 3).map((ref, i) => `${i + 1}. [[cite:${ref}]] (${papers[i].title})`).join("\n") +
    "\n\n未成功下载的文献为：\n" + refs.slice(3).map((ref, i) => `- [[cite:${ref}]] (${papers[i + 3].title})`).join("\n");
  const final = await run({ resume: await attempted(3), requestTurn: async () => ({ ok: true, message: { content: JSON.stringify({ reply }) } }) });
  const expected = refs.reduce((text, ref, i) => text.replace(`[[cite:${ref}]]`, `[${i + 1}](https://papers.example.org/study-${i + 1})`), reply);
  assert.equal(final.data.reply, expected);
  assert.equal(citations.resolveForDisplay(final.data.reply, final.data.citations).reply, expected);
  assert.doesNotMatch(final.data.reply, /Source unavailable|PDFs saved|Selection reasons|Host-stored/);
  assert.equal(final.data.taskOutcome.downloadSuccessCount, 3);
});

test("empty final replies retain a factual host fallback", async () => {
  const final = await run({ resume: await attempted(3), requestTurn: async () => ({ ok: true, message: { content: JSON.stringify({ reply: "" }) } }) });
  assert.match(final.data.reply, /3 \/ 5 PDFs saved/);
  assert.equal(final.data.taskOutcome.status, "incomplete");
});

test("online paper citation formatting preserves code and never trusts invented handles or unsafe URLs", () => {
  const known = refs[0], unknown = "paper_" + "f".repeat(24);
  const kb = createSideChatKnowledgeBase({ localWorkspaceContext: { semantic: { ir } } });
  const reply = `Text [[cite:${known}]].\n\n\`[[cite:${known}]]\`\n\n\`\`\`text\n[[cite:${known}]]\n\`\`\`\n\nUnknown [[cite:${unknown}]].`;
  const output = resolveSideChatAnswerCitations({ reply }, kb, "agent_command", { papers });
  assert.match(output.reply, /^Text \[1\]\(https:\/\/papers.example.org\/study-1\)/);
  assert.ok(output.reply.includes(`\`[[cite:${known}]]\``));
  assert.ok(output.reply.includes(`\`\`\`text\n[[cite:${known}]]\n\`\`\``));
  assert.match(output.reply, /Unknown \[Source unavailable\]/);
  const unsafe = { ...papers[0], doi: "", locations: [{ url: "javascript:alert(1)", kind: "landing_page" }] };
  const safe = resolveSideChatAnswerCitations({ reply: `[[cite:${known}]]` }, kb, "agent_command", { papers: [unsafe] });
  assert.equal(safe.reply, "[1]");
  const localOnly = resolveSideChatAnswerCitations({ reply: `[[cite:${known}]]` }, kb, "side_chat");
  assert.match(localOnly.reply, /Source unavailable/, "Unrelated chat does not acquire an online citation registry");
});
