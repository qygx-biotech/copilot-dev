"use strict";

// A model view only: retain the complete tool receipt in the persisted turn.
// Corpus findings already contain cards/passages; the bundle supplies their
// provenance and scope, not a second copy of the same scientific text.
function compactCorpusReceipt(content, textBudget = Infinity) {
  let value;
  try { value = JSON.parse(content); } catch { return null; }
  if (value?.collectionMode !== "local-evidence" || !Array.isArray(value.findings?.papers)) return null;
  const papers = value.findings.papers;
  if (!papers.every(paper => paper && typeof paper.sourceId === "string" &&
      (paper.originalEvidence === undefined || Array.isArray(paper.originalEvidence) && paper.originalEvidence.every(item => item && typeof item === "object")))) return null;
  const perPaper = Math.floor(textBudget / Math.max(1, papers.length));
  for (const paper of papers) {
    const passages = paper.originalEvidence || [];
    const excerptLimit = Math.floor(perPaper * 0.8 / Math.max(1, passages.length));
    for (const passage of passages) {
      if (typeof passage.text === "string" && passage.text.length > excerptLimit) {
        passage.text = passage.text.slice(0, excerptLimit); passage.truncated = true;
      }
    }
    if (paper.orientation?.content?.length > perPaper * 0.2) {
      paper.orientation.content = paper.orientation.content.slice(0, Math.floor(perPaper * 0.2));
      paper.orientation.truncated = true;
    }
  }
  if (Array.isArray(value.evidenceBundle?.items)) {
    value.evidenceBundle.items = value.evidenceBundle.items.filter(item => item && (!value.workflowId || item.artifactId !== value.workflowId)).map(item => {
      const paper = papers.find(paper => item.sourceIds?.length === 1 && item.sourceIds[0] === paper.sourceId);
      const location = paper && (item.evidenceKind === "paper_card" ? "orientation" : item.evidenceKind === "original_passage" ? "originalEvidence" : null);
      if (location && paper[location]) {
        const { content: duplicate, ...metadata } = item;
        if (item.evidenceKind === "original_passage" && item.references?.length && item.references.every(ref =>
          ref.sourceId === paper.sourceId && ref.contentHash === paper.contentHash &&
          paper.originalEvidence.some(passage => passage.reference === ref.reference && passage.page === ref.page))) {
          delete metadata.references;
          metadata.referencesLocation = `findings.papers[sourceId=${paper.sourceId}].originalEvidence (version: contentHash)`;
        }
        return { ...metadata, contentLocation: `findings.papers[sourceId=${paper.sourceId}].${location}` };
      }
      if (Number.isFinite(textBudget) && typeof item.content === "string" && item.content.length > 300) {
        return { ...item, content: item.content.slice(0, 300), truncated: true };
      }
      return item;
    });
    // These same derived artifacts are in the normalized bundle with their
    // currentness/provenance. The host's full receipt remains unchanged.
    delete value.knowledge;
  }
  if (Number.isFinite(textBudget)) value.contextCompaction = {
    excerptsTruncated: true, limitation: "Excerpts were shortened to fit the provider budget. Source coverage is unchanged; this does not establish that every passage was read. Retrieve specific omitted details only if needed."
  };
  return JSON.stringify(value);
}

module.exports = { compactCorpusReceipt };
