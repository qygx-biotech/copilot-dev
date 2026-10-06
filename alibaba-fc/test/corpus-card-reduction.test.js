'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { ContextRecovery } = require('../context-recovery.js');
const lifecycle = require('../provider-lifecycle.js');
const { BOUNDS, tokens, splitUnit } = require('../corpus-card-reduction.js');
const config = { api: 'responses', endpoint: 'https://offline.invalid/v1/responses', apiKey: 'offline', model: 'fixture', reasoning: { effort: 'high' } };
const success = { ok: true, attempts: 1, message: { content: 'Overview.' } };
const rejection = { ok: false, status: 400, attempts: 1, error: { code: 'context_length_exceeded', details: { max_input_tokens: 60000 } } };
const quota = { ok: false, status: 429, attempts: 1, error: { code: 'input_token_quota_exceeded', details: { input_token_limit: 60000 } } };
function input() {
  const cards = [1,2,3].map(n => ({ sourceId: `source${n}`, contentHash: `version${n}`, cardIdentity: `card${n}`, card: { cacheKey: `cache${n}`, findings: ('Finding '+n+' under defined conditions. ').repeat(400) + 'COMPLETE_TAIL_'+n, methods: 'Controlled experimental conditions.', debug: 'PRIVATE_DEBUG_METADATA' } }));
  const bindings = cards.map(c => ({ sourceId: c.sourceId, identity: 'source:'+c.sourceId, version: c.contentHash, current: true, cardStatus: 'ready', cardCacheKey: c.card.cacheKey }));
  const bundle = { version: 1, workflowId: 'workflow', cards, missingCards: [{ sourceId: 'missing', reason: 'CURRENT_COMPATIBLE_CARD_UNAVAILABLE' }], failures: [{ sourceId: 'missing', code: 'NOT_READY' }] };
  const messages = [{ role: 'system', content: 'AUTHORIZATION_AND_CANONICAL_INSTRUCTIONS' }, { role: 'user', content: 'TASK: Compare papers' },
    { role: 'assistant', content: 'Proceed', tool_calls: [{ id: 'corpus', type: 'function', function: { name: 'run_corpus_workflow', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'corpus', content: JSON.stringify({ findings: 'ORIGINAL_PASSAGE '.repeat(6000), knowledge: 'DUPLICATE_PREVIEW SUPPLEMENTARY_SYNTHESIS' }), corpus_card_fallback: bundle },
    { role: 'user', content: 'UNRELATED_USER_MESSAGE' }];
  return { messages, corpusTask: 'TASK: Compare papers', corpusSourceBindings: bindings, tools: [{ type: 'function', function: { name: 'retrieve_project_evidence', parameters: { type: 'object' } } }], maxTokens: 1024 };
}
const data = request => JSON.parse(request.messages[1].content);
function summary(request, repeat = 1) {
  const d = data(request);
  assert.deepEqual(request.response_format,{type:'json_object'});
  return { ...success, message: { content: JSON.stringify({ papers: d.units.map(u => ({ handle: u.handle, part: u.part, summary: 'Qualified finding. '.repeat(repeat), omissions: ['Fine experimental detail omitted.'] })),
    synthesis: [{ handles: [...new Set(d.units.map(u => u.handle))], text: 'Attributable qualified comparison.' }], omissions: ['Detailed numerical claims omitted.'], limitations: ['Derived summaries, not original evidence.'] }) } };
}
async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'corpus-reduce-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
  return new ContextRecovery({ model: 'fixture', providerProfile: lifecycle.profile(config), ...extra, config: { root, safety: 64, outputTokens: 1024, maxAttempts: 2, ...extra.config } });
}
function remote() { const map = new Map(); return { map, put: async (k,v) => { map.set(k,v); }, get: async k => map.get(k), claim: async (k,v) => { if (map.has(k)) return false; map.set(k,v); return true; } }; }
function generic(manager) { let count=0; const compact=manager.compact.bind(manager); manager.compact = async (...args) => { count++; return compact(...args); }; return () => count; }

test('actual native bodies: mixed -> complete cards -> isolated summary -> attributed compressed result', async t => {
  const events=[], manager=await fixture(t,{onEvent:e=>events.push(e)}), original=input(), canonical=structuredClone(original), bodies=[];
  manager.compact=()=>assert.fail('Generic recovery must not precede validated summary');
  const result=await manager.run(original, async request => {
    return lifecycle.responses(config, { ...request, max_tokens: request.maxTokens }, { fetchImpl: async (_url,init) => {
      const body=JSON.parse(init.body); bodies.push(body);
      if(bodies.length<=2) return new Response(JSON.stringify({error:rejection.error,usage:{input_tokens:20,output_tokens:0}}),{status:400});
      if(request.stage==='corpus-summary') {
        assert.deepEqual(body.text,{format:{type:'json_object'}});assert.equal(body.response_format,undefined);
        assert.equal(body.model,config.model); assert.deepEqual(body.reasoning,config.reasoning);
        assert.equal(body.tools,undefined); assert.equal(body.previous_response_id,undefined); assert.equal(body.input.length,2);
        assert(!/AUTHORIZATION_AND_CANONICAL|UNRELATED_USER|ORIGINAL_PASSAGE|DUPLICATE_PREVIEW|SUPPLEMENTARY_SYNTHESIS|PRIVATE_DEBUG/.test(JSON.stringify(body)));
        for(let n=1;n<=3;n++) assert(JSON.stringify(body).includes('COMPLETE_TAIL_'+n));
        assert.equal(data(request).units[0].identity.sourceId,'source1');
      }
      const value=request.stage==='corpus-summary'?summary(request).message.content:'Overview';
      return new Response(JSON.stringify({status:'completed',output:[{type:'reasoning',id:'private',encrypted_content:'PRIVATE_REASONING'}, {type:'message',role:'assistant',content:[{type:'output_text',text:value}]}],usage:{input_tokens:20,output_tokens:10}}));
    }});
  });
  assert(result.ok,JSON.stringify(result)); assert.equal(bodies.length,4); assert.equal(result.attempts,4); assert.equal(manager.recoverySteps,0); assert.equal(manager.summaryCalls,0);
  const view=JSON.parse(bodies[3].input.find(i=>i.type==='function_call_output').output);
  assert.equal(view.basis,'compressed-derived-paper-cards'); assert.equal(view.paperSummaries.length,3);
  assert.deepEqual(view.paperSummaries.map(p=>[p.sourceId,p.contentHash,p.cardIdentity]),original.messages[3].corpus_card_fallback.cards.map(p=>[p.sourceId,p.contentHash,p.cardIdentity]));
  assert.equal(view.coverage.exhaustiveContentCoverage,false); assert.equal(view.missingCards.length,1);
  assert(!JSON.stringify(view).includes('PRIVATE_REASONING')); assert.match(view.guidance,/targeted to specific unresolved claims/);
  assert.deepEqual(original,canonical); assert.deepEqual(bodies[1].input.filter(i=>i.type!=='function_call_output'),bodies[3].input.filter(i=>i.type!=='function_call_output'));
  assert.deepEqual(result.corpusRecovery.events,events);assert.equal(result.corpusRecovery.providerRequests,4);assert(events.some(e=>e.event==='corpus-provider-rejection'&&e.category==='input_size'&&e.purpose==='main-request'&&e.estimatedInputTokens>0));assert(events.some(e=>e.event==='corpus-summary-batch-start'&&e.purpose==='corpus-summary'));assert(events.some(e=>e.event==='corpus-summary-stage-completed')); assert(!JSON.stringify(events).includes('Qualified finding'));
});

test('successive rejections halve the smaller of prior target and actual summary size and leave generic allowance untouched', async t=>{
  const m=await fixture(t), targets=[], actuals=[], compact=generic(m); let main=0;
  const result=await m.run(input(),async r=>{
    if(r.stage==='corpus-summary'){targets.push(data(r).targetTokens);assert.equal(m.recoverySteps,0);const value=summary(r,[100,35,5][targets.length-1]);actuals.push(tokens(JSON.parse(value.message.content)));return value;}
    main++; return main<=4?rejection:success;
  });
  assert(result.ok,JSON.stringify({reason:result.recoveryStopReason,targets,main,state:m.state.corpusReductions}));assert.equal(targets.length,3);assert.equal(targets[1],Math.floor(Math.min(targets[0],actuals[0])/2));assert.equal(targets[2],Math.floor(Math.min(targets[1],actuals[1])/2));assert.equal(compact(),0);assert.equal(main,5);assert.equal(result.attempts,8);
});

test('three reduced rejections enter generic recovery with its full allowance',async t=>{
  const m=await fixture(t), compact=generic(m);let summaries=0,main=0;
  const options=input(); options.messages.push({role:'assistant',tool_calls:[{id:'other',type:'function',function:{name:'read_file',arguments:'{}'}}]}, {role:'tool',tool_call_id:'other',content:'Unrelated data. '.repeat(20000)});
  let corpusBefore;
  const result=await m.run(options,async r=>{
    if(r.stage==='corpus-summary')return summary(r,[120,45,10][summaries++]);
    main++;
    if(main===5)corpusBefore=r.messages[3].content;
    if(main===6){assert.equal(r.messages[3].content,corpusBefore);assert.match(r.messages.at(-1).content,/contextArchive/);assert(!r.messages[3].content.includes('contextArchive'));}
    return main<=5?rejection:success;
  });
  assert(result.ok,JSON.stringify({reason:result.recoveryStopReason,summaries,main}));assert.equal(summaries,3);assert.equal(compact(),1);assert.equal(m.recoverySteps,1);
});

for(const mode of ['malformed','missing','oversized','identity','unattributed','placeholder'])test(`invalid ${mode} summary has at most one repair and no silent omission`,async t=>{
  const m=await fixture(t), compact=generic(m);let main=0,summaries=0;
  const result=await m.run(input(),async r=>{
    if(r.stage!=='corpus-summary')return ++main<=2?rejection:success;
    summaries++;const out=summary(r),value=JSON.parse(out.message.content);
    if(mode==='malformed')out.message.content='not JSON';
    else {if(mode==='placeholder')value.papers[0].summary='[omitted]';if(mode==='missing')value.papers.pop();if(mode==='oversized')value.papers[0].summary='too large '.repeat(10000);if(mode==='identity')value.papers[0].handle='invented';if(mode==='unattributed')value.synthesis[0].handles=['invented'];out.message.content=JSON.stringify(value);}
    return out;
  });
  assert(!result.ok);assert.equal(result.recoveryStopReason,'corpus_summary_unavailable');assert.equal(summaries,2);assert.equal(compact(),0);assert.equal(m.recoverySteps,0);assert(!result.contextMessages[3].content.includes('contextArchive'));
});

test('revocation and changed versions after asynchronous summarization remove dependent synthesis',async t=>{
  const m=await fixture(t), options=input();let main=0;
  options.getCorpusSourceBindings=()=>options.corpusSourceBindings;
  const result=await m.run(options,async r=>{
    if(r.stage==='corpus-summary') {options.corpusSourceBindings.splice(0,1);options.corpusSourceBindings[0].version='changed';return summary(r);}
    if(++main<=2)return rejection;
    const view=JSON.parse(r.messages[3].content);assert.deepEqual(view.paperSummaries.map(p=>p.sourceId),['source3']);assert.equal(view.synthesis.length,0);assert.equal(view.coverage.withCurrentCompatibleCards,1);assert(view.missingCards.some(p=>p.sourceId==='source1'));return success;
  });assert(result.ok);
});

test('cold old checkpoint reuses accepted artifact, preserves targets and filters stale cards',async t=>{
  const store=remote(),m=await fixture(t,{archiveStorage:store});let old,main=0;
  const result=await m.run(input(),async r=>{if(r.stage==='corpus-summary')return summary(r,30);if(++main===1)old=m.snapshot();return main<=2?rejection:success;});assert(result.ok);
  const cold=await fixture(t,{archiveStorage:store,state:old});let calls=0;
  const options=input();options.corpusSourceBindings[0].cardStatus='stale';
  const resumed=await cold.run(options,async r=>{calls++;assert.notEqual(r.stage,'corpus-summary');const view=JSON.parse(r.messages[3].content);assert.equal(view.basis,'compressed-derived-paper-cards');assert.equal(view.paperSummaries.length,2);assert.equal(view.synthesis.length,0);return success;});
  assert(resumed.ok);assert.equal(calls,1);
});

test('uncertain internal request is never replayed after reconstruction from an older checkpoint',async t=>{
  const store=remote(),m=await fixture(t,{archiveStorage:store});let old,main=0,summaryCalls=0;
  const result=await m.run(input(),async r=>{if(r.stage==='corpus-summary'){summaryCalls++;throw new Error('transport interrupted after dispatch');}if(++main===1)old=m.snapshot();return rejection;});
  assert(!result.ok);assert.equal(summaryCalls,1);
  const cold=await fixture(t,{archiveStorage:store,state:old}),compact=generic(cold);
  const resumed=await cold.run(input(),async ()=>assert.fail('No request without a useful corpus summary'));
  assert(!resumed.ok);assert.equal(compact(),0);assert.equal(summaryCalls,1);
});

for(const failure of [{status:401,error:{code:'authentication_error'}},{status:429,error:{code:'rate_limit_exceeded'}},{status:503,error:{code:'unavailable'}},{ok:true,finishReason:'length'}])test(`card-only nonqualifying ${failure.status||'output'} failure never summarizes`,async t=>{
 const m=await fixture(t);let calls=0;await m.run(input(),async r=>{assert.notEqual(r.stage,'corpus-summary');return ++calls===1?rejection:{...failure,attempts:1};});assert.equal(calls,2);
});

test('input quota cooldown is shared by main retries and internal summary requests',async t=>{
 let time=1800000000000,waited=0,main=0,summaries=0;
 const m=await fixture(t,{now:()=>time,monotonic:()=>time,sleep:async ms=>{time+=ms;waited+=ms;}});
 const result=await m.run(input(),async r=>{
   if(r.stage==='corpus-summary'){summaries++;assert.equal(waited,2000);return summary(r);}
   if(++main<=2)return main===1?rejection:{...quota,error:{...quota.error,details:{...quota.error.details,retry_after_ms:2000}}};return success;
 });assert(result.ok);assert(summaries>=1 && summaries<=BOUNDS.requests);assert.equal(waited,2000);
});

test('semantic splitting retains every byte rather than slicing a long card',()=>{
 const text='A first complete sentence. A second complete sentence.\nLast paragraph.';
 const parts=splitUnit({handle:'P0001',part:'card',content:text});assert.equal(parts.map(p=>p.content).join(''),text);
 assert.equal(splitUnit({handle:'P0001',part:'card',content:'x'.repeat(10000)}),null);
});

test('provider-rejected summary uses deterministic complete-card batches',async t=>{
 const m=await fixture(t);let main=0,summaries=0;const represented=[];
 const result=await m.run(input(),async r=>{
   if(r.stage==='corpus-summary'){summaries++;const d=data(r);if(d.units.length>1)return rejection;represented.push(d.units[0].handle);return summary(r);}
   return ++main<=2?rejection:success;
 });assert(result.ok,JSON.stringify(result));assert.deepEqual(represented,['P0001','P0002','P0003']);assert(summaries<=BOUNDS.requests);assert.equal(m.recoverySteps,0);
});

test('individual oversized cards split semantic fields with identity on every part',async t=>{
 const events=[],m=await fixture(t,{onEvent:e=>events.push(e)});let main=0,parts=[];
 const options=input();options.messages[3].corpus_card_fallback.cards=options.messages[3].corpus_card_fallback.cards.slice(0,1);
 const result=await m.run(options,async r=>{
   if(r.stage==='corpus-summary'){const d=data(r);if(d.units[0].part==='card')return rejection;parts.push(d.units[0]);return summary(r);}
   return ++main<=2?rejection:success;
 });assert(result.ok,JSON.stringify(result));assert(parts.length>=2);assert(parts.every(p=>p.handle==='P0001'&&p.identity.cardIdentity==='card1'));assert.equal(m.recoverySteps,0,JSON.stringify(events));
});

test('cancellation during summary leaves a nonreplayable intent and never retries main',async t=>{
 const store=remote(),controller=new AbortController(),m=await fixture(t,{archiveStorage:store});let old,main=0;
 await assert.rejects(m.run({...input(),signal:controller.signal},async r=>{if(r.stage==='corpus-summary'){controller.abort();return summary(r);}if(++main===1)old=m.snapshot();return rejection;}),{code:'OPERATION_ABORTED'});
 const cold=await fixture(t,{archiveStorage:store,state:old});generic(cold);await cold.run(input(),async r=>{assert.notEqual(r.stage,'corpus-summary');return success;});assert.equal(main,2);
});

test('changed provider profile cannot reuse compressed artifact or reset reduction budget',async t=>{
 const store=remote(),m=await fixture(t,{archiveStorage:store});let main=0;
 await m.run(input(),async r=>r.stage==='corpus-summary'?summary(r):++main<=2?rejection:success);
 const cold=await fixture(t,{archiveStorage:store,state:m.snapshot(),providerProfile:'different-reasoning-config'});generic(cold);
 const result=await cold.run(input(),async ()=>assert.fail('No request without a useful corpus summary'));assert(!result.ok);
});

for(const phase of ['before-dispatch','after-effect','stage-receipt'])test(`storage failure ${phase} cannot replay a paid summary after reconstruction`,async t=>{
  const store=remote(),claim=store.claim,put=store.put;let broken=true,effects=0,old,main=0;
  store.claim=async(k,v)=>{const value=JSON.parse(v);if(broken&&phase==='before-dispatch'&&value.profile&&value.requestHash)throw new Error('claim storage down');if(broken&&phase==='stage-receipt'&&value.status==='completed'&&value.reference)throw new Error('receipt storage down');return claim(k,v);};
  store.put=async(k,v)=>{if(broken&&phase==='after-effect'&&effects&&JSON.parse(v)?.papers)throw new Error('artifact storage down');return put(k,v);};
  const m=await fixture(t,{archiveStorage:store});
  const first=await m.run(input(),async r=>{if(r.stage==='corpus-summary'){effects++;return summary(r);}if(++main===1)old=m.snapshot();return rejection;});
  assert(!first.ok);assert.equal(effects,phase==='before-dispatch'?0:1);broken=false;
  const cold=await fixture(t,{archiveStorage:store,state:old});generic(cold);
  const result=await cold.run(input(),async ()=>assert.fail('Uncertain receipt cannot dispatch'));assert(!result.ok);assert.equal(effects,phase==='before-dispatch'?0:1);
});

test('completed artifact resumes before an unadmitted main retry without repeating summarization',async t=>{
 const store=remote(),claim=store.claim;let broken=true,old,main=0,effects=0;
 store.claim=async(k,v)=>{const value=JSON.parse(v);if(broken&&value.status==='pending'&&value.requestHash&&!value.profile)throw new Error('main admission storage down');return claim(k,v);};
 const m=await fixture(t,{archiveStorage:store});
 await m.run(input(),async r=>{if(r.stage==='corpus-summary'){effects++;return summary(r);}if(++main===1)old=m.snapshot();return rejection;});
 broken=false;const cold=await fixture(t,{archiveStorage:store,state:old});cold.compact=()=>assert.fail('Completed artifact is available');
 const result=await cold.run(input(),async r=>{assert.notEqual(r.stage,'corpus-summary');assert.equal(JSON.parse(r.messages[3].content).basis,'compressed-derived-paper-cards');return success;});assert(result.ok);assert.equal(effects,1);
});

test('cold resume after a recorded reduced rejection advances target without retrying the rejected projection',async t=>{
 const store=remote(),claim=store.claim,get=store.get;let interrupted=false,broken=true,old,main=0;const targets=[];let firstActual,time=1800000000000;
 store.claim=async(k,v)=>{const result=await claim(k,v);if(broken&&JSON.parse(v).status==='rejected')interrupted=true;return result;};
 store.get=async k=>{if(interrupted&&broken)throw new Error('cold handoff');return get(k);};
 const m=await fixture(t,{archiveStorage:store,now:()=>time,monotonic:()=>time});
 await m.run(input(),async r=>{if(r.stage==='corpus-summary'){targets.push(data(r).targetTokens);const out=summary(r,50);firstActual=tokens(JSON.parse(out.message.content));return out;}if(++main===1)old=m.snapshot();return rejection;});
 broken=false;time+=86400000;const cold=await fixture(t,{archiveStorage:store,state:old,now:()=>time,monotonic:()=>time});cold.compact=()=>assert.fail('Next reduction stage should run');
 const result=await cold.run(input(),async r=>{if(r.stage==='corpus-summary'){targets.push(data(r).targetTokens);return summary(r,10);}assert.equal(JSON.parse(r.messages[3].content).reduction.stage,2);return success;});
 assert(result.ok,JSON.stringify(result));assert.equal(targets.length,2);assert(targets[1]<Math.floor(targets[0]/2));assert.equal(targets[1],Math.floor(firstActual/2));
});

for(const hard of [false,true])test(`${hard?'hard deadline':'per-call timeout'} during internal request prevents another provider call`,async t=>{
 let time=1800000000000,main=0,summaries=0;
 const m=await fixture(t,{now:()=>time,monotonic:()=>time,config:{providerCallMs:100}});
 const result=await m.run({...input(),deadlineAt:time+(hard?50:1000000)},async r=>{
  if(r.stage==='corpus-summary'){summaries++;time+=hard?101:180001;return summary(r);}main++;return rejection;
 });assert(!result.ok);assert.equal(main,2);assert.equal(summaries,1);assert.equal(result.recoveryStopReason,hard?'hard_request_deadline_exhausted':'provider_call_timeout');
});

test('twelve-request bound includes rejected batches and stops before partially covering a corpus',async t=>{
 const m=await fixture(t),options=input(),base=options.messages[3].corpus_card_fallback.cards[0];
 options.messages[3].corpus_card_fallback.cards=Array.from({length:16},(_,i)=>({...base,sourceId:'s'+String(i).padStart(2,'0')}));
 options.corpusSourceBindings=options.messages[3].corpus_card_fallback.cards.map(c=>({sourceId:c.sourceId,identity:'source:'+c.sourceId,version:c.contentHash,current:true}));
 const compact=generic(m);let main=0,summaries=0;
 const result=await m.run(options,async r=>{if(r.stage==='corpus-summary'){summaries++;return data(r).units.length>1?rejection:summary(r);}return ++main<=2?rejection:success;});
 assert(!result.ok);assert.equal(compact(),0);assert.equal(summaries,BOUNDS.requests);assert.equal(m.recoverySteps,0);assert(!result.contextMessages[3].content.includes('contextArchive'));
});

test('minimum-size bound fails honestly while an overestimated fixed floor still invokes summarization',async t=>{
 for(const tiny of [true,false]){
  const m=await fixture(t),options=input();let main=0,summaries=0;const events=[];m.onEvent=e=>events.push(e);
  if(tiny)for(const c of options.messages[3].corpus_card_fallback.cards)c.card={cacheKey:c.card.cacheKey,findings:'Short card.'};
  const result=await m.run(options,async r=>{if(r.stage==='corpus-summary'){summaries++;return summary(r);}return ++main<=2?(tiny?rejection:{...rejection,error:{...rejection.error,details:{max_input_tokens:10}}}):success;});
  if(tiny){assert.equal(summaries,0);assert(!result.ok);assert(events.some(e=>e.reason==='minimum_summary_size'));}else{assert.equal(summaries,1);assert(result.ok);assert.equal(m.recoverySteps,0);}assert(!events.some(e=>e.reason==='fixed_main_context_floor'));
 }
});

test('a source revoked during a shared cooldown is absent from the actual compressed retry',async t=>{
 let time=1800000000000,main=0;const options=input();const m=await fixture(t,{now:()=>time,monotonic:()=>time,sleep:async ms=>{time+=ms;options.corpusSourceBindings.splice(0,1);}});
 options.getCorpusSourceBindings=()=>options.corpusSourceBindings;
 const result=await m.run(options,async r=>{
  if(r.stage==='corpus-summary')return summary(r);
  if(++main<=2)return main===1?rejection:{...quota,error:{...quota.error,details:{input_token_limit:60000,retry_after_ms:1000}}};
  const view=JSON.parse(r.messages[3].content);if(view.paperSummaries){assert(!view.paperSummaries.some(p=>p.sourceId==='source1'));assert(!view.synthesis.some(s=>s.handles.includes('P0001')));}else assert(!r.messages[3].content.includes('Finding 1 under defined conditions'));return success;
 });
 // Revocation before admission invalidates the stage; no partial summary or preview is substituted.
 assert(!result.ok);assert.equal(result.recoveryStopReason,'corpus_summary_unavailable');assert.equal(main,2);
});

test('adding a corpus result does not expand an already compressed result, including an older cold checkpoint',async t=>{
 const store=remote(),m=await fixture(t,{archiveStorage:store}),options=input();let main=0,old;
 await m.run(options,async r=>{if(r.stage==='corpus-summary')return summary(r);if(++main===1)old=m.snapshot();return main<=2?rejection:success;});
 const expanded=input(),other=structuredClone(expanded.messages[3]);other.tool_call_id='corpus2';
 expanded.messages.push({role:'assistant',tool_calls:[{id:'corpus2',type:'function',function:{name:'run_corpus_workflow',arguments:'{}'}}]},other);
 const cold=await fixture(t,{archiveStorage:store,state:old});let calls=0;
 const result=await cold.run(expanded,async r=>{
   calls++;assert.notEqual(r.stage,'corpus-summary');assert.equal(JSON.parse(r.messages[3].content).basis,'compressed-derived-paper-cards');
   const second=JSON.parse(r.messages.at(-1).content);
   if(calls===1){assert(!second.basis);return rejection;}
   assert.equal(second.basis,'compatible-paper-cards');return success;
 });assert(result.ok,JSON.stringify(result));assert.equal(calls,2);
});

test('a non-size failure of a compressed main request does not authorize another reduction on cold resume',async t=>{
 const store=remote(),m=await fixture(t,{archiveStorage:store});let main=0,old;
 const first=await m.run(input(),async r=>{if(r.stage==='corpus-summary')return summary(r);if(++main===1)old=m.snapshot();return main<=2?rejection:{ok:false,status:401,error:{code:'authentication_error'},attempts:1};});
 assert.equal(first.status,401);
 const cold=await fixture(t,{archiveStorage:store,state:old});cold.compact=()=>assert.fail('Authentication failure must not trigger recovery');
 const result=await cold.run(input(),async r=>{assert.notEqual(r.stage,'corpus-summary');assert.equal(JSON.parse(r.messages[3].content).basis,'compressed-derived-paper-cards');return success;});assert(result.ok);
});

test('old cold checkpoint restores the durable absolute quota reset without restarting its full delay',async t=>{
 const store=remote();let time=1800000000000,old,main=0,waited=0;
 const m=await fixture(t,{archiveStorage:store,now:()=>time,monotonic:()=>time});
 const first=await m.run({...input(),deadlineAt:time+1000},async r=>{assert.notEqual(r.stage,'corpus-summary');if(++main===1){old=m.snapshot();return rejection;}return {...quota,error:{...quota.error,details:{input_token_limit:60000,retry_after_ms:5000}}};});
 assert(!first.ok);time+=2000;
 const cold=await fixture(t,{archiveStorage:store,state:old,now:()=>time,monotonic:()=>time,sleep:async ms=>{time+=ms;waited+=ms;}});generic(cold);
 const restored=[],record=cold.quota.record.bind(cold.quota);cold.quota.record=info=>{restored.push(info);return record(info);};
 const result=await cold.run(input(),async ()=>assert.fail('No valid summary before interrupted quota wait'));
 assert(!result.ok);assert(restored.some(q=>q.retryAfterMs===3000));assert.equal(waited,0);
});

test('managed corpus cannot be replaced by a generic preview even if a compactor regresses',async t=>{
 const m=await fixture(t);let main=0,summaries=0;
 m.compact=async options=>options.messages.map(row=>row.tool_call_id==='corpus'?{...row,content:'{"contextArchive":"bad","preview":"omitted"}'}:row);
 const result=await m.run(input(),async r=>r.stage==='corpus-summary'?summary(r,[120,45,10][summaries++]):(main++,rejection));
 assert(!result.ok);assert.equal(main,5);assert.equal(result.recoveryStopReason,'non_corpus_context_not_reducible');
 assert.equal(JSON.parse(result.contextMessages[3].content).basis,'compressed-derived-paper-cards');
 assert(!result.contextMessages[3].content.includes('contextArchive'));
 assert.equal(result.corpusRecovery.stopReason,'corpus_reduction_bound');
 assert(result.corpusRecovery.events.some(e=>e.event==='terminal-incomplete-recovery'));
});

test('legacy managed archive preview restores the latest domain summary on cold start',async t=>{
 const store=remote(),m=await fixture(t,{archiveStorage:store});let main=0;
 const result=await m.run(input(),async r=>r.stage==='corpus-summary'?summary(r):++main<=2?rejection:success);
 assert(result.ok);
 const legacy=input(),reference=await m.store(legacy.messages[3].content);
 delete legacy.messages[3].corpus_card_fallback;
 legacy.messages[3].content=JSON.stringify({contextArchive:reference,preview:'obsolete sliced content'});
 const cold=await fixture(t,{archiveStorage:store,state:m.snapshot()});let calls=0;
 const resumed=await cold.run(legacy,async r=>{calls++;assert.notEqual(r.stage,'corpus-summary');assert.equal(r.messages[3].content,result.contextMessages[3].content);return success;});
 assert(resumed.ok);assert.equal(calls,1);
});

test('eligible prior assistant context is summarized while useful corpus and pending exchanges remain exact',async t=>{
 const m=await fixture(t),options=input();
 options.messages.splice(1,0,{role:'assistant',content:'Prior discussion. '.repeat(1000)});
 m.accept(options.messages);let main=0,summaries=0,genericCalls=0,kept;
 const result=await m.run(options,async r=>{
  if(r.stage==='corpus-summary')return summary(r,[120,45,10][summaries++]);
  if(r.stage==='context-summary'){genericCalls++;assert(!JSON.stringify(r).includes('Qualified finding'));return {...success,message:{content:'Previously discussed the research objectives.'}};}
  main++;if(main===5)kept=r.messages.filter((_,i)=>i!==1);
  if(main===6){assert.deepEqual(r.messages.filter((_,i)=>i!==1),kept);assert.match(r.messages[1].content,/Previously discussed/);}
  return main<=5?rejection:success;
 });
 assert(result.ok,JSON.stringify(result));assert.equal(genericCalls,2);assert.equal(m.recoverySteps,1);assert.equal(main,6);
});

test('revoking every summarized source fails before sending an empty substitute on cold resume',async t=>{
 const store=remote(),m=await fixture(t,{archiveStorage:store});let main=0;
 await m.run(input(),async r=>r.stage==='corpus-summary'?summary(r):++main<=2?rejection:success);
 const cold=await fixture(t,{archiveStorage:store,state:m.snapshot()});
 const result=await cold.run({...input(),corpusSourceBindings:[]},()=>assert.fail('No empty summary request'));
 assert(!result.ok);assert.equal(result.recoveryStopReason,'corpus_summary_unavailable');
 assert.equal(JSON.parse(result.contextMessages[3].content).paperSummaries.length,0);
 assert.equal(result.corpusRecovery.providerRequests,0);
});

for(const mode of ['repair','batches'])test(`170s corpus ${mode} calls and reduced retries do not share an elapsed cutoff`,async t=>{
 let time=1800000000000,main=0,summaries=0;const events=[];
 const m=await fixture(t,{now:()=>time,monotonic:()=>time,onEvent:e=>events.push(e)});
 const result=await m.run({...input(),deadlineAt:time+3000000},async r=>{
  if(r.stage==='corpus-summary'){
   assert.equal(r.deadlineAt-time,180000);assert.equal(r.providerCallTimeoutMs,180000);
   time+=170000;summaries++;
   if(mode==='repair'&&summaries===1)return {...success,message:{content:'invalid PRIVATE_CARD_TEXT'}};
   if(mode==='batches'&&data(r).units.length>1)return rejection;
   return summary(r);
  }
  main++;if(main===1)return rejection;
  assert.equal(r.deadlineAt-time,180000);time+=170000;
  return main===2?rejection:success;
 });
 assert(result.ok,JSON.stringify(result));assert.equal(main,3);assert(summaries>=2);
 assert.equal(m.recoverySteps,0);assert(time-1800000000000>180000);
 if(mode==='repair'){
  const failure=events.find(e=>e.event==='corpus-summary-validation-failure');assert.equal(failure.reason,'malformed_summary');
  assert(result.corpusRecovery.events.some(e=>e.event===failure.event&&e.reason===failure.reason));
  assert(!JSON.stringify(result.corpusRecovery).includes('PRIVATE_CARD_TEXT'));
 }
});

test('cold recovery ignores old elapsed metadata and reuses a completed summary with a fresh call timer',async t=>{
 const store=remote();let time=1800000000000,main=0;
 const m=await fixture(t,{archiveStorage:store,now:()=>time,monotonic:()=>time});
 const first=await m.run(input(),async r=>r.stage==='corpus-summary'?summary(r):++main<=2?rejection:success);
 assert(first.ok);const saved=m.snapshot();time+=86400000;
 const cold=await fixture(t,{archiveStorage:store,state:saved,now:()=>time,monotonic:()=>time});
 let requests=0;
 const result=await cold.run({...input(),deadlineAt:time+400000},async r=>{
  requests++;assert.notEqual(r.stage,'corpus-summary');assert.equal(r.deadlineAt-time,180000);
  assert.equal(r.messages[3].content,first.contextMessages[3].content);time+=170000;return success;
 });assert(result.ok);assert.equal(requests,1);
});

test('timed-out summary remains uncertain across cold reconstruction and is never replayed',async t=>{
 const store=remote();let time=1800000000000,main=0,old,effects=0,aborted=false;
 const m=await fixture(t,{archiveStorage:store,now:()=>time,monotonic:()=>time});
 const first=await m.run({...input(),deadlineAt:time+1000000},async r=>{
  if(r.stage==='corpus-summary'){effects++;r.signal.addEventListener('abort',()=>aborted=true);time+=180001;return summary(r);}
  if(++main===1)old=m.snapshot();return rejection;
 });assert(!first.ok);assert.equal(first.recoveryStopReason,'provider_call_timeout');assert(aborted);
 time+=86400000;
 const cold=await fixture(t,{archiveStorage:store,state:old,now:()=>time,monotonic:()=>time});
 const resumed=await cold.run(input(),()=>assert.fail('An uncertain provider call must not be replayed'));
 assert(!resumed.ok);assert.equal(effects,1);
});

for(const correct of [true,false])test(`non-shrinking final request uses only one bounded correction, successful=${correct}`,async t=>{
 const store=remote(),m=await fixture(t,{archiveStorage:store}),original=m.tokens.bind(m);let summaries=0,main=0;
 m.tokens=options=>{
  const row=options.messages?.find(x=>x.tool_call_id==='corpus');
  if(row&&JSON.parse(row.content).basis==='compressed-derived-paper-cards'&&(!correct||summaries===1))return 100000;
  return original(options);
 };
 const result=await m.run(input(),async r=>{
  if(r.stage==='corpus-summary')return summary(r,++summaries===1?120:35);
  return ++main<=2?rejection:success;
 });
 assert.equal(result.ok,correct);assert.equal(summaries,2);assert.equal(main,correct?3:2);
 const measured=result.corpusRecovery.events.filter(e=>e.event==='corpus-summary-measured');assert.equal(measured.length,2);
 assert.equal(measured[1].targetTokens,Math.floor(Math.min(measured[0].targetTokens,measured[0].actualSummaryTokens)/2));
 assert(result.corpusRecovery.events.some(e=>e.reason==='summary_no_measurable_reduction'));
 if(!correct)assert.equal(result.corpusRecovery.stopReason,'summary_no_measurable_reduction');
 else {
  const snapshot=m.snapshot(),cold=await fixture(t,{archiveStorage:store,state:snapshot});let reused=0;
  const resumed=await cold.run(input(),async r=>{reused++;assert.notEqual(r.stage,'corpus-summary');assert.equal(r.messages[3].content,result.contextMessages[3].content);return success;});
  assert(resumed.ok);assert.equal(reused,1);
  assert.deepEqual(Object.values(cold.snapshot().corpusReductions).map(x=>[x.targetTokens,x.actualSummaryTokens]),Object.values(snapshot.corpusReductions).map(x=>[x.targetTokens,x.actualSummaryTokens]));
 }
});

test('undersized first summary exhausts the next useful minimum without another summary request',async t=>{
 const m=await fixture(t);let summaries=0,main=0;
 const result=await m.run(input(),async r=>{if(r.stage==='corpus-summary'){summaries++;return summary(r);}main++;return rejection;});
 assert(!result.ok);assert.equal(summaries,1);assert.equal(main,3);
 assert.equal(result.corpusRecovery.stopReason,'minimum_summary_size');
 const state=Object.values(m.snapshot().corpusReductions)[0];assert(state.actualSummaryTokens<512);assert(state.targetTokens>state.actualSummaryTokens*2);
 assert.equal(JSON.parse(result.contextMessages[3].content).reduction.actualSummaryTokens,state.actualSummaryTokens);
});

test('cold resume never repeats a correction whose request outcome is uncertain',async t=>{
 const store=remote(),m=await fixture(t,{archiveStorage:store}),measure=m.tokens.bind(m);let old,summaries=0,main=0;
 m.tokens=options=>options.messages?.some(row=>row.tool_call_id==='corpus'&&JSON.parse(row.content).basis==='compressed-derived-paper-cards')?100000:measure(options);
 await m.run(input(),async r=>{if(r.stage==='corpus-summary'){if(++summaries===2)throw new Error('Lost correction outcome');return summary(r,120);}if(++main===1)old=m.snapshot();return rejection;});
 const cold=await fixture(t,{archiveStorage:store,state:old});
 const result=await cold.run(input(),()=>assert.fail('Uncertain correction cannot replay'));
 assert(!result.ok);assert.equal(summaries,2);
});
