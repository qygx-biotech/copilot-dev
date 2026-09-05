(function exposeExperimentSemantics(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BioDesignExperimentSemantics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function experimentSemanticsFactory() {
  "use strict";

  const MAPPING_SCHEMA_VERSION = 1;
  const FIELD_REGISTRY_VERSION = 1;
  const SCHEMA_MAPPING_PATH = ".biodesign/experiments/schema-mappings.json";
  const REMOTE_MAPPING_CONFIDENCE = 0.9;
  const FIELD_REGISTRY = Object.freeze(Object.fromEntries([
    ["temperature", "Temperature", "温度", "number", "degC", ["temp", "temp.", "culture temperature", "assay temperature", "培养温度", "反应温度", "测定温度"]],
    ["ph", "pH", "pH", "number", null, ["酸碱度"]],
    ["culture_time", "Culture time", "培养时间", "number", "h", ["culture duration", "fermentation time", "培养时长", "发酵时间"]],
    ["hydroxyectoine_titer", "Hydroxyectoine titer", "羟基依克多因滴度", "number", "g/L", ["hydroxyectoine concentration", "hydroxyectoine titre", "羟基依克多因浓度"]],
    ["hydroxyectoine_yield", "Hydroxyectoine yield", "羟基依克多因得率", "number", "g/g", ["羟基依克多因收率"]],
    ["titer", "Titer", "滴度", "number", "g/L", ["titre", "concentration", "浓度"]],
    ["yield", "Yield", "得率", "number", "g/g", ["收率"]],
    ["productivity", "Productivity", "生产强度", "number", "g/L/h", ["volumetric productivity", "生产速率", "体积生产强度"]],
    ["enzyme_activity", "Enzyme activity", "酶活性", "number", "U", ["酶活", "total activity"]],
    ["specific_activity", "Specific activity", "比活性", "number", "U/mg", ["比酶活", "比活力"]],
    ["relative_activity", "Relative activity", "相对活性", "number", "%", ["相对酶活"]],
    ["od600", "OD600", "OD600", "number", null, ["od 600", "od_600", "光密度600"]],
    ["mutation", "Mutation", "突变体", "string", null, ["variant", "mutant", "mutations", "突变", "变体"]],
    ["strain", "Strain", "菌株", "string", null, ["host", "宿主", "菌株编号"]],
    ["protein", "Protein", "蛋白", "string", null, ["enzyme", "蛋白质", "酶"]],
    ["gene", "Gene", "基因", "string", null, []],
    ["experiment_id", "Experiment ID", "实验编号", "string", null, ["sample id", "sample", "样品编号", "样本编号"]],
    ["measurement_unit", "Unit", "单位", "string", null, ["units"]],
  ].map(([canonicalField, en, zh, dataType, canonicalUnit, aliases]) => [canonicalField, Object.freeze({
    canonicalField, labels: Object.freeze({ en, zh }), dataType, canonicalUnit,
    aliases: Object.freeze([...new Set([canonicalField, en, zh, ...aliases])]),
  })])));
  const ENTITY_REGISTRY = Object.freeze({
    hydroxyectoine: ["hydroxyectoine", "hydroxy-ectoine", "5-hydroxyectoine", "羟基依克多因"],
    ectoine: ["ectoine", "依克多因"],
    EctD: ["EctD", "ectD", "ectoine hydroxylase", "依克多因羟化酶"],
    WT: ["WT", "wild type", "wild-type", "wildtype", "野生型"],
  });
  const normalizeText = (value) => String(value ?? "").normalize("NFKC").toLowerCase().trim().replace(/[_\s.]+/g, " ");
  const unique = (values) => [...new Set(values)];

  function normalizeEntity(value) {
    if (typeof value !== "string") return value;
    if (/^(?:EctD|ectD|kcat|Km|OD600|[A-Z]\d{1,6}[A-Z*]|BL21(?:\(DE3\))?)$/.test(value)) return value;
    const token = normalizeText(value);
    for (const [canonical, aliases] of Object.entries(ENTITY_REGISTRY)) {
      if (aliases.some((alias) => normalizeText(alias) === token)) return canonical;
    }
    // Exact identifiers (A163V, BL21(DE3), gene IDs) keep their original spelling.
    return value;
  }

  function normalizeUnit(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const token = raw.normalize("NFKC").replace(/−/g, "-").replace(/μ|µ/g, "u")
      .replace(/毫克\s*\/\s*升/g, "mg/L").replace(/克\s*\/\s*升/g, "g/L")
      .replace(/摄氏度/g, "degC").replace(/小时/g, "h").replace(/分钟/g, "min")
      .replace(/\s*L\s*\^?-1/gi, "/L").replace(/\s*h\s*\^?-1/gi, "/h")
      .replace(/\s*g\s*\^?-1/gi, "/g").replace(/\s+/g, "").toLowerCase();
    const unit = (normalizedUnit, dimension, factor = 1, offset = 0) => ({ rawUnit: raw, normalizedUnit, dimension, factor, offset });
    if (["°c", "c", "degc", "℃"].includes(token)) return unit("degC", "temperature");
    if (["°f", "degf", "f"].includes(token)) return unit("degC", "temperature", 5 / 9, -32 * 5 / 9);
    if (["k", "kelvin"].includes(token)) return unit("degC", "temperature", 1, -273.15);
    if (["h", "hr", "hrs", "hour", "hours"].includes(token)) return unit("h", "time");
    if (["min", "mins", "minute", "minutes"].includes(token)) return unit("h", "time", 1 / 60);
    if (["s", "sec", "seconds"].includes(token)) return unit("h", "time", 1 / 3600);
    if (["%", "percent"].includes(token)) return unit("%", "relative_activity");
    if (token === "u") return unit("U", "enzyme_activity");
    if (token === "u/mg") return unit("U/mg", "specific_activity");
    if (token === "u/g") return unit("U/mg", "specific_activity", 1 / 1000);
    const concentration = token.match(/^(g|mg|ug)\/(l|ml)(?:\/(h|min))?$/);
    if (concentration) {
      const factor = ({ g: 1, mg: 0.001, ug: 0.000001 })[concentration[1]] *
        (concentration[2] === "ml" ? 1000 : 1) * (concentration[3] === "min" ? 60 : 1);
      return unit(concentration[3] ? "g/L/h" : "g/L", concentration[3] ? "productivity" : "titer", factor);
    }
    const massYield = token.match(/^(g|mg)\/g(.*)$/);
    if (massYield) {
      const substrate = massYield[2].replace(/^[-_]/, "");
      return unit(`g/g${substrate ? ` ${substrate}` : ""}`, "yield", massYield[1] === "mg" ? 0.001 : 1);
    }
    return { rawUnit: raw, normalizedUnit: raw, dimension: "unknown", factor: null, offset: 0 };
  }

  function headerParts(rawHeader) {
    const text = String(rawHeader ?? "").normalize("NFKC").trim();
    const suffix = text.match(/\(([^()]*)\)\s*$|\[([^\[\]]*)\]\s*$/);
    if (suffix) {
      const candidate = normalizeUnit(suffix[1] || suffix[2]);
      return { label: text.slice(0, suffix.index).trim(), unit: candidate };
    }
    return { label: text, unit: null };
  }

  function fieldCandidates(value) {
    const label = normalizeText(headerParts(value).label);
    if (Object.hasOwn(FIELD_REGISTRY, String(value))) return [String(value)];
    return Object.values(FIELD_REGISTRY).filter((field) =>
      field.aliases.some((alias) => normalizeText(alias) === label)
    ).map((field) => field.canonicalField);
  }

  function normalizeField(value) {
    const candidates = fieldCandidates(value);
    return candidates.length === 1 ? candidates[0] : null;
  }

  function stableSignature(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let index = 0; index < text.length; index += 1) {
      a = Math.imul(a ^ text.charCodeAt(index), 16777619) >>> 0;
      b = Math.imul(b ^ text.charCodeAt(index), 2246822519) >>> 0;
    }
    return `schema-v${MAPPING_SCHEMA_VERSION}:${a.toString(16)}${b.toString(16)}:${text.length}`;
  }

  function compatibleUnit(canonicalField, unit) {
    if (!unit) return true;
    const expected = normalizeUnit(FIELD_REGISTRY[canonicalField]?.canonicalUnit);
    return expected ? unit.dimension === expected.dimension : unit.dimension === "unknown";
  }

  function resolveColumn(rawHeader, context = {}) {
    const parts = headerParts(rawHeader);
    const unit = parts.unit || normalizeUnit(context.unit);
    const label = normalizeText(parts.label);
    const exact = fieldCandidates(parts.label);
    let candidates = exact;
    let method = Object.hasOwn(FIELD_REGISTRY, parts.label) ? "canonical-id" : "field-alias";
    const product = /hydroxy.?ectoine|羟基依克多因/i.test(`${parts.label} ${context.productContext || ""}`);
    const amount = /^(?:产量|产率|production|amount|产物量|product concentration|hydroxy.?ectoine (?:production|amount)|羟基依克多因产量)$/i.test(parts.label);
    if (!exact.length && amount) {
      candidates = [product ? "hydroxyectoine_titer" : "titer", product ? "hydroxyectoine_yield" : "yield", "productivity"];
      method = "unit-context";
    }
    if (!exact.length && /^(?:activity|活性|活力)$/i.test(label)) {
      candidates = ["enzyme_activity", "specific_activity", "relative_activity"];
      method = "unit-context";
    }
    // Explicit metric names and dimensions must agree; a yield in g/L is not guessed to be titer.
    const viable = candidates.filter((field) => compatibleUnit(field, unit));
    const canonicalField = viable.length === 1 && (exact.length || unit) ? viable[0] : null;
    return {
      rawHeader: String(rawHeader ?? ""), sourceLanguage: /[\u3400-\u9fff]/u.test(String(rawHeader)) ? "zh" : "en",
      canonicalField, candidateFields: canonicalField ? [] : candidates,
      dataType: canonicalField ? FIELD_REGISTRY[canonicalField].dataType : null,
      canonicalUnit: canonicalField ? FIELD_REGISTRY[canonicalField].canonicalUnit : null,
      unit: unit?.rawUnit || null, normalizedUnit: unit?.normalizedUnit || null,
      confidence: canonicalField ? (method === "unit-context" ? 0.96 : 1) : 0,
      status: canonicalField ? "confirmed" : "unresolved", method: canonicalField ? method : "unresolved",
    };
  }

  function valueType(value) {
    if (value === null || value === undefined || value === "") return "empty";
    if (typeof value === "number" || (typeof value === "string" && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim()))) return "number";
    return typeof value === "boolean" ? "boolean" : "string";
  }

  function buildSheetSchema(source, sheet, options = {}) {
    const headers = Array.from(sheet.rows?.[0] || [], (value) => String(value ?? ""));
    const ontologyLabels = unique((options.ontologyLabels || []).filter((value) => typeof value === "string").slice(0, 30));
    const productContext = unique([sheet.name, ...headers, ...ontologyLabels]
      .filter((value) => /hydroxy.?ectoine|羟基依克多因/i.test(value))).join(" ");
    const context = { version: MAPPING_SCHEMA_VERSION, registryVersion: FIELD_REGISTRY_VERSION, sourceId: source.sourceId, sheet: sheet.name, headers, ontologyLabels, module: String(options.module || "") };
    const schemaSignature = stableSignature(context);
    const columns = headers.map((rawHeader, index) => {
      const examples = (sheet.rows || []).slice(1, 4).map((row) => row[index]).filter((value) => value !== "" && value != null);
      const valueTypes = unique((sheet.rows || []).slice(1, 21).map((row) => valueType(row[index]))).sort();
      const nextIsUnit = /^(?:unit|units|单位)$/i.test(headers[index + 1] || "");
      const units = nextIsUnit ? unique((sheet.rows || []).slice(1).map((row) => String(row[index + 1] ?? "").trim()).filter(Boolean)) : [];
      const unit = units.length === 1 ? units[0] : null;
      const dimensions = unique(units.map((value) => normalizeUnit(value)?.dimension));
      const inferenceUnit = unit || (dimensions.length === 1 && dimensions[0] !== "unknown" ? units[0] : null);
      const mapping = resolveColumn(rawHeader, { unit: inferenceUnit, productContext });
      if (units.length > 1 && !headerParts(rawHeader).unit) { mapping.unit = null; mapping.normalizedUnit = null; }
      const identity = JSON.stringify({
        version: MAPPING_SCHEMA_VERSION, registryVersion: FIELD_REGISTRY_VERSION, sourceId: source.sourceId, sheet: sheet.name,
        rawHeader, occurrence: headers.slice(0, index).filter((header) => header === rawHeader).length,
        unit: mapping.unit, units, neighbors: headers.slice(Math.max(0, index - 2), index + 3),
        valueTypes, productContext, ontologyLabels, module: context.module,
      });
      return { ...mapping, columnId: `c${index + 1}`, columnIndex: index, sourceId: source.sourceId, sheet: sheet.name,
        schemaSignature, sourceContentHash: source.contentHash || null, mappingKey: stableSignature(identity), contextIdentity: identity,
        valueTypes, examples: examples.map((value) => String(value).slice(0, 80)),
        unitColumnIndex: nextIsUnit ? index + 1 : null,
      };
    });
    return { version: MAPPING_SCHEMA_VERSION, schemaSignature, sourceId: source.sourceId, sheet: sheet.name, columns };
  }

  function normalizeCell(rawValue, mapping, row) {
    const field = FIELD_REGISTRY[mapping.canonicalField];
    const unit = normalizeUnit(mapping.unit || (mapping.unitColumnIndex != null ? row?.[mapping.unitColumnIndex] : null));
    let normalizedValue = rawValue;
    if (field?.dataType === "number") {
      normalizedValue = valueType(rawValue) === "number" ? Number(rawValue) : null;
      if (normalizedValue !== null && unit?.factor != null && compatibleUnit(mapping.canonicalField, unit)) {
        normalizedValue = normalizedValue * unit.factor + unit.offset;
      } else if (unit && (!compatibleUnit(mapping.canonicalField, unit) || unit.factor == null)) normalizedValue = null;
    } else if (field) normalizedValue = normalizeEntity(rawValue);
    return {
      columnId: mapping.columnId, rawHeader: mapping.rawHeader, rawValue,
      canonicalField: mapping.canonicalField, normalizedValue, sourceId: mapping.sourceId, sheet: mapping.sheet,
      unit: unit?.rawUnit || null, normalizedUnit: unit?.normalizedUnit || null,
      status: mapping.status, confidence: mapping.confidence,
    };
  }

  class SchemaMappingService {
    constructor(options = {}) {
      this.workspace = options.workspace;
      this.schemaMapper = options.schemaMapper || null;
      this.cache = null;
      this.dirty = false;
      this.loading = null;
      this.inFlight = new Map();
      this.failedTurns = new Set();
      this.writeQueue = Promise.resolve();
      this.metrics = { schemaMapperCalls: 0, cacheHits: 0, fallbackCount: 0 };
    }

    async load() {
      if (this.cache) return this.cache;
      if (this.loading) return this.loading;
      this.loading = (async () => {
        let data = null;
        try { if (await this.workspace?.fileExists(SCHEMA_MAPPING_PATH)) data = await this.workspace.readJson(SCHEMA_MAPPING_PATH); } catch { /* rebuild derived metadata */ }
        this.cache = data?.version === MAPPING_SCHEMA_VERSION && data.registryVersion === FIELD_REGISTRY_VERSION && data.mappings && typeof data.mappings === "object" && !Array.isArray(data.mappings)
          ? data : { version: MAPPING_SCHEMA_VERSION, registryVersion: FIELD_REGISTRY_VERSION, mappings: {} };
        return this.cache;
      })();
      try { return await this.loading; } finally { this.loading = null; }
    }

    async persist() {
      if (!this.workspace?.writeJson || !this.dirty) return this.writeQueue;
      const snapshot = JSON.parse(JSON.stringify(this.cache));
      this.dirty = false;
      this.writeQueue = this.writeQueue.catch(() => {}).then(() => this.workspace.writeJson(SCHEMA_MAPPING_PATH, snapshot))
        .catch((error) => { this.dirty = true; throw error; });
      return this.writeQueue;
    }

    applyCached(column) {
      const item = this.cache.mappings[column.mappingKey];
      if (!item || item.contextIdentity !== column.contextIdentity || item.version !== MAPPING_SCHEMA_VERSION ||
        !["confirmed", "unresolved"].includes(item.status) ||
        !["canonical-id", "field-alias", "unit-context", "user-confirmed", "fc-schema-mapper", "unresolved"].includes(item.method) ||
        !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) return column;
      if (item.status === "confirmed" && (!FIELD_REGISTRY[item.canonicalField] ||
        !compatibleUnit(item.canonicalField, normalizeUnit(column.unit)) ||
        (item.method === "fc-schema-mapper" && item.confidence < REMOTE_MAPPING_CONFIDENCE))) return column;
      this.metrics.cacheHits += 1;
      return { ...column, canonicalField: item.canonicalField || null, status: item.status,
        confidence: item.confidence, method: item.method, cacheHit: true,
        dataType: FIELD_REGISTRY[item.canonicalField]?.dataType || null,
        canonicalUnit: FIELD_REGISTRY[item.canonicalField]?.canonicalUnit || null,
        candidateFields: item.canonicalField ? [] : column.candidateFields };
    }

    remember(column) {
      const next = {
        version: MAPPING_SCHEMA_VERSION, registryVersion: FIELD_REGISTRY_VERSION, contextIdentity: column.contextIdentity,
        schemaSignature: column.schemaSignature, sourceId: column.sourceId, sheet: column.sheet,
        rawHeader: column.rawHeader, canonicalField: column.canonicalField,
        unit: column.unit, sourceContentHash: column.sourceContentHash, status: column.status, method: column.method,
        confidence: column.confidence,
      };
      const { updatedAt, ...previous } = this.cache.mappings[column.mappingKey] || {};
      if (JSON.stringify(next) === JSON.stringify(previous)) return;
      this.cache.mappings[column.mappingKey] = { ...next, updatedAt: new Date().toISOString() };
      this.dirty = true;
    }

    async normalize(source, sheets, options = {}) {
      await this.load();
      const schemas = [];
      for (const sheet of sheets) {
        const schema = buildSheetSchema(source, sheet, options);
        schema.columns = schema.columns.map((column) => this.applyCached(column));
        const pending = schema.columns.filter((column) => column.status === "unresolved" && !(column.cacheHit && column.method === "fc-schema-mapper"));
        if (["medium", "high"].includes(options.profile) && this.schemaMapper && pending.length) {
          // One bounded schema call per sheet. Remaining columns keep honest unresolved status.
          const bounded = pending.slice(0, 40);
          const payload = {
            version: MAPPING_SCHEMA_VERSION, schemaSignature: schema.schemaSignature,
            sheet: String(sheet.name || "").slice(0, 120),
            columns: bounded.map(({ columnId, rawHeader, unit, valueTypes, examples, candidateFields }) =>
              ({ columnId, rawHeader: rawHeader.slice(0, 200), unit: unit?.slice(0, 80) || null, valueTypes, examples, candidateFields })),
            ontology: Object.values(FIELD_REGISTRY).map(({ canonicalField, labels, canonicalUnit, dataType }) =>
              ({ canonicalField, labels, canonicalUnit, dataType })),
          };
          const key = JSON.stringify(bounded.map((column) => column.contextIdentity));
          const turnKey = options.callContext?.turnId ? `${options.callContext.turnId}:${key}` : null;
          try {
            if (turnKey && this.failedTurns.has(turnKey)) throw new Error("Schema mapper already failed for this turn");
            let call = this.inFlight.get(key);
            if (!call) {
              this.metrics.schemaMapperCalls += 1;
              // A consumer's cancellation must not cancel another consumer's shared schema work.
              call = Promise.resolve().then(() => this.schemaMapper(payload, { callContext: options.callContext })).finally(() => this.inFlight.delete(key));
              this.inFlight.set(key, call);
            }
            const result = await call;
            if (result?.version !== MAPPING_SCHEMA_VERSION || !Array.isArray(result.mappings) || result.mappings.length > bounded.length) throw new Error("Invalid schema mapping response");
            const seen = new Set();
            const accepted = [];
            for (const item of result.mappings) {
              const column = bounded.find((candidate) => candidate.columnId === item?.columnId);
              if (!column || seen.has(item.columnId) || typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1 ||
                (item.canonicalField !== null && !FIELD_REGISTRY[item.canonicalField])) throw new Error("Invalid schema mapping entry");
              seen.add(item.columnId);
              const allowed = item.canonicalField && compatibleUnit(item.canonicalField, normalizeUnit(column.unit)) &&
                (!column.candidateFields.length || column.candidateFields.includes(item.canonicalField));
              const canonicalField = allowed && item.confidence >= REMOTE_MAPPING_CONFIDENCE ? item.canonicalField : null;
              accepted.push({ ...column, canonicalField, confidence: item.confidence, method: "fc-schema-mapper",
                status: canonicalField ? "confirmed" : "unresolved", candidateFields: canonicalField ? [] : column.candidateFields,
                dataType: FIELD_REGISTRY[canonicalField]?.dataType || null, canonicalUnit: FIELD_REGISTRY[canonicalField]?.canonicalUnit || null });
            }
            schema.columns = schema.columns.map((column) => accepted.find((item) => item.columnId === column.columnId) ||
              (bounded.includes(column) ? { ...column, method: "fc-schema-mapper" } : column));
          } catch {
            this.metrics.fallbackCount += 1;
            if (turnKey) {
              this.failedTurns.add(turnKey);
              while (this.failedTurns.size > 200) this.failedTurns.delete(this.failedTurns.values().next().value);
            }
          }
        }
        for (const column of schema.columns) {
          this.remember(column);
        }
        schemas.push(schema);
      }
      await this.persist();
      return schemas;
    }

    async confirmMapping(source, sheet, columnId, canonicalField, options = {}) {
      await this.load();
      const schema = buildSheetSchema(source, sheet, options);
      const column = schema.columns.find((item) => item.columnId === columnId);
      if (!column || !FIELD_REGISTRY[canonicalField] || !compatibleUnit(canonicalField, normalizeUnit(column.unit))) {
        throw new Error("The confirmed field must exist and have a compatible unit.");
      }
      const confirmed = { ...column, canonicalField, confidence: 1, status: "confirmed", method: "user-confirmed" };
      this.remember(confirmed);
      await this.persist();
      return confirmed;
    }
  }

  return { MAPPING_SCHEMA_VERSION, FIELD_REGISTRY_VERSION, SCHEMA_MAPPING_PATH, REMOTE_MAPPING_CONFIDENCE, FIELD_REGISTRY,
    ENTITY_REGISTRY, normalizeEntity, normalizeUnit, normalizeField, resolveColumn, buildSheetSchema,
    normalizeCell, compatibleUnit, SchemaMappingService, valueType };
});
