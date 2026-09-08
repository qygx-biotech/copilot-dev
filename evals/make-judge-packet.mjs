#!/usr/bin/env node
// Export only frozen evidence and visible answer. Execution traces stay outside.
import fs from 'node:fs/promises';
import path from 'node:path';
import {verifyFrozenSuite, sha256} from './lib/reproducibility.mjs';
const options = {};
for(let i=2;i<process.argv.length;i+=2) options[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!options.observation||!options.output) throw new Error('Usage: --observation saved-ui-observation.json --output new-packet.json [--sample ID]');
const suite=path.resolve('evals/biodesign-eval-v1');
await verifyFrozenSuite(suite);
const observation=JSON.parse(await fs.readFile(options.observation,'utf8'));
if(observation.status!=='completed'||!observation.actual?.answer?.text) throw new Error('A completed actual answer is required.');
const cases=(await fs.readFile(path.join(suite,'cases.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const c=cases.find(c=>c.id===observation.caseId);
if(!c) throw new Error('Case is outside frozen suite.');
const project=JSON.parse(await fs.readFile(path.join(suite,'fixtures/project.json')));
const experiments=JSON.parse(await fs.readFile(path.join(suite,'fixtures/experiments.json')));
const memories=JSON.parse(await fs.readFile(path.join(suite,'fixtures/memories.json')));
const allowed=new Set(c.gold.allowedEvidenceIds);
const sources=project.sources.flatMap(s=>(s.pages||[]).filter(p=>allowed.has(p.evidenceId)).map(p=>({sourceId:s.id,evidenceId:p.evidenceId,title:s.title,page:p.page,text:p.text})));
for(const table of experiments.sources) for(const row of table.rows) if(allowed.has(row.evidenceId)) sources.push({sourceId:table.sourceId,evidenceId:row.evidenceId,text:JSON.stringify({sheet:table.sheet,row:row.rowNumber,sourceRowId:row.id,raw:row.raw})});
for(const m of memories.records||memories.memories||[]) if(allowed.has(m.evidenceId)) sources.push({sourceId:m.id||m.memoryId,evidenceId:m.evidenceId,text:m.text});
const packet={packetId:sha256(`${c.id}:${observation.repeat}:${options.sample||'1'}`).slice(0,16),caseId:c.id,repeat:observation.repeat,artifactType:'final_answer',question:c.query,gold:c.gold,sources,candidateAnswer:observation.actual.answer.text,candidateCitations:observation.actual.answer.citations||[]};
await fs.mkdir(path.dirname(path.resolve(options.output)),{recursive:true});
await fs.writeFile(options.output,JSON.stringify({packets:[packet]},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({packetId:packet.packetId,caseId:c.id,evidenceItems:sources.length,output:options.output}));
