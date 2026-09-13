import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectFilesystem } from '../services/project-filesystem.mjs';
import { LocalExecutionService } from '../services/local-execution-service.mjs';
import { registerAcademicWorkflows, paperPdfLinks } from '../services/academic-workflows.mjs';
import { PaperMcpClient, paperServerPath } from '../services/paper-mcp-client.mjs';
import academic from '../../shared/academic-tools.js';
import { paperPageLinks } from '../services/paper-acquisition.mjs';
const ref = 'paper_' + '1'.repeat(24);
const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
const record = { paper_ref: ref, title: 'A useful academic paper', doi:'10.1000/test', authors:['A'], providers:[{source:'arxiv',paper_id:'a'}], locations:[{url:'https://papers.example.org/article',kind:'landing_page'}] };
const metadata = () => ({version:1,status:'completed',papers:[structuredClone(record)]});
async function fixture(t, fetchSource, mcp = { call: async () => metadata() }) {
 const root = await mkdtemp(path.join(os.tmpdir(),'biodesign-academic-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const filesystem=await ProjectFilesystem.open(root);
 const active={execution:new LocalExecutionService(),sourceDownloads:new AbortController()};
 registerAcademicWorkflows(active,mcp,()=>true,{fetchSource});
 return {active,filesystem,run:(name,args,permission='workspace_write',surface='agent_command')=>active.execution.run(name,{args,permission,surface},{filesystem})};
}

test('paper acquisition resolves HTML metadata, saves only PDFs, persists provenance and reuses the same file',async t=>{
 const fetched=[];
 const f=await fixture(t,async url=>{
  fetched.push(url);
  return {bytes:url.endsWith('.pdf')?pdf:Buffer.from('<meta name="citation_doi" content="10.1000/test"><meta name="citation_pdf_url" content="/paper.pdf">'),contentType:url.endsWith('.pdf')?'application/pdf':'text/html',resolvedUrl:url};
 });
 const first=await f.run('download_papers',{paper_refs:[ref]});
 assert.equal(first.results[0].status,'downloaded');
 assert.equal(first.results[0].contentType,'application/pdf');
 const meta=JSON.parse(await f.filesystem.readText(first.results[0].metadataPath));
 assert.equal(meta.academic_paper.paper_ref,ref);
 assert.match(meta.content_sha256,/^[a-f0-9]{64}$/);
 const second=await f.run('download_papers',{paper_refs:[ref]});
 assert.equal(second.results[0].path,first.results[0].path);
 assert.equal(second.results[0].reused,true);
 assert.equal(fetched.length,2);
});

test('HTML alone and mismatched citation identity never produce a saved paper',async t=>{
 const f=await fixture(t,async url=>({bytes:Buffer.from('<meta name="citation_doi" content="10.1000/wrong"><meta name="citation_pdf_url" content="/other.pdf">'),contentType:'text/html',resolvedUrl:url}));
 const output=await f.run('download_papers',{paper_refs:[ref]});
 assert.equal(output.results[0].status,'failed');
 assert.equal(await f.filesystem.exists('literature'),false);
 assert.equal(output.results[0].attempts[0].code,'PAPER_IDENTITY_MISMATCH');
});

test('academic read tools work in read-only Agent Work; Side Chat and unauthorized writes are denied',async t=>{
 const f=await fixture(t,()=>assert.fail('must not fetch'));
 assert.equal((await f.run('search_academic_papers',{query:'topic'},'read_only')).papers[0].paper_ref,ref);
 await assert.rejects(f.run('download_papers',{paper_refs:[ref]},'read_only'),{code:'PERMISSION_DENIED'});
 await assert.rejects(f.run('search_academic_papers',{query:'topic'},'full_access','side_chat'),{code:'PERMISSION_DENIED'});
 f.active.sourceDownloads.abort();
 await assert.rejects(f.run('search_academic_papers',{query:'topic'}),{code:'OPERATION_ABORTED'});
});

test('contracts reject fabricated handles, unsafe destinations and invalid provider sets',()=>{
 for(const args of [{paper_refs:['../../other']},{paper_refs:[ref],destination:'../other'},{paper_refs:[ref,ref]}]) assert.throws(()=>academic.validateInput('download_papers',args));
 assert.throws(()=>academic.validateInput('search_academic_papers',{query:'topic',providers:['unpaywall']}));
 assert.throws(()=>academic.validateResult('download_papers',{version:1,status:'completed',results:[{paper_ref:ref,status:'downloaded',path:'literature/a.html',contentType:'text/html'}]}));
 assert.deepEqual(paperPdfLinks('<meta content="/a.pdf?a=1&amp;b=2" name="citation_pdf_url">','https://example.org/p'),['https://example.org/a.pdf?a=1&b=2']);
 assert.match(paperServerPath({packaged:true,resourcesPath:'/app/resources'}),/resources[/\\]paper-search-server/);
});

test('real stdio MCP search, metadata, resolution and local download round trip',async t=>{
 const python=path.resolve('desktop/paper-search/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 try {await access(python);} catch {t.skip('Build dependencies are installed by paper:build; standalone JS tests need no Python.');return;}
 const mcp=new PaperMcpClient({command:python,args:[path.resolve('desktop/test/fixtures/paper-mcp-fixture.py')]});
 t.after(()=>mcp.close());
 const f=await fixture(t,async url=>({bytes:pdf,contentType:'application/pdf',resolvedUrl:url}),mcp);
 const found=await f.run('search_academic_papers',{query:'topic',providers:['arxiv']});
 const paperRef=found.papers[0].paper_ref;
 assert.ok(academic.validRef(paperRef));
 assert.equal((await f.run('get_academic_paper',{paper_ref:paperRef})).papers[0].abstract,'Fixture abstract.');
 const downloaded=await f.run('download_papers',{paper_refs:[paperRef]});
 assert.equal(downloaded.results[0].status,'downloaded');
 await mcp.close();
 await assert.rejects(mcp.call('get_academic_paper',{paper_ref:paperRef}),{code:'OPERATION_ABORTED'});
});

test('PMC landing metadata resolves to the Europe PMC PDF before a failing publisher', async t => {
 const calls=[];
 const mcp={call:async()=>({version:1,status:'completed',papers:[{...record,locations:[
  {url:'https://link.springer.com/content/pdf/article.pdf',kind:'pdf_candidate'},
  {url:'https://europepmc.org/articles/PMC9907219',kind:'landing_page'}]}]})};
 const f=await fixture(t,async url=>{calls.push(url);assert.equal(url,'https://europepmc.org/articles/PMC9907219?pdf=render');return {bytes:pdf,contentType:'application/pdf',resolvedUrl:'https://europepmc.org/api/getPdf?pmcid=PMC9907219'};},mcp);
 const output=await f.run('download_papers',{paper_refs:[ref]});
 assert.equal(output.results[0].status,'downloaded');assert.equal(calls.length,1);
});

test('HTML meta refresh reaches an article and its PDF without executing scripts',async t=>{
 const calls=[];
 const f=await fixture(t,async url=>{
  calls.push(url);
  if(url.endsWith('/article')) return {bytes:Buffer.from('<META HTTP-EQUIV="REFRESH" content="2; url=\'/retrieve?article=1&amp;view=full\'"><script>throw new Error("never run")</script>'),contentType:'text/html',resolvedUrl:url};
  if(url.includes('/retrieve?')) return {bytes:Buffer.from('<meta name="citation_doi" content="https://doi.org/10.1000/test"><meta name="citation_pdf_url" content="/paper.pdf">'),contentType:'text/html',resolvedUrl:url};
  assert.ok(url.endsWith('/paper.pdf'));return {bytes:pdf,contentType:'application/pdf',resolvedUrl:url};
 });
 const output=await f.run('download_papers',{paper_refs:[ref]});
 assert.equal(output.results[0].status,'downloaded');
 assert.equal(calls[1],'https://papers.example.org/retrieve?article=1&view=full');
 assert.deepEqual(output.results[0].attempts.map(x=>x.code),['HTML_REDIRECT','PDF_LINKS_FOUND']);
});

test('unsafe HTML redirects, script decoys and redirect loops never save files',async t=>{
 for(const target of ['javascript:alert(1)','file:///etc/passwd','http://127.0.0.1/admin']) {
  assert.equal(paperPageLinks(`<meta http-equiv="refresh" content="0;url=${target}">`,'https://example.org/article').redirect,'');
 }
 assert.deepEqual(paperPageLinks('<script>const x = \'<meta name="citation_pdf_url" content="/wrong.pdf">\';</script>','https://example.org/article').pdfs,[]);
 const f=await fixture(t,async url=>({bytes:Buffer.from('<meta http-equiv="refresh" content="0;url=/article">'),contentType:'text/html',resolvedUrl:url}));
 const output=await f.run('download_papers',{paper_refs:[ref]});
 assert.equal(output.results[0].attempts[0].code,'HTML_REDIRECT_LOOP');
 assert.equal(await f.filesystem.exists('literature'),false);
});

test('a PDF-suffixed HTML response is rejected and an independent candidate can succeed',async t=>{
 const mcp={call:async()=>({version:1,status:'completed',papers:[{...record,locations:[
  {url:'https://papers.example.org/bad.pdf',kind:'pdf_candidate'},
  {url:'https://repository.example.org/good.pdf',kind:'pdf_candidate'}]}]})};
 const f=await fixture(t,async url=>({bytes:url.includes('/bad.')?Buffer.from('<html>Not a PDF</html>'):pdf,contentType:'application/pdf',resolvedUrl:url}),mcp);
 const output=await f.run('download_papers',{paper_refs:[ref]});
 assert.equal(output.results[0].status,'downloaded');
 assert.equal(output.results[0].attempts[0].code,'INVALID_PDF');
 assert.equal(output.results[0].resolvedUrl,'https://repository.example.org/good.pdf');
});

test('Elsevier declared article destination survives a failing temporary preferences redirect',async t=>{
 const start='https://linkinghub.elsevier.com/retrieve/pii/S0167779924000283';
 const target='https://www.cell.com/trends/biotechnology/fulltext/S0167-7799(24)00028-3';
 const mcp={call:async()=>({version:1,status:'completed',papers:[{...record,locations:[{url:start,kind:'landing_page'}]}]})};
 const f=await fixture(t,async url=>{
  if(url===start) return {bytes:Buffer.from(`<meta http-equiv="refresh" content="0;url=/retrieve/articleSelectPrefsTemp?Redirect=${encodeURIComponent(target)}&amp;key=fixture">`),contentType:'text/html',resolvedUrl:url};
  if(url.includes('articleSelectPrefsTemp')) throw Object.assign(new Error('temporary redirect unavailable'),{code:'HTTP_ERROR',httpStatus:503});
  if(url===target) return {bytes:Buffer.from('<meta name="citation_pdf_url" content="/article.pdf">'),contentType:'text/html',resolvedUrl:url};
  assert.equal(url,'https://www.cell.com/article.pdf');return {bytes:pdf,contentType:'application/pdf',resolvedUrl:url};
 },mcp);
 const output=await f.run('download_papers',{paper_refs:[ref]});
 assert.equal(output.results[0].status,'downloaded');
 assert.equal(output.results[0].attempts[1].httpStatus,503);
});
