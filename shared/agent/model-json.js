"use strict";

// Only model-produced JSON content uses this decoder. HTTP envelopes, tool
// arguments, credentials, configuration and saved JSON files remain strict JSON.
// Repair string encoding, never JSON structure or the downstream schema.
const commands = new Set((
  "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi omicron pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega " +
  "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega " +
  "frac dfrac tfrac cfrac sqrt root left right middle big Big bigg Bigg " +
  "text textrm textsf texttt textbf textit textnormal mathrm mathsf mathtt mathbf mathit mathcal mathbb mathscr mathnormal operatorname " +
  "begin end boxed binom dbinom tbinom bar overline underline underbrace overbrace vec hat widehat tilde widetilde dot ddot " +
  "sum prod int iint iiint oint lim log ln exp sin cos tan cot sec csc sinh cosh tanh min max sup inf det dim gcd " +
  "times cdot div pm mp le leq ge geq neq ne approx sim simeq equiv propto in notin subset subseteq supset supseteq cup cap " +
  "infty partial nabla degree circ angle perp parallel forall exists neg land lor ldots cdots vdots ddots " +
  "to mapsto rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow uparrow downarrow " +
  "quad qquad thinspace hspace vspace nonumber notag label ref tag ce pu si SI unit"
).split(/\s+/));
const mathEnvironment = /^\{(?:equation|align|aligned|gather|gathered|multline|split|cases|[pbBvV]?matrix)\*?\}/;

function repairLatexString(token) {
  let result = '"', math = false;
  for (let i = 1; i < token.length - 1; i++) {
    const ch = token[i];
    if (ch === "$") {
      // $$ is one delimiter, rather than two changes of state.
      if (token[i + 1] === "$") { result += "$"; i++; }
      math = !math;
    }
    if (ch !== "\\") { result += ch; continue; }
    const next = token[i + 1];
    // Preserve already encoded backslashes, quotes and slashes exactly.
    if (next === "\\" || next === '"' || next === "/") {
      result += ch + next; i++; continue;
    }
    const word = /^[A-Za-z]+/.exec(token.slice(i + 1))?.[0] || "";
    const environment = word === "begin" && mathEnvironment.test(token.slice(i + 1 + word.length));
    const delimiter = "()[]".includes(next);
    const jsonEscape = "bfnrtu".includes(next);
    // Valid JSON \uXXXX always wins. Ambiguous control escapes (\theta,
    // \frac, etc.) are repaired only inside explicit mathematical notation.
    const unicode = next === "u" && /^[0-9a-fA-F]{4}/.test(token.slice(i + 2));
    const repair = !unicode && (
      environment || delimiter ||
      (commands.has(word) && (!jsonEscape || math)) ||
      (math && !jsonEscape && (word || "{}_%#&!,:;| ".includes(next)))
    );
    if (repair) result += "\\";
    result += ch + next; i++;
    if (environment || next === "(" || next === "[") math = true;
    if (next === ")" || next === "]") math = false;
  }
  return result + '"';
}

function parseModelJsonValue(text) {
  if (typeof text !== "string") throw new TypeError("Model JSON must be text");
  const repaired = text.replace(/"(?:[^"\\]|\\[\s\S])*"/g, (token, offset) => {
    // Keys are schema/identity fields, not scientific prose.
    if (/^\s*:/.test(text.slice(offset + token.length))) return token;
    return repairLatexString(token);
  });
  try { return JSON.parse(repaired); }
  catch (error) {
    // Coordinates are safe numeric parser metadata, never arbitrary exception
    // text. If LaTeX normalization moved characters, omit input coordinates.
    if (repaired === text) {
      const location = /\bat position (\d+)(?: \(line (\d+) column (\d+)\))?$/.exec(error.message || '');
      if (location && Number(location[1]) <= text.length) error.jsonLocation = { position: Number(location[1]),
        ...(location[2] ? { line: Number(location[2]), column: Number(location[3]) } : {}) };
    }
    throw error;
  }
}

module.exports = { parseModelJsonValue };
