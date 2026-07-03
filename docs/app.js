const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const messageHistory = document.querySelector("#messageHistory");
const promptButtons = document.querySelectorAll(".prompt-button");
const exportButton = document.querySelector("#exportButton");
const referenceFileInput = document.querySelector("#referenceFileInput");
const referenceFileList = document.querySelector("#referenceFileList");
const clearReferencesButton = document.querySelector("#clearReferencesButton");

const MAX_REFERENCE_FILES = 3;
const MAX_REFERENCE_FILE_SIZE = 5 * 1024 * 1024;
const PER_FILE_TEXT_LIMIT = 12000;
const TOTAL_REFERENCE_TEXT_LIMIT = 24000;
const SPREADSHEET_SHEET_LIMIT = 4;
const PDF_PAGE_LIMIT = 10;
const SUPPORTED_REFERENCE_EXTENSIONS = new Set([
  "pdf",
  "txt",
  "csv",
  "xlsx",
  "xls",
]);

const BACKEND_PROVIDER = "alibaba"; // "cloudflare" or "alibaba"
const CLOUDFLARE_WORKER_URL = "https://biodesign-copilot-worker.zhangjatsh666.workers.dev";
const ALIBABA_FC_URL = "https://biodesi-api-dev-jvvowibabk.cn-beijing.fcapp.run";
const WORKER_URL = BACKEND_PROVIDER === "alibaba" ? ALIBABA_FC_URL : CLOUDFLARE_WORKER_URL;
const USE_BACKEND = true;

console.log("BACKEND_PROVIDER:", BACKEND_PROVIDER);
console.log("WORKER_URL:", WORKER_URL);
console.log("USE_BACKEND:", USE_BACKEND);

const panelSummary = document.querySelector("#panelSummary");
const panelOrganism = document.querySelector("#panelOrganism");
const panelMissingInfo = document.querySelector("#panelMissingInfo");
const panelSafetyLevel = document.querySelector("#panelSafetyLevel");
const panelSafetyNotes = document.querySelector("#panelSafetyNotes");
const panelMemo = document.querySelector("#panelMemo");

let currentProject = createProjectState(
  "开始对话后将生成简洁的项目摘要。"
);
const chatMessages = [];
let referenceDocuments = [];

promptButtons.forEach((button) => {
  button.addEventListener("click", () => {
    chatInput.value = button.textContent.trim().replace(/\s+/g, " ");
    chatInput.focus();
  });
});

referenceFileInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);

  for (const file of files) {
    if (referenceDocuments.length >= MAX_REFERENCE_FILES) {
      showToast("最多只能添加 3 个参考文件。");
      break;
    }

    try {
      const parsedReference = await parseReferenceFile(file);
      referenceDocuments.push(parsedReference);
      renderReferenceFiles();
      showToast(`已添加参考文件：${file.name}`);
    } catch (error) {
      console.warn("Reference file parsing failed.", error);
      showToast(error.message || `无法解析文件：${file.name}`);
    }
  }

  referenceFileInput.value = "";
});

clearReferencesButton.addEventListener("click", () => {
  referenceDocuments = [];
  renderReferenceFiles();
  showToast("已清空参考文件。");
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const userMessage = chatInput.value.trim();
  if (!userMessage) return;

  addMessage("user", userMessage);
  chatMessages.push({ role: "user", content: userMessage });
  const referencesForRequest = buildReferenceDocumentsForRequest();
  if (referencesForRequest.length) {
    addReferenceNote(referencesForRequest);
  }
  chatInput.value = "";

  if (!USE_BACKEND) {
    currentProject = createProjectState(userMessage);
    addMessage("assistant", buildAssistantResponse(currentProject), true);
    updateProjectPanel(currentProject);
    return;
  }

  try {
    const backendResponse = await sendMessageToBackend(
      chatMessages,
      referencesForRequest
    );
    currentProject = normalizeBackendProject(backendResponse.project);
    chatMessages.push({ role: "assistant", content: backendResponse.reply });
    addMessage("assistant", formatBackendReply(backendResponse.reply), true);
    updateProjectPanel(currentProject);
  } catch (error) {
    console.warn("Backend chat failed; using local mock response.", error);
    addMessage(
      "assistant",
      "暂时无法连接后端，因此我先生成了一份本地演示回复。你仍然可以继续探索这个项目概念。"
    );

    currentProject = createProjectState(userMessage);
    addMessage("assistant", buildAssistantResponse(currentProject), true);
    updateProjectPanel(currentProject);
  }
});

exportButton.addEventListener("click", () => {
  const markdown = buildMarkdownExport(currentProject);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "biodesign-copilot-project-memo.md";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Markdown 备忘录已导出");
});

async function parseReferenceFile(file) {
  const extension = getFileExtension(file.name);

  if (!SUPPORTED_REFERENCE_EXTENSIONS.has(extension)) {
    throw new Error(`不支持的文件类型：${file.name}`);
  }

  if (file.size > MAX_REFERENCE_FILE_SIZE) {
    throw new Error(`文件超过 5 MB 限制：${file.name}`);
  }

  let extractedText = "";

  if (extension === "txt" || extension === "csv") {
    extractedText = await readFileAsText(file);
  } else if (extension === "xlsx" || extension === "xls") {
    extractedText = await extractSpreadsheetText(file);
  } else if (extension === "pdf") {
    extractedText = await extractPdfText(file);
  }

  const normalizedText = normalizeExtractedText(extractedText);

  if (!normalizedText) {
    throw new Error(`未能从文件中提取文本：${file.name}`);
  }

  const truncatedText = normalizedText.slice(0, PER_FILE_TEXT_LIMIT);

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    filename: file.name,
    type: file.type || getMimeTypeFromExtension(extension),
    extension,
    text: truncatedText,
    originalCharacterCount: normalizedText.length,
    extractedCharacterCount: truncatedText.length,
    truncated: normalizedText.length > PER_FILE_TEXT_LIMIT,
  };
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`));
    reader.readAsText(file);
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

async function extractSpreadsheetText(file) {
  if (!window.XLSX) {
    throw new Error("Excel 解析库未加载，暂时无法解析该文件。");
  }

  const arrayBuffer = await readFileAsArrayBuffer(file);
  const workbook = window.XLSX.read(arrayBuffer, {
    type: "array",
    cellDates: true,
  });

  return workbook.SheetNames.slice(0, SPREADSHEET_SHEET_LIMIT)
    .map((sheetName) => {
      const worksheet = workbook.Sheets[sheetName];
      const csv = window.XLSX.utils.sheet_to_csv(worksheet, {
        blankrows: false,
      });

      return `# Sheet: ${sheetName}\n${csv}`;
    })
    .join("\n\n")
    .slice(0, PER_FILE_TEXT_LIMIT);
}

async function extractPdfText(file) {
  if (!window.pdfjsLib) {
    throw new Error("PDF 解析库未加载，暂时无法解析该文件。");
  }

  if (window.pdfjsLib.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pageCount = Math.min(pdf.numPages, PDF_PAGE_LIMIT);
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => item.str)
      .filter(Boolean)
      .join(" ");

    pageTexts.push(`# Page ${pageNumber}\n${pageText}`);
  }

  return pageTexts.join("\n\n").slice(0, PER_FILE_TEXT_LIMIT);
}

function buildReferenceDocumentsForRequest() {
  let remainingCharacters = TOTAL_REFERENCE_TEXT_LIMIT;

  return referenceDocuments.slice(0, MAX_REFERENCE_FILES).map((document) => {
    const textForRequest = document.text.slice(0, remainingCharacters);
    remainingCharacters = Math.max(0, remainingCharacters - textForRequest.length);

    return {
      filename: document.filename,
      type: document.type,
      text: textForRequest,
      truncated:
        document.truncated || textForRequest.length < document.text.length,
      originalCharacterCount: document.originalCharacterCount,
      sentCharacterCount: textForRequest.length,
    };
  }).filter((document) => document.text);
}

function renderReferenceFiles() {
  referenceFileList.innerHTML = "";

  referenceDocuments.forEach((reference) => {
    const card = document.createElement("div");
    card.className = "reference-file-card";

    const details = document.createElement("div");
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = reference.filename;

    const meta = document.createElement("div");
    meta.className = "file-meta";
    meta.textContent = `${reference.extension.toUpperCase()} · ${reference.extractedCharacterCount.toLocaleString()} 字符${
      reference.truncated ? " · 已截断" : ""
    }`;

    const removeButton = document.createElement("button");
    removeButton.className = "file-remove-button";
    removeButton.type = "button";
    removeButton.textContent = "移除";
    removeButton.addEventListener("click", () => {
      referenceDocuments = referenceDocuments.filter(
        (item) => item.id !== reference.id
      );
      renderReferenceFiles();
    });

    details.append(name, meta);
    card.append(details, removeButton);
    referenceFileList.appendChild(card);
  });
}

function addReferenceNote(references) {
  const note = document.createElement("div");
  note.className = "reference-note";
  note.textContent = `正在使用 ${references.length} 个参考文件：${references
    .map((reference) => reference.filename)
    .join("、")}`;

  messageHistory.appendChild(note);
  messageHistory.scrollTop = messageHistory.scrollHeight;
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getFileExtension(filename) {
  return filename.split(".").pop().toLowerCase();
}

function getMimeTypeFromExtension(extension) {
  const mimeTypes = {
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
  };

  return mimeTypes[extension] || "application/octet-stream";
}

function createProjectState(prompt) {
  const lowerPrompt = prompt.toLowerCase();
  const isInitial = prompt.startsWith("开始对话");
  const organism = detectOrganism(lowerPrompt);
  const projectType = detectProjectType(lowerPrompt);

  const summary = isInitial
    ? prompt
    : `这是一个概念阶段的${projectType}项目，拟采用${organism}作为工作系统。当前目标是明确教学或演示场景，梳理设计假设，并形成一份安全、可评审的团队讨论备忘录。`;

  const missingInfo = isInitial
    ? [
        "目标生物体或底盘系统",
        "项目目标",
        "预期场景和受众",
      ]
    : [
        "具体教学场景和监督模式",
        "已获批准的宿主菌株或非活体演示系统",
        "演示结果的成功标准",
        "机构评审和废弃物处理要求",
      ];

  const safetyNotes = isInitial
    ? "生成评审后，这里会显示安全说明。"
    : "请将项目定位为低风险教育概念。仅使用非致病、已获批准的系统；避免任何环境释放；在任何实验活动前记录封闭措施、培训要求、废弃物处理和机构评审路径。";

  return {
    title: "BioDesign Copilot 项目备忘录",
    originalPrompt: isInitial ? "" : prompt,
    summary,
    organism,
    projectType,
    assumptions: [
      "该项目用于教育、演示或早期规划。",
      "任何湿实验工作都只会在获批准且有监督的环境中进行。",
      "团队将使用表征清楚、非致病的生物系统。",
    ],
    questions: [
      "该演示的目标受众是谁？",
      "场地、监督和材料方面有哪些限制？",
      "哪些证据可以让利益相关方认为项目是成功的？",
    ],
    considerations: [
      "在实施前先把项目定义在概念和设计评审层面。",
      "将学习目标与实验执行细节区分开。",
      "使用便于向非专业投资人解释的可衡量结果。",
    ],
    missingInfo,
    safetyLevel: isInitial ? "待评审" : "仅限概念评审；倾向于低风险教育场景",
    safetyNotes,
    nextSteps: [
      "将概念整理成一页项目章程。",
      "确认生物体、场景、约束条件和安全负责人。",
      "与机构生物安全或教学实验室负责人评审方案。",
      "为投资人和教育者准备非技术化演示叙事。",
    ],
    memo: buildMemo(prompt, organism, projectType, isInitial),
  };
}

function detectOrganism(text) {
  if (text.includes("yeast") || text.includes("酵母")) return "酵母教学菌株";
  if (text.includes("e. coli") || text.includes("ecoli")) {
    return "非致病大肠杆菌教学菌株";
  }
  if (text.includes("大肠杆菌")) {
    return "非致病大肠杆菌教学菌株";
  }
  if (
    text.includes("biosensor") ||
    text.includes("lactose") ||
    text.includes("生物传感器") ||
    text.includes("乳糖")
  ) {
    return "生物传感器概念系统";
  }
  return "待选择";
}

function detectProjectType(text) {
  if (text.includes("gfp") || text.includes("fluorescence") || text.includes("荧光")) {
    return "荧光报告";
  }
  if (text.includes("pigment") || text.includes("color") || text.includes("色素")) {
    return "颜色输出教学";
  }
  if (text.includes("biosensor") || text.includes("detect") || text.includes("检测") || text.includes("生物传感器")) {
    return "生物传感器";
  }
  return "合成生物学教育";
}

function buildMemo(prompt, organism, projectType, isInitial) {
  if (isInitial) {
    return "暂无备忘录。发送提示词后将生成草稿。";
  }

  return `BioDesign Copilot 备忘录草稿

项目概念：${prompt}

该概念提出了一个使用${organism}的${projectType}项目。近期目标是让想法更易评估：项目要传达什么学习目标，正在考虑哪类生物系统，哪些假设需要验证，以及在任何实验活动前需要完成哪些安全评审。

面向投资人演示时，应强调 BioDesign Copilot 是合成生物学团队的规划层：它能把粗略想法转化为结构化备忘录，标出缺失信息，并在工作流早期呈现安全与合规考虑。

建议决策：在团队确认预期场景、监督模式、获批材料、废弃物处理要求和机构评审路径之前，将该项目保持在概念评审阶段。`;
}

function buildAssistantResponse(project) {
  return `
    <h4>项目摘要</h4>
    <p>${escapeHtml(project.summary)}</p>

    <h4>关键假设</h4>
    ${toList(project.assumptions)}

    <h4>澄清问题</h4>
    ${toList(project.questions)}

    <h4>设计考虑</h4>
    ${toList(project.considerations)}

    <h4>安全与合规说明</h4>
    <p>${escapeHtml(project.safetyNotes)}</p>

    <h4>建议下一步</h4>
    ${toList(project.nextSteps)}

    <h4>备忘录草稿</h4>
    <p>${escapeHtml(project.memo).replace(/\n/g, "<br>")}</p>
  `;
}

async function sendMessageToBackend(messages, references = []) {
  const requestBody = { messages };

  if (references.length) {
    requestBody.referenceDocuments = references;
  }

  const response = await fetch(`${WORKER_URL}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new Error(`Worker returned ${response.status}`);
  }

  const data = await response.json();

  if (!data.reply || !data.project) {
    throw new Error("后端响应缺少 reply 或 project 数据。");
  }

  return data;
}

function normalizeBackendProject(project) {
  return {
    title: "BioDesign Copilot 项目备忘录",
    summary: project.summary || "后端未返回项目摘要。",
    organism: project.organism || "未指定",
    missingInfo: Array.isArray(project.missingInformation)
      ? project.missingInformation
      : [],
    safetyLevel: project.safetyLevel || "待评审",
    safetyNotes: project.safetyNotes || "后端未返回安全说明。",
    memo: project.draftMemo || "后端未返回备忘录草稿。",
  };
}

function formatBackendReply(reply) {
  const headingMap = new Map([
    ["Project Summary", "项目摘要"],
    ["Key Assumptions", "关键假设"],
    ["Clarifying Questions", "澄清问题"],
    ["Design Considerations", "设计考虑"],
    ["Safety & Compliance Notes", "安全与合规说明"],
    ["Recommended Next Steps", "建议下一步"],
    ["Draft Memo", "备忘录草稿"],
    ["项目摘要", "项目摘要"],
    ["关键假设", "关键假设"],
    ["澄清问题", "澄清问题"],
    ["设计考虑", "设计考虑"],
    ["安全与合规说明", "安全与合规说明"],
    ["建议下一步", "建议下一步"],
    ["备忘录草稿", "备忘录草稿"],
  ]);

  const lines = reply
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let html = "";
  let listOpen = false;

  lines.forEach((line) => {
    if (headingMap.has(line)) {
      if (listOpen) {
        html += "</ul>";
        listOpen = false;
      }
      html += `<h4>${escapeHtml(headingMap.get(line))}</h4>`;
      return;
    }

    if (line.startsWith("- ")) {
      if (!listOpen) {
        html += "<ul>";
        listOpen = true;
      }
      html += `<li>${escapeHtml(line.slice(2))}</li>`;
      return;
    }

    if (listOpen) {
      html += "</ul>";
      listOpen = false;
    }
    html += `<p>${escapeHtml(line)}</p>`;
  });

  if (listOpen) {
    html += "</ul>";
  }

  return html;
}

function updateProjectPanel(project) {
  panelSummary.textContent = project.summary;
  panelOrganism.textContent = project.organism;
  panelSafetyLevel.textContent = project.safetyLevel;
  panelSafetyNotes.textContent = project.safetyNotes;
  panelMemo.textContent = project.memo;

  panelMissingInfo.innerHTML = "";
  project.missingInfo.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    panelMissingInfo.appendChild(li);
  });
}

function addMessage(role, content, isHtml = false) {
  const message = document.createElement("article");
  message.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "你" : "BC";

  const card = document.createElement("div");
  card.className = "message-card";
  if (isHtml) {
    card.innerHTML = content;
  } else {
    const paragraph = document.createElement("p");
    paragraph.textContent = content;
    card.appendChild(paragraph);
  }

  message.append(avatar, card);
  messageHistory.appendChild(message);
  messageHistory.scrollTop = messageHistory.scrollHeight;
}

function buildMarkdownExport(project) {
  return `# ${project.title}

## 项目摘要
${project.summary}

## 生物体 / 系统
${project.organism}

## 缺失信息
${project.missingInfo.map((item) => `- ${item}`).join("\n")}

## 安全等级
${project.safetyLevel}

## 安全说明
${project.safetyNotes}

## 备忘录草稿
${project.memo}
`;
}

function toList(items) {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 2200);
}
