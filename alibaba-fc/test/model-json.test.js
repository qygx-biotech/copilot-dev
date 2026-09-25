"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseModelJsonValue: parse } = require("../model-json.js");

test("the supplied Paper Card preserves all LaTeX and citation quotes through storage", () => {
  const raw = fs.readFileSync(path.join(__dirname, "fixtures/paper-card-unescaped-latex.txt"), "utf8");
  assert.throws(() => JSON.parse(raw), SyntaxError);
  const expected = JSON.parse(raw.replaceAll(String.raw`\mu`, String.raw`\\mu`));
  const card = parse(raw);
  assert.deepEqual(card, expected);
  assert.deepEqual(JSON.parse(JSON.stringify(card)), expected);
  assert.ok(card.major_findings.some(finding => finding.claim.includes(String.raw`\mu`)));
});

test("raw inline/display LaTeX and ambiguous JSON control escapes retain their meaning", () => {
  for (const math of [
    String.raw`$\mu M, \frac{a}{b}, \theta, \beta, \nu, \rho, \text{中文}$`,
    String.raw`$$\left(\psi+\alpha\right)\leq\infty$$`,
    String.raw`\(\frac{1}{2}\) and \[\theta\]`,
    String.raw`\begin{equation}\frac{a}{b}\end{equation}`,
    String.raw`$\underline{x}\,\%\_\{x\}\custommacro{x}$`,
    String.raw`50 \mu M`,
  ]) {
    assert.equal(parse('{"text":"' + math + '"}').text, math);
  }
});

test("properly encoded math, row separators, multiline text and ordinary JSON escapes stay unchanged", () => {
  const values = [
    String.raw`\begin{aligned}a &= \frac{b}{c} \\ d &= \theta\end{aligned}`,
    '$\\psi = 1$\n$$\\frac{a}{b}$$',
    '中文 数学 ∑ ψ ≤ 5; tabs\tnewlines\nreturn\rbackspace\bformfeed\f "quote"',
    String.raw`C:\papers\file.pdf`, String.raw`\\server\share\file.pdf`,
    String.raw`$\$5$`,
  ];
  for (const value of values) {
    const object = { value, nested: [{ other: value }] };
    assert.deepEqual(parse(JSON.stringify(object)), object);
  }
  assert.equal(parse(String.raw`{"text":"\u03c8 \n \t \b \f \r \/ \""}`).text, 'ψ \n \t \b \f \r / "');
});

test("malformed structure, raw control characters, malformed Unicode and unknown escapes still fail", () => {
  for (const raw of [
    String.raw`{"text":"$\mu$"`, String.raw`{"text":"$\mu$",}`,
    String.raw`{"text":"$\mu$" "other":1}`, String.raw`{"text":"\q"}`,
    String.raw`{"text":"\u123Z"}`, String.raw`{"text":"$\u123Z$"}`,
    String.raw`{"\mu":"value"}`, '{"text":"raw\nnewline"}',
  ]) assert.throws(() => parse(raw), SyntaxError, raw);
});

test('parser locations contain only actual numeric suffix metadata, not input-supplied location text', () => {
  for (const text of ['PRIVATE position 12345 line 4 column 5', '{"summary":"PRIVATE",}']) {
    let error; try { parse(text); } catch (caught) { error = caught; }
    assert.ok(error);
    assert.doesNotMatch(JSON.stringify(error.jsonLocation || {}), /PRIVATE|summary/);
    if (error.jsonLocation) assert.ok(error.jsonLocation.position <= text.length);
    else assert.equal(error.jsonLocation, undefined);
  }
  // Conservative LaTeX repair shifts offsets; do not guess coordinates in the original.
  let error; try { parse(String.raw`{"summary":"$\mu$",}`); } catch (caught) { error = caught; }
  assert.equal(error.jsonLocation, undefined);
});
