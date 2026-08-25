(function exposeWorkspaceManager(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function workspaceFactory() {
  "use strict";

  const WORKSPACE_SCHEMA_VERSION = 1;
  const MANAGED_DIRECTORIES = [
    "literature",
    "experiments/strain-engineering",
    "experiments/fermentation",
    "experiments/downstream-processing",
    "data",
    ".biodesign/literature/summaries",
    ".biodesign/literature/cache",
    ".biodesign/experiments",
    ".biodesign/chat",
    ".biodesign/chat/conversations",
    ".biodesign/cache",
  ];

  class WorkspaceError extends Error {
    constructor(code, message, cause = null) {
      super(message, cause ? { cause } : undefined);
      this.name = "WorkspaceError";
      this.code = code;
      if (cause && !this.cause) this.cause = cause;
    }
  }

  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  const FORBIDDEN_SECRET_KEYS = new Set([
    "password",
    "passwords",
    "authtoken",
    "accesstoken",
    "refreshtoken",
    "apikey",
    "secret",
    "credentials",
    "accesskeyid",
    "accesskeysecret",
    "securitytoken",
    "jwt",
  ]);

  function containsForbiddenSecretKey(value) {
    if (Array.isArray(value)) return value.some(containsForbiddenSecretKey);
    if (!isPlainObject(value)) return false;
    return Object.entries(value).some(
      ([key, child]) =>
        FORBIDDEN_SECRET_KEYS.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase()) ||
        containsForbiddenSecretKey(child)
    );
  }

  function assertWorkspaceMetadata(value) {
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
      typeof value.workspaceId !== "string" ||
      !value.workspaceId ||
      typeof value.name !== "string" ||
      !value.name ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw new WorkspaceError(
        "INVALID_WORKSPACE",
        "workspace.json does not match the supported BioDesign workspace schema."
      );
    }
    return value;
  }

  function assertWorkspaceState(value) {
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
      !isPlainObject(value.project) ||
      typeof value.project.goal !== "string" ||
      !isPlainObject(value.ui) ||
      !isPlainObject(value.agent) ||
      !isPlainObject(value.memory) ||
      typeof value.updatedAt !== "string" ||
      containsForbiddenSecretKey(value)
    ) {
      throw new WorkspaceError(
        "INVALID_STATE",
        "state.json does not match the supported BioDesign project-state schema."
      );
    }
    return value;
  }

  function assertLiteratureIndex(value) {
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
      !Array.isArray(value.documents) ||
      typeof value.updatedAt !== "string"
    ) {
      throw new WorkspaceError(
        "INVALID_LITERATURE_INDEX",
        "The literature index does not match the supported schema."
      );
    }

    for (const document of value.documents) {
      const discovery = document?.discovery;
      const validDiscovery =
        discovery === undefined ||
        (isPlainObject(discovery) &&
          typeof discovery.fileName === "string" &&
          discovery.fileName &&
          (discovery.title === null || typeof discovery.title === "string") &&
          Array.isArray(discovery.authors) &&
          discovery.authors.every((item) => typeof item === "string") &&
          (discovery.year === null || Number.isInteger(discovery.year)) &&
          Array.isArray(discovery.topics) &&
          discovery.topics.every((item) => typeof item === "string") &&
          Array.isArray(discovery.keywords) &&
          discovery.keywords.every((item) => typeof item === "string") &&
          Array.isArray(discovery.identifiers) &&
          discovery.identifiers.every((item) => typeof item === "string") &&
          typeof discovery.shortDescription === "string");
      if (
        !isPlainObject(document) ||
        typeof document.id !== "string" ||
        !document.id ||
        typeof document.relativePath !== "string" ||
        !document.relativePath ||
        document.relativePath.startsWith(".biodesign/") ||
        typeof document.filename !== "string" ||
        !document.filename ||
        !Number.isFinite(Number(document.size)) ||
        !Number.isFinite(Number(document.lastModified)) ||
        typeof document.summaryPath !== "string" ||
        !document.summaryPath.startsWith(".biodesign/literature/summaries/") ||
        (document.sourceHash !== undefined &&
          (typeof document.sourceHash !== "string" || !document.sourceHash)) ||
        (document.paperCardStatus !== undefined &&
          !["pending", "ready", "failed"].includes(document.paperCardStatus)) ||
        (document.paperCardError !== undefined &&
          typeof document.paperCardError !== "string") ||
        (document.paperCardVersion !== undefined &&
          ![0, 1].includes(Number(document.paperCardVersion))) ||
        (document.paperCardPath !== undefined &&
          (typeof document.paperCardPath !== "string" ||
            !document.paperCardPath.startsWith(".biodesign/literature/summaries/"))) ||
        (document.isLiteraturePaper !== undefined &&
          typeof document.isLiteraturePaper !== "boolean") ||
        !validDiscovery
      ) {
        throw new WorkspaceError(
          "INVALID_LITERATURE_INDEX",
          "The literature index contains an invalid document record."
        );
      }
    }
    return value;
  }

  function assertLiteratureSummary(value) {
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
      typeof value.documentId !== "string" ||
      !value.documentId ||
      (value.paperId !== undefined && value.paperId !== value.documentId) ||
      typeof value.generatedAt !== "string" ||
      !isPlainObject(value.source) ||
      typeof value.source.filename !== "string" ||
      typeof value.summary !== "string" ||
      !Array.isArray(value.keyResults) ||
      !Array.isArray(value.limitations) ||
      !Array.isArray(value.keywords)
    ) {
      throw new WorkspaceError(
        "INVALID_LITERATURE_SUMMARY",
        "The literature summary does not match the supported schema."
      );
    }
    if (value.paperCardVersion !== undefined) {
      const stringLists = [
        "authors",
        "mainFindings",
        "methods",
        "organisms",
        "genes",
        "proteins",
        "pathways",
        "metabolites",
        "experimentalConditions",
        "measurements",
        "importantResults",
        "topics",
      ];
      const validStringLists = stringLists.every(
        (key) =>
          Array.isArray(value[key]) &&
          value[key].every((item) => typeof item === "string")
      );
      if (
        value.paperCardVersion !== 1 ||
        value.paperId !== value.documentId ||
        typeof value.fileName !== "string" ||
        !value.fileName ||
        typeof value.source.hash !== "string" ||
        !value.source.hash ||
        typeof value.source.relativePath !== "string" ||
        typeof value.shortSummary !== "string" ||
        (value.year !== null && !Number.isInteger(value.year)) ||
        !validStringLists
      ) {
        throw new WorkspaceError(
          "INVALID_LITERATURE_SUMMARY",
          "The Paper Card does not match the supported schema."
        );
      }
    }
    return value;
  }

  function assertChatIndex(value) {
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
      typeof value.activeConversationId !== "string" ||
      !Array.isArray(value.conversations) ||
      typeof value.updatedAt !== "string" ||
      containsForbiddenSecretKey(value)
    ) {
      throw new WorkspaceError(
        "INVALID_CHAT_INDEX",
        "The Side Chat index does not match the supported schema."
      );
    }

    for (const conversation of value.conversations) {
      if (
        !isPlainObject(conversation) ||
        typeof conversation.id !== "string" ||
        !conversation.id ||
        typeof conversation.title !== "string" ||
        typeof conversation.createdAt !== "string" ||
        typeof conversation.updatedAt !== "string" ||
        !Number.isFinite(Number(conversation.messageCount))
      ) {
        throw new WorkspaceError(
          "INVALID_CHAT_INDEX",
          "The Side Chat index contains an invalid conversation record."
        );
      }
    }
    return value;
  }

  function assertChatConversation(value) {
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
      typeof value.id !== "string" ||
      !value.id ||
      typeof value.title !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string" ||
      typeof value.summary !== "string" ||
      !Array.isArray(value.messages) ||
      containsForbiddenSecretKey(value)
    ) {
      throw new WorkspaceError(
        "INVALID_CHAT_CONVERSATION",
        "The Side Chat conversation does not match the supported schema."
      );
    }

    for (const message of value.messages) {
      const validPaperIds = (ids) =>
        ids === undefined ||
        (Array.isArray(ids) && ids.every((id) => typeof id === "string" && id));
      const validContext =
        message?.context === undefined ||
        (isPlainObject(message.context) &&
          (message.context.type === "project" || message.context.type === "files") &&
          Array.isArray(message.context.files) &&
          message.context.files.every((path) => typeof path === "string") &&
          validPaperIds(message.context.selectedPaperIds) &&
          validPaperIds(message.context.relevantPaperIds));
      if (
        !isPlainObject(message) ||
        typeof message.id !== "string" ||
        !message.id ||
        (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string" ||
        !message.content.trim() ||
        typeof message.createdAt !== "string" ||
        !validContext
      ) {
        throw new WorkspaceError(
          "INVALID_CHAT_CONVERSATION",
          "The Side Chat conversation contains an invalid message."
        );
      }
    }
    return value;
  }

  function validateKnownJson(path, value) {
    if (path === ".biodesign/workspace.json") return assertWorkspaceMetadata(value);
    if (path === ".biodesign/state.json") return assertWorkspaceState(value);
    if (path === ".biodesign/literature/index.json") return assertLiteratureIndex(value);
    if (/^\.biodesign\/literature\/summaries\/[^/]+\.json$/.test(path)) {
      return assertLiteratureSummary(value);
    }
    if (path === ".biodesign/chat/index.json") return assertChatIndex(value);
    if (/^\.biodesign\/chat\/conversations\/[^/]+\.json$/.test(path)) {
      return assertChatConversation(value);
    }
    if (!isPlainObject(value) && !Array.isArray(value)) {
      throw new WorkspaceError("INVALID_JSON_DATA", "Workspace JSON must be an object or array.");
    }
    if (containsForbiddenSecretKey(value)) {
      throw new WorkspaceError(
        "FORBIDDEN_SECRET_DATA",
        "Workspace JSON cannot contain passwords, tokens, API keys, or credentials."
      );
    }
    return value;
  }

  function splitPath(path) {
    const value = String(path || "").trim();
    if (!value || value.startsWith("/") || value.includes("\\")) {
      throw new WorkspaceError("INVALID_PATH", "Workspace paths must be relative POSIX-style paths.");
    }
    const segments = value.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new WorkspaceError("INVALID_PATH", "Workspace paths cannot contain empty, dot, or parent segments.");
    }
    return segments;
  }

  function isNotFoundError(error) {
    return error?.name === "NotFoundError" || error?.code === "ENOENT";
  }

  class WorkspaceManager {
    constructor(options = {}) {
      this.directoryPicker =
        options.directoryPicker ||
        (typeof globalThis.showDirectoryPicker === "function"
          ? globalThis.showDirectoryPicker.bind(globalThis)
          : null);
      this.cryptoProvider = options.cryptoProvider || globalThis.crypto;
      this.secureContext =
        typeof options.secureContext === "boolean"
          ? options.secureContext
          : typeof globalThis.isSecureContext === "boolean"
            ? globalThis.isSecureContext
            : true;
      this.now = options.now || (() => new Date());
      this.rootHandle = null;
      this.workspace = null;
      this.state = null;
    }

    isSupported() {
      return this.secureContext && typeof this.directoryPicker === "function";
    }

    createId() {
      if (typeof this.cryptoProvider?.randomUUID === "function") {
        return this.cryptoProvider.randomUUID();
      }
      const bytes = new Uint8Array(16);
      if (typeof this.cryptoProvider?.getRandomValues === "function") {
        this.cryptoProvider.getRandomValues(bytes);
      } else {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = Math.floor(Math.random() * 256);
        }
      }
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async selectWorkspace() {
      if (!this.isSupported()) {
        throw new WorkspaceError(
          "UNSUPPORTED_BROWSER",
          "Writable local folder access is unavailable. Use a compatible desktop browser such as Chrome or Edge."
        );
      }

      let handle;
      try {
        handle = await this.directoryPicker({ mode: "readwrite" });
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new WorkspaceError("PICKER_CANCELLED", "Workspace selection was cancelled.", error);
        }
        throw new WorkspaceError("PICKER_FAILED", "The workspace folder could not be selected.", error);
      }

      await this.ensurePermission(handle, "readwrite");
      this.rootHandle = handle;
      this.workspace = null;
      this.state = null;
      return {
        name: handle.name || "BioDesign Workspace",
        initialized: await this.fileExists(".biodesign/workspace.json"),
      };
    }

    async ensurePermission(handle = this.rootHandle, mode = "readwrite") {
      if (!handle) throw new WorkspaceError("NO_WORKSPACE", "Select a workspace folder first.");
      const descriptor = { mode };
      try {
        if (typeof handle.queryPermission === "function") {
          const current = await handle.queryPermission(descriptor);
          if (current === "granted") return true;
        }
        if (typeof handle.requestPermission === "function") {
          const requested = await handle.requestPermission(descriptor);
          if (requested === "granted") return true;
          throw new WorkspaceError(
            "PERMISSION_DENIED",
            "Read and write access to the selected workspace folder is required."
          );
        }
        return true;
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        throw new WorkspaceError(
          "PERMISSION_DENIED",
          "Read and write access to the selected workspace folder was denied.",
          error
        );
      }
    }

    async initializeWorkspace() {
      this.requireRoot();
      if (await this.fileExists(".biodesign/workspace.json")) {
        return this.loadWorkspace();
      }

      const managedFiles = [
        ".biodesign/state.json",
        ".biodesign/literature/index.json",
        ".biodesign/chat/index.json",
      ];
      for (const path of managedFiles) {
        if (await this.fileExists(path)) {
          throw new WorkspaceError(
            "INITIALIZATION_CONFLICT",
            `${path} already exists, but workspace.json does not. Existing files were left unchanged.`
          );
        }
      }

      for (const path of MANAGED_DIRECTORIES) await this.ensureDirectory(path);

      const timestamp = this.now().toISOString();
      const workspace = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        workspaceId: this.createId(),
        name: this.rootHandle.name || "BioDesign Workspace",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const state = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        project: { goal: "" },
        ui: {},
        agent: {},
        memory: {
          projectSummary: "",
          conversationSummary: "",
          literatureSummary: "",
          experimentalSummary: "",
        },
        updatedAt: timestamp,
      };
      const literatureIndex = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        documents: [],
        updatedAt: timestamp,
      };
      const chatIndex = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activeConversationId: "",
        conversations: [],
        updatedAt: timestamp,
      };

      // workspace.json is deliberately written last. A partially failed setup is
      // never mistaken for a complete BioDesign workspace.
      await this.writeJson(".biodesign/state.json", state);
      await this.writeJson(".biodesign/literature/index.json", literatureIndex);
      await this.writeJson(".biodesign/chat/index.json", chatIndex);
      await this.writeJson(".biodesign/workspace.json", workspace);

      this.workspace = workspace;
      this.state = state;
      return { workspace, state, initialized: true };
    }

    async loadWorkspace() {
      this.requireRoot();
      const workspace = await this.readJson(".biodesign/workspace.json");
      const state = await this.readJson(".biodesign/state.json");
      await this.readJson(".biodesign/literature/index.json");
      assertWorkspaceMetadata(workspace);
      assertWorkspaceState(state);

      // Recreate only managed directories. No unrelated file is read, changed,
      // uploaded, or removed.
      for (const path of MANAGED_DIRECTORIES) await this.ensureDirectory(path);
      if (!(await this.fileExists(".biodesign/chat/index.json"))) {
        await this.writeJson(".biodesign/chat/index.json", {
          schemaVersion: WORKSPACE_SCHEMA_VERSION,
          activeConversationId: "",
          conversations: [],
          updatedAt: this.now().toISOString(),
        });
      } else {
        await this.readJson(".biodesign/chat/index.json");
      }
      this.workspace = workspace;
      this.state = state;
      return { workspace, state, initialized: false };
    }

    async saveState(nextState) {
      const state = {
        ...nextState,
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        updatedAt: this.now().toISOString(),
      };
      assertWorkspaceState(state);
      await this.writeJson(".biodesign/state.json", state);
      this.state = state;
      return state;
    }

    async ensureDirectory(path) {
      this.requireRoot();
      let current = this.rootHandle;
      for (const segment of splitPath(path)) {
        try {
          current = await current.getDirectoryHandle(segment, { create: true });
        } catch (error) {
          throw new WorkspaceError(
            "DIRECTORY_WRITE_FAILED",
            `Could not create or open workspace directory: ${path}`,
            error
          );
        }
      }
      return current;
    }

    async getDirectory(path, create = false) {
      this.requireRoot();
      let current = this.rootHandle;
      for (const segment of splitPath(path)) {
        current = await current.getDirectoryHandle(segment, { create });
      }
      return current;
    }

    async getFileHandle(path, create = false) {
      const segments = splitPath(path);
      const filename = segments.pop();
      let directory = this.rootHandle;
      this.requireRoot();
      for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment, { create });
      }
      return directory.getFileHandle(filename, { create });
    }

    async fileExists(path) {
      try {
        await this.getFileHandle(path, false);
        return true;
      } catch (error) {
        if (isNotFoundError(error) || error instanceof TypeError) return false;
        throw new WorkspaceError("READ_FAILED", `Could not inspect workspace file: ${path}`, error);
      }
    }

    async readFile(path) {
      try {
        const handle = await this.getFileHandle(path, false);
        return await handle.getFile();
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new WorkspaceError("FILE_NOT_FOUND", `Workspace file not found: ${path}`, error);
        }
        throw new WorkspaceError("READ_FAILED", `Could not read workspace file: ${path}`, error);
      }
    }

    async readJson(path) {
      const file = await this.readFile(path);
      let value;
      try {
        value = JSON.parse(await file.text());
      } catch (error) {
        throw new WorkspaceError(
          "MALFORMED_JSON",
          `${path} contains malformed JSON. The file was preserved; repair or restore it before continuing.`,
          error
        );
      }
      return validateKnownJson(path, value);
    }

    async writeJson(path, data) {
      this.requireRoot();
      validateKnownJson(path, data);
      let serialized;
      try {
        serialized = `${JSON.stringify(data, null, 2)}\n`;
        validateKnownJson(path, JSON.parse(serialized));
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        throw new WorkspaceError("SERIALIZATION_FAILED", `Could not serialize workspace JSON: ${path}`, error);
      }

      const segments = splitPath(path);
      const filename = segments.pop();
      const parentPath = segments.join("/");
      const directory = parentPath ? await this.ensureDirectory(parentPath) : this.rootHandle;
      const temporaryName = `.${filename}.tmp-${this.createId()}`;
      let temporaryCreated = false;

      try {
        const temporaryHandle = await directory.getFileHandle(temporaryName, { create: true });
        temporaryCreated = true;
        await this.writeHandle(temporaryHandle, serialized);
        const stagedText = await (await temporaryHandle.getFile()).text();
        if (stagedText !== serialized) {
          throw new WorkspaceError("WRITE_VERIFICATION_FAILED", `Staged write verification failed: ${path}`);
        }

        const targetHandle = await directory.getFileHandle(filename, { create: true });
        await this.writeHandle(targetHandle, serialized);
        const writtenValue = JSON.parse(await (await targetHandle.getFile()).text());
        validateKnownJson(path, writtenValue);
        await directory.removeEntry(temporaryName).catch(() => {});
        return data;
      } catch (error) {
        const recoveryNote = temporaryCreated
          ? ` A staged recovery file named ${temporaryName} may remain beside it.`
          : "";
        if (error instanceof WorkspaceError) {
          error.message = `${error.message}${recoveryNote}`;
          throw error;
        }
        throw new WorkspaceError(
          "WRITE_FAILED",
          `Could not safely write workspace file: ${path}.${recoveryNote}`,
          error
        );
      }
    }

    async writeFile(path, data) {
      try {
        const handle = await this.getFileHandle(path, true);
        await this.writeHandle(handle, data);
        return await handle.getFile();
      } catch (error) {
        throw new WorkspaceError("WRITE_FAILED", `Could not write workspace file: ${path}`, error);
      }
    }

    async writeHandle(handle, data) {
      let writable;
      try {
        writable = await handle.createWritable({ keepExistingData: false });
        await writable.write(data);
        await writable.close();
      } catch (error) {
        if (writable && typeof writable.abort === "function") {
          await writable.abort().catch(() => {});
        }
        throw error;
      }
    }

    async removeFile(path) {
      const segments = splitPath(path);
      const filename = segments.pop();
      let directory = this.rootHandle;
      this.requireRoot();
      for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment, { create: false });
      }
      try {
        await directory.removeEntry(filename);
      } catch (error) {
        throw new WorkspaceError("DELETE_FAILED", `Could not remove workspace file: ${path}`, error);
      }
    }

    async listFiles(path, options = {}) {
      const directory = await this.getDirectory(path, false);
      const recursive = options.recursive === true;
      const files = [];

      const visit = async (handle, relativeSegments) => {
        for await (const [name, entry] of handle.entries()) {
          if (entry.kind === "file") {
            const file = await entry.getFile();
            files.push({
              name,
              relativePath: [path, ...relativeSegments, name].join("/"),
              size: file.size,
              lastModified: file.lastModified,
              type: file.type || "application/octet-stream",
            });
          } else if (recursive && entry.kind === "directory") {
            await visit(entry, [...relativeSegments, name]);
          }
        }
      };

      try {
        await visit(directory, []);
      } catch (error) {
        throw new WorkspaceError("SCAN_FAILED", `Could not scan workspace directory: ${path}`, error);
      }
      return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    }

    async scanWorkspace() {
      return {
        workspace: this.workspace,
        literature: await this.listFiles("literature", { recursive: true }),
      };
    }

    async scanDirectoryTree(options = {}) {
      this.requireRoot();
      const excludedNames = new Set(
        Array.isArray(options.excludeNames) ? options.excludeNames : [".biodesign"]
      );

      const visit = async (directory, parentPath = "") => {
        const children = [];
        for await (const [name, entry] of directory.entries()) {
          if (excludedNames.has(name)) continue;
          const relativePath = parentPath ? `${parentPath}/${name}` : name;
          if (entry.kind === "directory") {
            children.push({
              name,
              relativePath,
              type: "directory",
              size: null,
              lastModified: null,
              children: await visit(entry, relativePath),
            });
            continue;
          }

          const file = await entry.getFile();
          children.push({
            name,
            relativePath,
            type: "file",
            mimeType: file.type || "application/octet-stream",
            size: Number(file.size),
            lastModified: Number(file.lastModified),
            children: [],
          });
        }

        return children.sort((left, right) => {
          if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
          return left.name.localeCompare(right.name, undefined, {
            numeric: true,
            sensitivity: "base",
          });
        });
      };

      try {
        return {
          name: this.rootHandle.name || this.workspace?.name || "BioDesign Workspace",
          relativePath: "",
          type: "directory",
          size: null,
          lastModified: null,
          children: await visit(this.rootHandle),
        };
      } catch (error) {
        throw new WorkspaceError(
          "SCAN_FAILED",
          "Could not scan the selected workspace folder.",
          error
        );
      }
    }

    closeWorkspace() {
      this.rootHandle = null;
      this.workspace = null;
      this.state = null;
    }

    requireRoot() {
      if (!this.rootHandle) {
        throw new WorkspaceError("NO_WORKSPACE", "Select a workspace folder first.");
      }
    }
  }

  return {
    MANAGED_DIRECTORIES,
    WORKSPACE_SCHEMA_VERSION,
    WorkspaceError,
    WorkspaceManager,
    assertChatConversation,
    assertChatIndex,
    assertLiteratureIndex,
    assertLiteratureSummary,
    assertWorkspaceMetadata,
    assertWorkspaceState,
  };
});
