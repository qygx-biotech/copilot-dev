import { assertOnlyKeys, ValidationError } from "../ipc/validation.mjs";

const SETTINGS_PATH = ".biodesign/runtime/workbench-settings.json";
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
function preset(input) {
  assertOnlyKeys(input, ["id", "name", "modelId"], "preset");
  if (typeof input.id !== "string" || !ID.test(input.id) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80
    || typeof input.modelId !== "string" || !input.modelId.trim() || input.modelId.length > 256 || /[\s\x00-\x1f\x7f]/.test(input.modelId)) {
    throw new ValidationError("INVALID_MODEL_PRESET", "A preset needs an ID, a name, and an existing Requesty model ID.");
  }
  return { id: input.id, name: input.name.trim(), modelId: input.modelId };
}

/** Profiles only choose a Requesty model. They cannot change providers, secrets,
 * permissions, source scope, or any existing account-level routing settings. */
export class WorkbenchSettings {
  constructor(filesystem) { this.filesystem = filesystem; this.pending = Promise.resolve(); }

  async read() {
    if (!(await this.filesystem.exists(SETTINGS_PATH))) return { version: 1, presets: [] };
    try {
      if ((await this.filesystem.stat(SETTINGS_PATH)).size > 32 * 1024) throw new Error("oversized");
      const value = JSON.parse(await this.filesystem.readText(SETTINGS_PATH));
      assertOnlyKeys(value, ["version", "presets"], "settings");
      if (value.version !== 1 || !Array.isArray(value.presets) || value.presets.length > 32) throw new Error("invalid");
      const presets = value.presets.map(preset);
      if (new Set(presets.map(item => item.id)).size !== presets.length) throw new Error("duplicate");
      return { version: 1, presets };
    } catch { throw new ValidationError("INVALID_WORKBENCH_SETTINGS", "The project workbench settings are invalid."); }
  }

  mutate(operation) { const result = this.pending.then(operation); this.pending = result.catch(() => {}); return result; }
  save(input) {
    const next = preset(input);
    return this.mutate(async () => {
      const value = await this.read(), index = value.presets.findIndex(item => item.id === next.id);
      if (index < 0) {
        if (value.presets.length >= 32) throw new ValidationError("MODEL_PRESET_LIMIT", "At most 32 presets can be saved per project.");
        value.presets.push(next);
      } else value.presets[index] = next;
      await this.filesystem.writeText(SETTINGS_PATH, JSON.stringify(value, null, 2));
      return value;
    });
  }
  remove(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new ValidationError("INVALID_MODEL_PRESET", "Invalid preset ID.");
    return this.mutate(async () => {
      const value = await this.read();
      value.presets = value.presets.filter(item => item.id !== id);
      await this.filesystem.writeText(SETTINGS_PATH, JSON.stringify(value, null, 2));
      return value;
    });
  }
}
