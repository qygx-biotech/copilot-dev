import { ValidationError } from "../ipc/validation.mjs";

export class LocalExecutionService {
  constructor() {
    this.workflows = new Map();
  }

  register(definition, runner) {
    if (!definition?.id || typeof runner !== "function") throw new TypeError("A structured workflow definition and runner are required.");
    this.workflows.set(definition.id, { definition: Object.freeze({ ...definition }), runner });
  }

  list() {
    return [...this.workflows.values()].map(({ definition }) => ({ ...definition }));
  }

  async run(id, input, context) {
    const workflow = this.workflows.get(id);
    if (!workflow) throw new ValidationError("WORKFLOW_NOT_ALLOWED", "The requested local workflow is not registered.");
    return workflow.runner(input, context);
  }
}
