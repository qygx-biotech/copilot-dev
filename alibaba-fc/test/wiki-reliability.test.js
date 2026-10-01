"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const wiki = require("../../shared/literature-wiki.js");
const { generateWiki } = require("../wiki-generation.js");
const a = "alpha:p1:c1", b = "alpha:p2:c2", c = "beta:p1:c1";
const input = () => ({ pageId: "binding", label: "Binding", kind: "concept", configuration: wiki.configuration("fixture"), existingPage: null, relatedPages: [], analysisRequest: "",
  papers: [{ paperId: "alpha", contentHash: "alpha-hash", card: {}, evidence: wiki.selectEvidence([{ reference: a, text: "At 30 C the assay detected DNA-" }, { reference: b, text: "protein complexes in solution." }], [a, b]) },
    { paperId: "beta", contentHash: "beta-hash", card: {}, evidence: [{ reference: c, text: "Control cells retained enzyme stability at 30 C." }] }] });
const page = wiki.markdownPage;
const good = `The assay detected DNA-protein complexes at 30 C. [[cite:${a}]] [[cite:${b}]]`;
const reply = content => ({ ok: true, message: { content }, attempts: 1, usage: { prompt_tokens: 100, completion_tokens: 20 } });

test("valid citations remain byte-identical; only exact recognized citation groups are repaired", () => {
  for (const text of [`Observation [[cite:${c}]]`, good]) {
    assert.deepEqual(wiki.normalizeMarkdown(page(text), input()), { page: page(text), repairs: [] });
  }
  const source = `Observation [[cite:${a}], [cite:${b}]]`;
  const result = wiki.normalizeMarkdown(page(source), input());
  assert.equal(result.page.markdown, `Observation [[cite:${a}]] [[cite:${b}]]`);
  assert.deepEqual(result.repairs, [{ type: "citation_group", count: 1 }]);
  assert.deepEqual(wiki.validatePage(result.page, input()), []);
  for (const bad of [`[[cite:${a}], [cite:unknown:p2:c2]]`, `[[cite:${a}], perhaps [cite:${b}]]`, `[[cite:${a} ], [cite:${b}]]`, `[[[cite:${a}], [cite:${b}]]]`]) {
    const result = wiki.normalizeMarkdown(page(bad), input());
    assert.equal(result.page.markdown, bad);
    assert.ok(wiki.validatePage(result.page, input()).length, bad);
  }
});

test("code citations and HTML examples are neither modified nor treated as citations", () => {
  const sample = `[[cite:${a}], [cite:${b}]] <br>`;
  for (const code of [`\`${sample}\``, `\`\`${sample}\`\``, `\`first\n${sample}\``, `\`\`\`md\n${sample}\n\`\`\``, `~~~\n${sample}\n~~~`, `    ${sample}`, `\`\`\`\n${sample}`]) {
    const text = `Observation [[cite:${c}]]\n\n${code}`;
    const result = wiki.normalizeMarkdown(page(text), input());
    assert.equal(result.page.markdown, text);
    assert.deepEqual(wiki.references(result.page), [c]);
    assert.deepEqual(wiki.validatePage(result.page, input()), []);
  }
});

test("harmless br repair preserves table cells; other HTML and unsafe links remain invalid", () => {
  const text = `| Claim | Evidence |\n| --- | --- |\n| Binding<br>continued<BR/>again<br />end | [[cite:${c}]] |`;
  const result = wiki.normalizeMarkdown(page(text), input());
  assert.equal(result.page.markdown.split("\n").length, 3);
  assert.equal(result.page.markdown.split("|").length, text.split("|").length);
  assert.match(result.page.markdown, /Binding continued again end/);
  assert.deepEqual(wiki.validatePage(result.page, input()), []);
  for (const bad of [`<br onclick="evil"> [[cite:${c}]]`, `<img src=x> [[cite:${c}]]`, `[click](javascript:alert) [[cite:${c}]]`]) {
    assert.ok(wiki.validatePage(wiki.normalizeMarkdown(page(bad), input()).page, input()).length);
  }
});

test("cross-page continuation uses bounded original excerpts, original handles and both citations", () => {
  const source = input(), chunks = source.papers[0].evidence, before = JSON.stringify(chunks);
  const evidence = wiki.selectEvidence(chunks, [a]);
  assert.equal(JSON.stringify(chunks), before);
  assert.equal(evidence[0].text, chunks[0].text);
  assert.equal(evidence[1].text, chunks[1].text);
  assert.deepEqual(evidence[0].continuity, [{ reference: b, boundary: "page", kind: "possible_hyphenation" }]);
  source.papers[0].evidence = evidence;
  assert.deepEqual(wiki.validateInput(source), []);
  assert.ok(wiki.publicationProblems(page(`DNA was detected [[cite:${a}]]`), source).some(p => p.includes("INCOMPLETE_CONTINUATION_SUPPORT")));
  assert.deepEqual(wiki.publicationProblems(page(good), source), []);
  assert.deepEqual(wiki.references(page(good)), [a, b]);
  assert.deepEqual(wiki.citationIntegrity(page(good), source).references.map(r => r.page), [1, 2]);
  const large = [...chunks, { reference: "alpha:p3:c3", text: "x".repeat(10000) }];
  assert.ok(wiki.selectEvidence(large, [b], 800).reduce((n, e) => n + e.text.length, 0) <= chunks[1].text.length + 800);
  assert.equal(wiki.selectEvidence(chunks, [a], 0).length, 1);
});

test("headers, footers, columns and ambiguous hyphens are hints, never reconstructed source text", () => {
  for (const [left, right] of [["Detected DNA-\n12", "protein complexes"], ["Detected DNA-", "Journal of Biology\nprotein complexes"], ["Detected DNA-", "protein   other column"]]) {
    const chunks = [{ reference: a, text: left }, { reference: b, text: right }];
    const selected = wiki.selectEvidence(chunks, [a]);
    assert.equal(selected[0].continuity[0].kind, "layout_ambiguous");
    assert.equal(selected[0].text, left); assert.equal(selected[1].text, right);
  }
  const chunks = [{ reference: a, text: "This is a state-" }, { reference: b, text: "of-the-art assay." }];
  assert.equal(wiki.selectEvidence(chunks, [a])[0].continuity[0].kind, "possible_hyphenation");
  assert.equal(wiki.continuityLinks([{ reference: a, text: "Completed observation." }, chunks[1]]).get(a).length, 0);
});

test("resolving IDs proves neither claim support nor exact quotes/numeric attribution", () => {
  for (const claim of [`The assay yielded 99% survival [[cite:${c}]]`, `The authors wrote “the intervention cures cancer” [[cite:${c}]]`]) {
    const integrity = wiki.citationIntegrity(page(claim), input());
    assert.equal(integrity.syntaxStatus, "valid"); assert.equal(integrity.referenceStatus, "resolved");
    assert.equal(integrity.verifiedClaimCount, 0);
    assert.equal(integrity.supportAssessment.status, "not_verified");
    assert.ok(wiki.publicationProblems(page(claim), input()).length);
  }
  assert.equal(wiki.citationIntegrity(page(`A wholly unsupported theory [[cite:${c}]]`), input()).claimVerification, "not_semantically_verified");
});

test("deterministic repairs avoid an extra call, preserve raw bytes and log metadata only", async () => {
  const raw = `PRIVATE_BODY [[cite:${a}], [cite:${b}]]<br>`, events = [];
  let count = 0;
  const result = await generateWiki({ input: input(), model: "fixture", debug: true, logger: { info: (...args) => events.push(args) }, request: async () => { count++; return reply(raw); } });
  assert.equal(count, 1); assert.equal(result.acceptance, "references_validated");
  assert.equal(result.generationAudit.outputs[0].rawPage.markdown, raw);
  assert.equal(result.generationAudit.outputs[0].repairs.length, 2);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_BODY|alpha:p1/);
});

test("one targeted repair shares retry allowance, accumulates usage/latency and preserves both outputs", async () => {
  let count = 0, clock = 0; const requests = [];
  const result = await generateWiki({ input: input(), model: "fixture", now: () => clock, request: async (body, options) => {
    requests.push({ body, options }); clock += 12000; count++;
    return reply(count === 1 ? `Claim [[cite:unknown:p1:bad]]` : good);
  } });
  assert.equal(count, 2); assert.equal(result.attempts, 2); assert.equal(result.acceptance, "references_validated");
  assert.equal(result.usage.prompt_tokens, 200); assert.equal(result.generationAudit.durationMs, 24000);
  assert.equal(requests[0].options.deadlineAt, requests[1].options.deadlineAt);
  assert.equal(requests[1].options.maxAttempts, 1);
  assert.match(requests[1].body.messages[1].content, /not supplied/);
  assert.equal(result.generationAudit.outputs.length, 2);
  assert.match(result.generationAudit.outputs[0].rawPage.markdown, /unknown/);
});

test("unresolved repair, failed repair, disabled repair and exhausted allowance cannot loop", async () => {
  for (const mode of ["unresolved", "failure", "throws", "disabled", "exhausted"]) {
    let count = 0;
    const result = await generateWiki({ input: input(), model: "fixture", repairEnabled: mode !== "disabled", request: async () => {
      count++;
      if (count === 2 && mode === "failure") return { ok: false, attempts: 1, error: "provider_unavailable" };
      if (count === 2 && mode === "throws") throw new Error("provider unavailable");
      return { ...reply(`Useful draft [[cite:unknown:p1:bad]]`), attempts: mode === "exhausted" ? 2 : 1 };
    } });
    assert.equal(count, ["disabled", "exhausted"].includes(mode) ? 1 : 2);
    assert.equal(result.acceptance, "unverified_draft");
    assert.match(result.page.markdown, /Useful draft/);
    assert.ok(result.validationProblems.length);
    assert.match(result.generationAudit.outputs[0].rawPage.markdown, /Useful draft/);
  }
});

test("cancellation before repair prevents dispatch; empty output is retained with actionable failure", async () => {
  const controller = new AbortController(); let calls = 0;
  const result = await generateWiki({ input: input(), model: "fixture", signal: controller.signal, request: async () => {
    calls++; controller.abort(); return reply("");
  } }).catch(error => error);
  assert.equal(calls, 1);
  const empty = await generateWiki({ input: input(), model: "fixture", request: async () => reply("   ") });
  assert.equal(empty.acceptance, "unverified_draft");
  assert.equal(empty.generationAudit.outputs[0].rawPage.markdown, "   ");
  assert.match(empty.validationProblems[0], /empty/);
});

test("repair failure audits dispatched calls accurately and cannot reset the hard deadline", async () => {
  let calls = 0;
  const deadlineAt = Date.now() + 50;
  const result = await generateWiki({ input: input(), model: "fixture", deadlineAt, request: async (_body, options) => {
    calls++; options.onAttempt();
    assert.equal(options.deadlineAt, deadlineAt);
    if (calls === 1) return reply("Useful draft [[cite:unknown:p1:bad]]");
    return new Promise(() => {});
  } });
  assert.equal(calls, 2); assert.equal(result.attempts, 2);
  assert.equal(result.generationAudit.modelRepairCalls, 1);
  assert.equal(result.generationAudit.calls[1].outcome, "stopped");
  assert.equal(result.generationAudit.repairOutcome, "stopped");
  assert.equal(result.acceptance, "unverified_draft");
  assert.match(result.page.markdown, /Useful draft/);
});
