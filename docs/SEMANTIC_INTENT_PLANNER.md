# Semantic intent through Requesty

`POST /api/semantic/interpret` uses one planner and one canonical
`SemanticIntentIR`, with Requesty Chat Completions accessed through the current
Alibaba FC backend. Search, downloading, retrieval depth, permissions, tool
execution and knowledge ingestion remain downstream responsibilities.

The additive `retrievalScope` field now separates workspace retrieval, web
discovery, both, and no retrieval. See [Retrieval scope](RETRIEVAL_SCOPE.md) for
routing, compatibility and the current deployment package. New model output
must supply this field; only older stored/client IRs receive the legacy default.

## Internal validation and the wire schema

The canonical contract is `shared/semantic-intent.js` (`SEMANTIC_IR_SCHEMA` and
`validateSemanticIR`), copied into the FC package by `sync:shared`. It is a
handwritten JavaScript schema/validator; this path has no Zod conversion.

Previously, the endpoint transmitted that internal schema directly. The observed
Gemini rejection occurred before inference, with zero tokens and a generic
`INVALID_ARGUMENT`. Schema compatibility is the leading explanation, but that
error alone does not prove which field was rejected. [Gemini documents a JSON
Schema subset and complexity limits](https://ai.google.dev/gemini-api/docs/structured-output).

`alibaba-fc/semantic-intent-planner.js` now defines an explicit
`SEMANTIC_INTENT_LLM_SCHEMA`. It retains every IR field and meaning, closes every
object, requires every property and uses nullable types for nullable scalar
fields. Length, range and collection bounds remain in internal validation.
Small `anyOf` unions remain only where the existing scope and scalar-or-list
value types require them. There are no references, defaults, examples or
provider-specific keywords.

Both output modes require strict JSON parsing followed by the existing validator
and private-material check. Unknown fields, invalid bounds, missing protected
scientific identifiers and out-of-scope source IDs fail validation. No IR repair
or fabricated success is returned. The existing explicit `local-semantic`
failure response is preserved. The separate experiment schema mapper is unchanged.

## Request and bounded fallback

The request retains the existing Requesty metadata, role, model selection and
transport retry handling. Its relevant shape is:

```js
{
  model: "google/gemini-3.1-flash-lite:flex",
  messages: [
    { role: "system", content: commonSemanticInstructions + formatInstruction },
    { role: "user", content: JSON.stringify(semanticInput) }
  ],
  temperature: 0,
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "semantic_intent_ir",
      strict: true,
      schema: SEMANTIC_INTENT_LLM_SCHEMA
    }
  }
}
```

The input is encoded once inside the text content. Serializing the containing
HTTP body is separate and necessary. The canonical semantic prompt is shared
across providers; language affects answer language, not profile or retrieval
depth. An explicit source download is represented by the existing `store`
operation and `download_sources` capability hint, without granting permission.

If the profile supports strict JSON Schema, it is attempted first. One logical
retry with `response_format: {type: "json_object"}` is allowed only when:

- The response is HTTP 400 or 422, with an output-schema-specific error code,
  a field targeting `response_format`/`response_schema`, or a message explicitly
  rejecting structured output or its schema.
- There is no authentication, permission, configuration, rate-limit or context
  limit signal, and no field indicating malformed application input.
- The same selected model advertises JSON-object support.

A bare `Request contains an invalid argument.`, or a generic input-schema
validation failure, does **not** qualify. Network errors and HTTP 5xx keep the
existing bounded transport retries in the same format. HTTP 429 keeps the
existing semantic endpoint failure behavior; it does not cause a format retry.
Malformed successful output never triggers a repair or format retry.

The fallback uses the same model, input and semantic instructions, adds the wire
schema to the prompt, and explicitly forbids Markdown, code fences and prose.
Failure of that attempt stops the mode fallback. Logical format attempts and
transport attempts are distinct; the returned `attempts` sums transport attempts.

## Profiles and future OpenAI selection

`requesty-models.js` extends the existing capability registry with planner
profiles. With no profile setting, the existing role/default model selection is
preserved. Explicit non-default UI selections retain precedence over a profile.
Selecting **Default** allows the configured planner profile to apply.

For Gemini testing:

```text
REQUESTY_SEMANTIC_PLANNER_PROFILE=gemini
# Optional override of the confirmed default model:
REQUESTY_SEMANTIC_GEMINI_MODEL=google/gemini-3.1-flash-lite:flex
```

For a future approved OpenAI model:

```text
REQUESTY_SEMANTIC_PLANNER_PROFILE=openai
REQUESTY_SEMANTIC_OPENAI_MODEL=<approved Requesty OpenAI model ID>
```

The OpenAI profile has no default model and makes no provider call until
configured. Profiles supply strict-schema and JSON-object capabilities; explicit
per-model `REQUESTY_MODEL_CAPABILITIES_JSON` entries (`jsonSchema`, `jsonObject`)
override them. For existing role selection without a profile, known Gemini
capabilities or existing configuration apply. Other role models can explicitly
declare JSON-object support with the per-model entry or
`REQUESTY_MODEL_SUPPORTS_JSON_OBJECT`. A JSON-object-only model uses that mode
directly and still requires canonical validation.

The planner accepts an injected request adapter returning text/status/attempts;
FC currently supplies the existing Chat Completions wrapper. Future transport
serialization changes can be made there without duplicating the planner, IR or
downstream routing. No Responses API migration is implemented.

## Diagnostics and verification

Events are `semantic-intent.request`, `semantic-intent.success`,
`semantic-intent.structured-output-fallback`, `semantic-intent.validation-failed`
and `semantic-intent.request-failed`. They include model, provider, output mode,
fallback flag, elapsed milliseconds, available turn/operation IDs and safe
status/code fields. Raw provider errors are reduced to a compatibility flag and
allowlisted code; prompts, user input and credentials are not logged. Success
logs also report `retrievalScope`, `patternShortcutCleared` and
`objectAliasesNormalized`. These describe the shared model-output normalization:
paper/article aliases become `literature`, and an incompatible optional pattern
becomes null without changing operations or retrieval scope. The full canonical
validator still runs afterward; invalid fields, identifiers or hard scopes are
never repaired. Success responses include the actual output mode and
`structuredOutputFallback` flag.
The configuration signature includes both schemas, capabilities, profile and
prompt version to separate incompatible cached configurations.

`alibaba-fc/test/semantic-intent-planner.test.js` drives the real FC handler with
mocked Requesty responses. It covers equivalent Chinese/English intents, exact
wire serialization, strict success, controlled fallback, no fallback on unrelated
failures, canonical validation, profile switching and safe logs. It writes the
actual captured mock request body to
`path.join(os.tmpdir(), "biodesign-semantic-requesty-gemini.json")`, without headers
or credentials, for payload inspection. This verifies application behavior, not
live provider acceptance. A generic live rejection may still require more
specific Requesty/provider diagnostics.

Deploy `semantic-intent-planner.js` alongside `index.js`, `requesty-models.js` and
the usual runtime files/shared contracts. `Archive-routing-citations.zip`
includes the current fixes for the existing FC application. No new endpoint, region,
storage system or service is introduced.
