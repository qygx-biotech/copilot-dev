"use strict";
// FC composition adapter only. Corpus-result policy lives with the shared
// run_corpus_workflow result service, never in generic context recovery.
const { CorpusResultService } = require('../corpus-result-service.js');
const { overflow, estimateRequest } = require('./context-recovery.js');
const service = new CorpusResultService({
  hash: value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  fallback: require('./corpus-card-fallback.js'), overflow, estimateRequest,
  inputQuota: require('./input-quota.js').inputQuota,
  normalizeTokens: require('../turn-observability.js').normalizeTokens,
});
module.exports = { ...service.runtime,
  openSession: (manager, options) => service.openProjectionSession(manager, options),
  Reduction: service.runtime.ResultProjectionSession };
