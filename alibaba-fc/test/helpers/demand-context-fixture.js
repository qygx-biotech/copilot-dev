'use strict';
const { createFixture } = require('./preflight-fixture.js');
const { ProjectContextService } = require('../../../docs/project-context-service.js');
async function demandFixture() {
  const f = await createFixture();
  for (let i = 0; i < 4; i++) f.workspace.set(`literature/paper-${i}.pdf`, `Paper ${i}: synthetic biology AI enzyme design. Measured activity ${25 + i} U/mL.`);
  await f.system.registry.reconcile(await f.workspace.scanDirectoryTree());
  const ids = f.system.registry.list({ sourceKind: 'paper' }).map(source => source.sourceId);
  // Seed three real canonical cards through the actual preparation service.
  // Only extraction/model/index adapters in createFixture are test doubles.
  await f.system.preparation.ensureSourceReady(ids.slice(0, 3), 'paper_card', { surface: 'agent_command', deferTopicUpdate: true });
  await f.literature.scan({ deferKnowledgeMaintenance: true });
  for (const key of Object.keys(f.calls)) f.calls[key] = 0;
  f.workspace.rawReads = 0; f.events.length = 0;
  const progress = [];
  const service = new ProjectContextService({ workspace: f.workspace, literature: f.literature, sourceSystem: f.system, requestPipeline: f.pipeline,
    semanticInterpreter: { interpret() { throw new Error('No mandatory classification call'); } } });
  const options = { surface: 'agent_command', generalPurpose: true, turnId: 'demand-turn', callContext: { model: 'fixture/selected' }, onProgress: event => progress.push(event) };
  return { ...f, ids, service, options, progress };
}
module.exports = { demandFixture };
