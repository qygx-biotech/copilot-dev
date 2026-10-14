(function(root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; if (root) root.BioDesignRuntimeStateTools = api; })(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const fail = code => Object.assign(new Error(code), { code });
  const clone = value => JSON.parse(JSON.stringify(value));
  const id = type => `${type}:${globalThis.crypto.randomUUID()}`;
  const boardNames = ['create_channel','get_channels','list_threads','search_posts','read_thread','read_post','subscribe','unsubscribe','post'];
  function board() { return { channels: new Map(), threads: new Map(), posts: new Map(), subscribers: new Map(), closed: false }; }
  // conversationMemory: the project's memory from earlier conversations ({ search, read }), or null when off.
  function create({ owner, sharedBoard = board(), context, transcript, memory, saveMemory, conversationMemory = null, notify = () => {} }) {
    const notes = new Map();
    const path = value => { if (typeof value !== 'string' || value.startsWith('/') || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f]/.test(value)) throw fail('INVALID_NOTE_PATH'); return value; };
    function memories() {
      const local = context(), selected = new Set((local.sourceMap?.paperSources || []).filter(s => s.contentHash && !['dirty','stale','missing','deleted'].includes(s.catalogStatus)).map(s => s.sourceId));
      return (memory()?.records || []).filter(item => item.status === 'active' && (item.sourceIds || []).every(source => selected.has(source)) && !(item.experimentIds || []).length)
        .map(item => ({ memory_id: item.memoryId, kind: item.kind, text: item.text, sourceIds: item.sourceIds || [], status: item.status, evidence_status: 'project_memory_not_source_evidence' }));
    }
    function windows() {
      const local = context(), sources = new Map((local.sourceMap?.paperSources || []).map(source => [source.sourceId, source]));
      return [...(transcript()?.summaries || []), ...(transcript()?.turns || [])].map(turn => {
        const valid = turn.workspaceId === local.project?.workspaceId && turn.bindings?.length && turn.bindings.every(binding => {
          const current = sources.get(binding.sourceId);
          return binding.current && current?.contentHash && current.contentHash === binding.version && !['dirty','stale','missing','deleted'].includes(current.catalogStatus);
        });
        return { window_id: turn.turnId, status: turn.status, compacted: turn.compacted === true, evidence_status: valid ? 'historical_unverified' : 'invalidated',
          items: (turn.messages || []).map((message, i) => ({ item_id: `${turn.turnId}:${i}`, role: message.role,
            content: valid ? JSON.stringify(message) : 'HISTORICAL_EVIDENCE_INVALIDATED: source scope/version cannot be verified. Reread current evidence; no historical call is executed.' })) };
      });
    }
    const limited = items => items.slice(0, 50);
    return { board: sharedBoard,
      async call(name, args) {
        if (sharedBoard.closed) throw fail('RUNTIME_OWNER_EXPIRED');
        if (name === 'conversation_memory_search' || name === 'conversation_memory_read') {
          if (!conversationMemory) throw fail('MEMORY_DISABLED');
          return name === 'conversation_memory_search' ? conversationMemory.search(args.query) : conversationMemory.read(args.path);
        }
        if (name === 'memories_list') return { memories: limited(memories()) };
        if (name === 'memories_search') return { memories: limited(memories().filter(item => item.text.toLowerCase().includes(args.query.toLowerCase()))) };
        if (name === 'memories_read') { const item = memories().find(item => item.memory_id === args.memory_id); if (!item) throw fail('MEMORY_NOT_IN_SCOPE'); return item; }
        if (name === 'memories_add_ad_hoc_note') return saveMemory(args.note);
        if (name === 'history_list_windows') return { windows: windows().map(({ items, ...window }) => ({ ...window, item_count: items.length })) };
        if (name === 'history_search_contents') return { items: windows().flatMap(window => window.items.filter(item => item.content.toLowerCase().includes(args.query.toLowerCase())).map(item => ({ window_id: window.window_id, ...item }))).slice(0, args.limit || 20) };
        if (name.startsWith('history_')) {
          const window = windows().find(item => item.window_id === args.window_id); if (!window) throw fail('HISTORY_WINDOW_NOT_FOUND');
          if (name === 'history_list_items') return { items: window.items.slice(args.offset || 0, (args.offset || 0) + (args.limit || 20)) };
          const item = window.items.find(item => item.item_id === args.item_id); if (!item) throw fail('HISTORY_ITEM_NOT_FOUND'); return item;
        }
        if (name === 'notes_list_files_by_prefix') return { files: [...notes.keys()].filter(p => !args.prefix || p.startsWith(args.prefix)) };
        if (name === 'notes_search_contents') return { matches: [...notes].filter(([, text]) => text.includes(args.query)).map(([path, text]) => ({ path, text })) };
        if (name.startsWith('notes_')) {
          const key = path(args.path);
          if (name === 'notes_read_file') { if (!notes.has(key)) throw fail('NOTE_NOT_FOUND'); const lines = notes.get(key).split('\n'); return { path: key, total_lines: lines.length, text: lines.slice(args.offset || 0, (args.offset || 0) + (args.limit || 100)).join('\n'), evidence_status: 'unverified_working_note' }; }
          const text = (name === 'notes_append_to_file' ? notes.get(key) || '' : '') + args.text;
          if (text.length > 64000 || !notes.has(key) && notes.size >= 32 || [...notes].reduce((n, [p, t]) => n + (p === key ? 0 : t.length), text.length) > 256000) throw fail('NOTE_LIMIT');
          notes.set(key, text); return { path: key, characters: text.length, persistence: 'parent_turn', evidence_status: 'unverified_working_note' };
        }
        const b = sharedBoard;
        const channel = value => { if (!b.channels.has(value)) throw fail('CHANNEL_NOT_FOUND'); return value; };
        if (name === 'create_channel') {
          if (b.channels.has(args.channel_name)) throw fail('CHANNEL_EXISTS'); if (b.channels.size >= 32) throw fail('BOARD_LIMIT');
          const item = { channel_name: args.channel_name, channel_id: id('channel'), owner }; b.channels.set(args.channel_name, item); return clone(item);
        }
        if (name === 'get_channels') return { channels: [...b.channels.values()].filter(c => !args.query || c.channel_name.includes(args.query)).map(clone) };
        if (name === 'list_threads') return { threads: [...b.threads.values()].filter(t => t.channel_name === channel(args.channel_name)).map(clone) };
        if (name === 'search_posts') return { posts: limited([...b.posts.values()].filter(p => (!args.channel_name || p.channel_name === channel(args.channel_name)) && p.text.includes(args.query))).map(clone) };
        if (name === 'read_thread') { if (!b.threads.has(args.thread_id)) throw fail('THREAD_NOT_FOUND'); return { posts: [...b.posts.values()].filter(p => p.thread_id === args.thread_id).map(clone) }; }
        if (name === 'read_post') { const post = b.posts.get(args.message_id); if (!post) throw fail('POST_NOT_FOUND'); return clone(post); }
        if (name === 'subscribe' || name === 'unsubscribe') {
          channel(args.channel_name); const subscriptions = b.subscribers.get(args.channel_name) || new Map();
          if (name === 'subscribe') subscriptions.set(owner, notify); else subscriptions.delete(owner);
          b.subscribers.set(args.channel_name, subscriptions); return { subscribed: name === 'subscribe', channel_name: args.channel_name };
        }
        if (name === 'post') {
          if (b.posts.size >= 128) throw fail('BOARD_LIMIT');
          let thread = args.thread_id && b.threads.get(args.thread_id);
          if (args.thread_id && !thread) throw fail('THREAD_NOT_FOUND');
          if (thread && args.channel_name && args.channel_name !== thread.channel_name) throw fail('CHANNEL_MISMATCH');
          if (!thread) { channel(args.channel_name); thread = { thread_id: id('thread'), channel_name: args.channel_name }; }
          const post = { message_id: id('message'), thread_id: thread.thread_id, channel_name: thread.channel_name, author: owner, text: args.text, evidence_status: 'untrusted_agent_analysis' };
          b.threads.set(thread.thread_id, thread); b.posts.set(post.message_id, post);
          const notifications = [];
          for (const [subscriber, deliver] of b.subscribers.get(post.channel_name) || []) if (subscriber !== owner) { try { deliver({ message_id: post.message_id, thread_id: post.thread_id, text: post.text }); notifications.push({ subscriber, delivered: true }); } catch { notifications.push({ subscriber, delivered: false }); } }
          return { ...clone(post), notifications };
        }
        throw fail('RUNTIME_TOOL_NOT_ALLOWED');
      },
      close() { notes.clear(); for (const subscribers of sharedBoard.subscribers.values()) subscribers.delete(owner); },
    };
  }
  return { create, board, boardNames };
});
