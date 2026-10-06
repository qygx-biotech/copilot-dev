import test from 'node:test';
import assert from 'node:assert/strict';
import api from '../../docs/runtime-state-tools.js';
const fixture = () => {
 const local = {project:{workspaceId:'p'},sourceMap:{paperSources:[{sourceId:'paper',contentHash:'v1',catalogStatus:'ready'}]}};
 const turn = {turnId:'turn',workspaceId:'p',bindings:[{sourceId:'paper',version:'v1',current:true}],messages:[{role:'assistant',content:'private finding'}]};
 const memory = {records:[{memoryId:'allowed',status:'active',text:'known',sourceIds:['paper']},{memoryId:'excluded',status:'active',text:'secret',sourceIds:['other']}]};
 const state = api.create({owner:'/root',context:()=>local,transcript:()=>({turns:[turn]}),memory:()=>memory,saveMemory:async note=>({saved:note})}); return {state,local,turn};
};
test('history and typed memory reads withhold excluded and changed sources without modifying stores', async()=>{
 const {state,local,turn}=fixture(); assert.equal((await state.call('memories_list',{})).memories.length,1);
 await assert.rejects(state.call('memories_read',{memory_id:'excluded'}),{code:'MEMORY_NOT_IN_SCOPE'});
 let result=await state.call('history_read_item',{window_id:'turn',item_id:'turn:0'});assert.match(result.content,/private finding/);
 local.sourceMap.paperSources[0].contentHash='v2';result=await state.call('history_read_item',{window_id:'turn',item_id:'turn:0'});assert.match(result.content,/INVALIDATED/);assert(!result.content.includes('private finding'));assert.equal(turn.messages[0].content,'private finding');
});
test('notes are owned, bounded, path-safe and separate from project memory',async()=>{
 const {state}=fixture();await state.call('notes_write_file',{path:'work/plan.md',text:'a\nb'});await state.call('notes_append_to_file',{path:'work/plan.md',text:'\nc'});
 assert.equal((await state.call('notes_read_file',{path:'work/plan.md',offset:1,limit:1})).text,'b');
 assert.equal((await state.call('notes_search_contents',{query:'c'})).matches.length,1);
 for(const path of ['../x','/x','x//y','x\\y']) await assert.rejects(state.call('notes_write_file',{path,text:'x'}),{code:'INVALID_NOTE_PATH'});
 state.close();await assert.rejects(state.call('notes_read_file',{path:'work/plan.md'}),{code:'NOTE_NOT_FOUND'});
});
test('board uses distinct IDs, existing subscribers and turn-owned cleanup',async()=>{
 const {state}=fixture(), notifications=[];
 const child=api.create({owner:'child',sharedBoard:state.board,context:()=>({}),transcript:()=>({}),memory:()=>({}),notify:message=>notifications.push(message)});
 await state.call('create_channel',{channel_name:'research'});await child.call('subscribe',{channel_name:'research'});
 const post=await state.call('post',{channel_name:'research',text:'Unverified analysis'});
 assert.match(post.message_id,/^message:/);assert.match(post.thread_id,/^thread:/);assert.equal(notifications.length,1);
 assert.equal((await child.call('read_thread',{thread_id:post.thread_id})).posts.length,1);
 await child.call('unsubscribe',{channel_name:'research'});await state.call('post',{thread_id:post.thread_id,text:'followup'});assert.equal(notifications.length,1);
 const separate=fixture().state;await assert.rejects(separate.call('read_post',{message_id:post.message_id}),{code:'POST_NOT_FOUND'});
 state.board.closed=true;await assert.rejects(child.call('get_channels',{}),{code:'RUNTIME_OWNER_EXPIRED'});
});
