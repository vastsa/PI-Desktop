import { createModels } from "@earendil-works/pi-ai/models";
import { TYPESAFE_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/typesafe.models";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import type {
  ClassifierContext,
  ClassifierQuestion,
  JsonObject,
  JsonValue,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  DEFAULT_JEV_CLASSIFIER_BINDING,
  jevSystemOneUrl,
  type JevClassifierRuntimeConfig,
} from "@pi-desktop/shared";

const MAX_CONTEXT_BYTES = 24 * 1024;
const MAX_JSON_DEPTH = 8;
const MAX_QUESTIONS = 16;
const MAX_CRITERIA = 32;
const MAX_TEXT_LENGTH = 1_200;

const models = createModels();
models.setProvider(typesafeProvider());

const defaultJevModel = TYPESAFE_CLASSIFIER_MODELS["jev-latest"];
const MAX_REDIRECTS = 3;

function configuredJev(input: string | JevClassifierRuntimeConfig): JevClassifierRuntimeConfig {
  return typeof input === "string"
    ? { ...DEFAULT_JEV_CLASSIFIER_BINDING, apiKey: input }
    : input;
}

/** Manual redirect handling so Bearer auth never crosses the configured origin. */
function sameOriginClassifierFetch(operationUrl: string): typeof fetch {
  const allowedOrigin = new URL(operationUrl).origin;
  return async (input, init) => {
    let url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== allowedOrigin) {
      throw new Error("System One request refused: it left the configured origin");
    }
    const requestInit: RequestInit = input instanceof Request
      ? {
          method: input.method,
          headers: input.headers,
          ...(input.method !== "GET" && input.method !== "HEAD"
            ? { body: await input.clone().arrayBuffer() }
            : {}),
          signal: input.signal,
          ...init,
          redirect: "manual",
        }
      : { ...init, redirect: "manual" };
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await globalThis.fetch(url, requestInit);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) return response;
      const next = new URL(location, url);
      if (next.origin !== allowedOrigin) {
        throw new Error("System One redirect refused: it left the configured origin");
      }
      url = next.toString();
    }
    throw new Error("System One request followed too many redirects");
  };
}

const choiceQuestionSchema = Type.Object(
  {
    type: Type.Literal("choice"),
    instructions: Type.String(),
    criteria: Type.Record(Type.String(), Type.String()),
  },
  { additionalProperties: false },
);
const scoreQuestionSchema = Type.Object(
  {
    type: Type.Literal("score"),
    instructions: Type.String(),
    criteria: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
const boolQuestionSchema = Type.Object(
  {
    type: Type.Literal("bool"),
    instructions: Type.String(),
    criteria: Type.Object(
      { true: Type.String(), false: Type.String() },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
  );
}

function boundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_TEXT_LENGTH
  );
}

function parseQuestion(value: unknown): ClassifierQuestion | undefined {
  if (!isRecord(value) || !boundedText(value.instructions)) return undefined;
  if (value.type === "choice" && isRecord(value.criteria)) {
    const entries = Object.entries(value.criteria);
    if (
      entries.length < 2 ||
      entries.length > MAX_CRITERIA ||
      entries.some(([label, description]) =>
        !boundedText(label) || !boundedText(description),
      )
    ) {
      return undefined;
    }
    return {
      type: "choice",
      instructions: value.instructions,
      criteria: Object.fromEntries(entries) as Record<string, string>,
    };
  }
  if (value.type === "score" && Array.isArray(value.criteria)) {
    if (
      value.criteria.length < 2 ||
      value.criteria.length > MAX_CRITERIA ||
      value.criteria.some((criterion) => !boundedText(criterion))
    ) {
      return undefined;
    }
    return {
      type: "score",
      instructions: value.instructions,
      criteria: value.criteria as string[],
    };
  }
  if (
    value.type === "bool" &&
    isRecord(value.criteria) &&
    boundedText(value.criteria.true) &&
    boundedText(value.criteria.false) &&
    Object.keys(value.criteria).length === 2
  ) {
    return {
      type: "bool",
      instructions: value.instructions,
      criteria: { true: value.criteria.true, false: value.criteria.false },
    };
  }
  return undefined;
}

function parseContext(value: unknown): ClassifierContext | undefined {
  if (!isRecord(value) || !isRecord(value.state) || !isRecord(value.questions)) {
    return undefined;
  }
  if (!Object.values(value.state).every((entry) => isJsonValue(entry))) {
    return undefined;
  }
  const questionEntries = Object.entries(value.questions);
  if (
    questionEntries.length === 0 ||
    questionEntries.length > MAX_QUESTIONS ||
    questionEntries.some(([id]) => !boundedText(id) || id.length > 96)
  ) {
    return undefined;
  }
  const questions = Object.create(null) as Record<string, ClassifierQuestion>;
  for (const [id, rawQuestion] of questionEntries) {
    const question = parseQuestion(rawQuestion);
    if (!question) return undefined;
    questions[id] = question;
  }
  const context: ClassifierContext = {
    state: value.state as JsonObject,
    questions,
  };
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > MAX_CONTEXT_BYTES) {
    return undefined;
  }
  return context;
}

/** Agent-only, deferred call to the configured System One classifier. */
export function createJevClassifierTool(
  input: string | JevClassifierRuntimeConfig,
): AgentTool {
  const config = configuredJev(input);
  const jevModel = {
    ...defaultJevModel,
    id: config.modelId,
    baseUrl: config.baseUrl,
  };
  const operationUrl = jevSystemOneUrl(config);
  return {
    name: "JevClassify",
    label: "Jev classify",
    description:
      "Classify JSON state with the configured System One classifier and return structured choice, score, or boolean answers. The state and questions are sent to that configured endpoint; include only information the user has approved for that service.",
    parameters: Type.Object(
      {
        state: Type.Record(Type.String(), Type.Any()),
        questions: Type.Record(
          Type.String(),
          Type.Union([
            choiceQuestionSchema,
            scoreQuestionSchema,
            boolQuestionSchema,
          ]),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams, signal) => {
      const context = parseContext(rawParams);
      if (!context) {
        return {
          content: [
            {
              type: "text",
              text: "JevClassify requires a JSON object state and 1–16 valid structured questions; the total input must be at most 24 KiB.",
            },
          ],
          details: { errorCode: "JEV_INVALID_ARGUMENT" },
          isError: true,
        };
      }
      const timeoutSignal = AbortSignal.timeout(45_000);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      const result = await models.classify(jevModel, context, {
        apiKey: config.apiKey,
        fetch: sameOriginClassifierFetch(operationUrl),
        signal: requestSignal,
        timeoutMs: 45_000,
        maxRetries: 1,
      });
      if (result.stopReason !== "stop") {
        const errorMessage = (result.errorMessage ?? "Request did not complete")
          .replaceAll(config.apiKey, "[redacted]")
          .slice(0, 1_000);
        return {
          content: [{ type: "text", text: `Jev classification failed: ${errorMessage}` }],
          details: {
            errorCode:
              result.stopReason === "aborted"
                ? "JEV_ABORTED"
                : "JEV_REQUEST_FAILED",
          },
          isError: true,
        };
      }
      const answer = {
        answers: result.answers,
        ...(result.usage ? { usage: result.usage } : {}),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(answer, null, 2) }],
        details: answer,
      };
    },
  };
}
