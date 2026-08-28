const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AGENT_TOOL_EFFECTS,
  SIDE_CHAT_TOOL_DEFINITIONS,
  ToolEffect,
  authorizeTool,
  buildDurableProjectSystemMessage,
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

test("the backend loop exposes internal-state tools with centralized effects", () => {
  const names = SIDE_CHAT_TOOL_DEFINITIONS.map((tool) => tool.function.name);
  assert.deepEqual(names, [
    "list_workspace_items",
    "search_workspace_items",
    "read_workspace_item",
    "read_project_context",
    "list_papers",
    "search_papers",
    "read_paper_evidence",
    "list_experiment_sources",
    "query_experiment_results",
    "get_corpus_workflow_status",
    "source_coverage",
    "update_project_memory",
    "get_local_worker_status",
    "restart_local_worker",
    "update_recommendation"
  ]);
  assert.equal(AGENT_TOOL_EFFECTS.update_project_memory, ToolEffect.INTERNAL_STATE);
  assert.equal(AGENT_TOOL_EFFECTS.restart_local_worker, ToolEffect.INTERNAL_STATE);
  assert.equal(AGENT_TOOL_EFFECTS.update_recommendation, ToolEffect.RESULT_PRODUCING);
  assert.equal(authorizeTool("side_chat", "update_project_memory").allowed, true);
  assert.equal(authorizeTool("side_chat", "update_recommendation").allowed, false);
  assert.equal(authorizeTool("agent_command", "update_recommendation").allowed, true);
});

test("durable project context becomes system guidance without duplicating the goal", () => {
  const goal =
    "Over several weeks, identify the best-supported EctD variant for the final design review.";
  const message = buildDurableProjectSystemMessage({
    projectContext: goal,
    localWorkspaceContext: {
      project: {
        goal,
        projectSummary: "This summary remains ordinary saved project memory."
      }
    }
  });

  assert.match(message, /Long-term project context and final goal/);
  assert.match(message, new RegExp(goal));
  assert.equal(message.split(goal).length - 1, 1);
  assert.match(message, /every answer or recommendation/);
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

test("source-specific tools enforce explicit paper and experiment scopes", () => {
  const localWorkspaceContext = {
    sourceMap: {
      selectedPaperIds: ["paper-a"],
      selectedExperimentIds: ["experiment-a"]
    },
    inventory: [
      {
        paperId: "paper-a",
        sourceId: "paper-a",
        name: "a.pdf",
        relativePath: "literature/a.pdf",
        processor: "pdf"
      },
      {
        paperId: "paper-b",
        sourceId: "paper-b",
        name: "b.pdf",
        relativePath: "literature/b.pdf",
        processor: "pdf"
      },
      {
        sourceId: "experiment-a",
        sourceKind: "experiment",
        name: "a.csv",
        relativePath: "experiments/a.csv",
        processor: "experiment"
      },
      {
        sourceId: "experiment-b",
        sourceKind: "experiment",
        name: "b.csv",
        relativePath: "experiments/b.csv",
        processor: "experiment"
      }
    ],
    files: [
      {
        paperId: "paper-a",
        sourceId: "paper-a",
        name: "a.pdf",
        relativePath: "literature/a.pdf",
        analysisStatus: "processed",
        content: "selected paper evidence"
      },
      {
        paperId: "paper-b",
        sourceId: "paper-b",
        name: "b.pdf",
        relativePath: "literature/b.pdf",
        analysisStatus: "processed",
        content: "outside-only-marker evidence"
      },
      {
        sourceId: "experiment-a",
        name: "a.csv",
        relativePath: "experiments/a.csv",
        analysisStatus: "processed",
        content: "selected experiment value 4.8"
      },
      {
        sourceId: "experiment-b",
        name: "b.csv",
        relativePath: "experiments/b.csv",
        analysisStatus: "processed",
        content: "unselected experiment value 9.9"
      }
    ]
  };
  const knowledgeBase = createSideChatKnowledgeBase({ localWorkspaceContext });

  const papers = JSON.parse(
    executeSideChatTool(toolCall("list_papers", {}), knowledgeBase)
  );
  assert.deepEqual(papers.items.map((item) => item.path), ["literature/a.pdf"]);
  const outsidePaper = JSON.parse(
    executeSideChatTool(
      toolCall("search_papers", { query: "outside-only-marker" }),
      knowledgeBase
    )
  );
  assert.equal(outsidePaper.returned, 0);

  const experiments = JSON.parse(
    executeSideChatTool(toolCall("list_experiment_sources", {}), knowledgeBase)
  );
  assert.deepEqual(experiments.items.map((item) => item.path), ["experiments/a.csv"]);
  const outsideExperiment = JSON.parse(
    executeSideChatTool(
      toolCall("query_experiment_results", { query: "9.9" }),
      knowledgeBase
    )
  );
  assert.equal(outsideExperiment.returned, 0);
});

test("corpus failure status reports map diagnostics without inventing a preparation cause", async () => {
  const workspaceContext = {
    localWorkspaceContext: {
      corpusWorkflowStatus: {
        workflowId: "workflow-32",
        papersTotal: 32,
        papersPrepared: 32,
        papersAnalyzed: 30,
        failures: [
          {
            paperId: "P31",
            filename: "paper-31.pdf",
            stage: "map",
            code: "InvalidLlmResponse",
            message: "The corpus mapper did not return valid structured JSON.",
            sourceReady: true,
            retryable: true
          },
          {
            paperId: "P32",
            filename: "paper-32.pdf",
            stage: "map",
            code: "InvalidLlmResponse",
            message: "The corpus mapper did not return valid structured JSON.",
            sourceReady: true,
            retryable: true
          }
        ]
      }
    }
  };
  const knowledgeBase = createSideChatKnowledgeBase(workspaceContext);
  const inspected = JSON.parse(
    executeSideChatTool(
      toolCall("get_corpus_workflow_status", { workflow_id: "workflow-32" }),
      knowledgeBase
    )
  );
  assert.equal(inspected.papersPrepared, 32);
  assert.equal(inspected.papersAnalyzed, 30);
  assert.ok(inspected.failures.every((failure) => failure.stage === "map"));
  assert.ok(inspected.failures.every((failure) => failure.sourceReady === true));

  const turns = [
    {
      ok: true,
      message: {
        content: null,
        tool_calls: [toolCall("get_corpus_workflow_status", {})]
      }
    },
    {
      ok: true,
      message: {
        content:
          "Both papers were prepared successfully. Their map-stage LLM outputs failed structured JSON validation; the sources remain ready and retryable."
      }
    }
  ];
  const result = await runSideChatAgent({
    conversationMessages: [{ role: "user", content: "Why did two papers fail?" }],
    workspaceContext,
    systemPrompt:
      "Use get_corpus_workflow_status before explaining corpus failures. Never infer a cause from counts.",
    parseFinalAnswer: (content) => ({ reply: content }),
    requestTurn: async () => turns.shift()
  });
  assert.match(result.data.reply, /map-stage LLM outputs failed structured JSON validation/i);
  assert.doesNotMatch(result.data.reply, /OCR|scanned|parsing/i);
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
  const blocked = JSON.parse(result);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /not registered/i);

  const recommendation = JSON.parse(
    executeSideChatTool(
      toolCall("update_recommendation", { proposed_change: "R2" }),
      knowledgeBase
    )
  );
  assert.equal(recommendation.allowed, false);
  assert.equal(recommendation.effect, "result_producing");
  assert.equal(recommendation.required_surface, "agent_command");
});

test("Side Chat can discuss a recommendation change but receives a structured commit denial", async () => {
  const requests = [];
  const turns = [
    {
      ok: true,
      message: {
        content: null,
        tool_calls: [
          toolCall("update_recommendation", { proposed_change: "Use candidate R2." })
        ]
      }
    },
    {
      ok: true,
      message: {
        content:
          "I can explain the proposed change, but Side Chat did not commit it. Use Agent Command to update the Current Recommendation."
      }
    }
  ];
  const result = await runSideChatAgent({
    surface: "side_chat",
    conversationMessages: [
      { role: "user", content: "Based on this, update our current recommendation." }
    ],
    workspaceContext: makeWorkspaceContext(),
    systemPrompt: "Discuss proposed changes, but obey tool authorization.",
    parseFinalAnswer: (content) => ({ reply: content }),
    requestTurn: async (request) => {
      requests.push(request);
      return turns.shift();
    }
  });

  const denial = JSON.parse(
    requests[1].messages.find((message) => message.role === "tool").content
  );
  assert.equal(denial.allowed, false);
  assert.equal(denial.effect, "result_producing");
  assert.equal(denial.required_surface, "agent_command");
  assert.match(result.data.reply, /did not commit/i);
});

test("Agent Command retains authorization for its existing recommendation commit path", async () => {
  const requests = [];
  const turns = [
    {
      ok: true,
      message: {
        content: null,
        tool_calls: [
          toolCall("update_recommendation", { proposed_change: "Use candidate R2." })
        ]
      }
    },
    {
      ok: true,
      message: { content: "Structured Agent Command recommendation response." }
    }
  ];
  await runSideChatAgent({
    surface: "agent_command",
    conversationMessages: [
      { role: "user", content: "Commit the reviewed recommendation." }
    ],
    workspaceContext: makeWorkspaceContext(),
    systemPrompt: "Return the existing Agent Command response.",
    parseFinalAnswer: (content) => ({ reply: content }),
    requestTurn: async (request) => {
      requests.push(request);
      return turns.shift();
    }
  });

  const outcome = JSON.parse(
    requests[1].messages.find((message) => message.role === "tool").content
  );
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.effect, "result_producing");
  assert.equal(outcome.disposition, "host_managed");
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
  assert.equal(requests[0].messages[1].role, "system");
  assert.match(requests[0].messages[1].content, /Understand EctD variants/);
  assert.match(requests[0].messages[2].content, /workspace catalog/i);
  assert.equal(requests[0].messages[3].role, "user");
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
