const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SIDE_CHAT_TOOL_DEFINITIONS,
  buildSideChatCatalog,
  compactSideChatAgentMessages,
  createSideChatKnowledgeBase,
  executeSideChatTool,
  runSideChatAgent
} = require("../side-chat-agent");

function toolCall(name, args, id = "tool-1") {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

function makeWorkspaceContext() {
  return {
    localWorkspaceContext: {
      scope: {
        type: "project",
        files: []
      },
      project: {
        workspaceName: "EctD workspace",
        goal: "Understand EctD variants",
        projectSummary: "The project compares catalytic variants."
      },
      inventory: [
        {
          paperId: "paper-a",
          name: "paper-a.pdf",
          relativePath: "literature/paper-a.pdf",
          extension: "pdf",
          size: 1200,
          processor: "pdf",
          summaryAvailable: true,
          summaryStatus: "ready"
        },
        {
          name: "run-1.csv",
          relativePath: "experiments/fermentation/run-1.csv",
          extension: "csv",
          size: 800,
          processor: null,
          summaryAvailable: false,
          summaryStatus: "unprocessed"
        }
      ],
      files: [
        {
          paperId: "paper-a",
          name: "paper-a.pdf",
          relativePath: "literature/paper-a.pdf",
          extension: "pdf",
          analysisStatus: "processed",
          evidenceType: "cached-summary",
          content: "A163V increased catalytic activity in the reported assay."
        }
      ],
      notices: ["CSV content is unavailable in this request."]
    }
  };
}

test("Side Chat exposes only read-only tools", () => {
  const names = SIDE_CHAT_TOOL_DEFINITIONS.map((tool) => tool.function.name);
  assert.deepEqual(names, [
    "list_workspace_items",
    "search_workspace_items",
    "read_workspace_item",
    "read_project_context"
  ]);
  assert.ok(
    names.every(
      (name) =>
        !/(write|edit|delete|remove|bash|shell|execute|task|agent|recommend)/i.test(
          name
        )
    )
  );
});

test("catalog is progressive and file content loads only through an exact item id", () => {
  const knowledgeBase = createSideChatKnowledgeBase(makeWorkspaceContext());
  const catalog = buildSideChatCatalog(knowledgeBase);
  assert.match(catalog, /local:1 \| reference \| literature\/paper-a\.pdf/);
  assert.match(catalog, /local:2 \| experiment/);
  assert.doesNotMatch(catalog, /A163V increased catalytic activity/);

  const result = JSON.parse(
    executeSideChatTool(
      toolCall("read_workspace_item", { item_id: "local:1" }),
      knowledgeBase
    )
  );
  assert.match(result.content, /A163V increased catalytic activity/);

  const unsupported = JSON.parse(
    executeSideChatTool(
      toolCall("read_workspace_item", { item_id: "local:2" }),
      knowledgeBase
    )
  );
  assert.match(unsupported.error, /catalog entry proves only that it exists/i);
});

test("a large workspace keeps a compact catalog while tools retain the full index", () => {
  const inventory = Array.from({ length: 500 }, (_, index) => ({
    name: `${String(index + 1).padStart(3, "0")}-${"long-name-".repeat(20)}.pdf`,
    relativePath: `literature/${String(index + 1).padStart(3, "0")}-${"nested-name-".repeat(20)}.pdf`,
    extension: "pdf",
    size: 1000 + index,
    processor: "pdf",
    summaryAvailable: false,
    summaryStatus: "unprocessed"
  }));
  const knowledgeBase = createSideChatKnowledgeBase({
    localWorkspaceContext: { inventory, files: [], project: {} }
  });
  const catalog = buildSideChatCatalog(knowledgeBase);
  assert.ok(catalog.length < 65000);
  assert.match(catalog, /additional item\(s\) omitted/);

  const listed = JSON.parse(
    executeSideChatTool(
      toolCall("list_workspace_items", {
        category: "reference",
        path_prefix: "literature/500-",
        limit: 5
      }),
      knowledgeBase
    )
  );
  assert.equal(listed.total_matches, 1);
  assert.match(listed.items[0].path, /^literature\/500-/);
});

test("the pre-tool hook blocks action tools even when the model invents one", () => {
  const knowledgeBase = createSideChatKnowledgeBase(makeWorkspaceContext());
  const result = executeSideChatTool(
    toolCall("write_file", {
      path: "experiments/result.txt",
      content: "mutate the project"
    }),
    knowledgeBase
  );
  assert.match(result, /^Blocked:/);
  assert.match(result, /not a Side Chat read-only tool/);
});

test("the agent loop keeps inspection private and returns only the final answer", async () => {
  const requests = [];
  const turns = [
    {
      ok: true,
      message: {
        content: null,
        tool_calls: [
          toolCall("search_workspace_items", {
            query: "A163V catalytic activity",
            category: "reference"
          })
        ]
      }
    },
    {
      ok: true,
      message: {
        content: "Paper A reports that A163V increased catalytic activity."
      }
    }
  ];
  const result = await runSideChatAgent({
    conversationMessages: [
      { role: "user", content: "What does the A163V reference report?" }
    ],
    workspaceContext: makeWorkspaceContext(),
    systemPrompt: "Answer questions only. Never act.",
    parseFinalAnswer: (content) =>
      typeof content === "string" && content
        ? { reply: content }
        : null,
    requestTurn: async (request) => {
      requests.push(request);
      return turns.shift();
    }
  });

  assert.deepEqual(result, {
    ok: true,
    data: {
      reply: "Paper A reports that A163V increased catalytic activity."
    }
  });
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools.length > 0);
  assert.equal(
    requests[1].messages.some(
      (message) =>
        message.role === "tool" &&
        message.name === "search_workspace_items" &&
        /A163V/.test(message.content)
    ),
    true
  );
  assert.equal(Object.hasOwn(result.data, "tool_calls"), false);
});

test("context compaction keeps the active request and complete tool pairs", () => {
  const activeRequest = "Compare the reference with the experiment.";
  const messages = [
    { role: "system", content: "answer-only" },
    { role: "user", content: `old question ${"x".repeat(5000)}` },
    { role: "assistant", content: `old answer ${"y".repeat(5000)}` },
    { role: "user", content: activeRequest },
    {
      role: "assistant",
      content: null,
      tool_calls: [toolCall("read_workspace_item", { item_id: "local:1" })]
    },
    {
      role: "tool",
      tool_call_id: "tool-1",
      name: "read_workspace_item",
      content: "evidence ".repeat(3000)
    }
  ];
  const compacted = compactSideChatAgentMessages(
    messages,
    activeRequest,
    5000
  );
  assert.equal(
    compacted.some(
      (message) =>
        message.role === "user" && message.content === activeRequest
    ),
    true
  );
  const assistantToolIds = new Set(
    compacted
      .flatMap((message) => message.tool_calls || [])
      .map((call) => call.id)
  );
  const resultToolIds = new Set(
    compacted
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id)
  );
  assert.deepEqual(resultToolIds, assistantToolIds);
  assert.ok(compacted.at(-1).content.length < messages.at(-1).content.length);
});

test("a provider context rejection gets one compacted retry", async () => {
  const requests = [];
  const activeRequest = "What does the selected reference conclude?";
  const result = await runSideChatAgent({
    conversationMessages: [
      { role: "user", content: `Earlier question ${"x".repeat(8000)}` },
      { role: "assistant", content: `Earlier answer ${"y".repeat(8000)}` },
      { role: "user", content: activeRequest }
    ],
    workspaceContext: makeWorkspaceContext(),
    systemPrompt: "Answer questions only. Never act.",
    parseFinalAnswer: (content) =>
      typeof content === "string" && content
        ? { reply: content }
        : null,
    requestTurn: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ok: false,
          error: "LlmHttpError",
          reason: "context_length_exceeded"
        };
      }
      return {
        ok: true,
        message: { content: "The compacted retry succeeded." }
      };
    }
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(result, {
    ok: true,
    data: { reply: "The compacted retry succeeded." }
  });
  assert.equal(
    requests[1].messages.some(
      (message) =>
        message.role === "user" && message.content === activeRequest
    ),
    true
  );
});
