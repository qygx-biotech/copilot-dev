(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BioDesignRuntimeConcurrency=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Audited implementations only. These clone/read task-local immutable state;
  // mutations remain exclusive, creating a barrier before later readers.
  const readers = new Set(['read_skill','skills_read','skills_list','tool_search','clock_curr_time','get_context_remaining',
    'notes_list_files_by_prefix','notes_read_file','notes_search_contents',
    'get_channels','list_threads','search_posts','read_thread','read_post','host_project_status']);
  return { parallelSafe: name => readers.has(name), names: [...readers] };
});
