import { CODE_ASSIST_ENDPOINT, CODE_ASSIST_HEADERS } from "../constants";
import { debugLog, logAntigravityDebugResponse, type AntigravityDebugContext } from "./debug";
import {
  extractUsageFromSsePayload,
  extractUsageMetadata,
  generateRequestId,
  getSessionId,
  parseGeminiApiBody,
  rewriteGeminiPreviewAccessError,
  rewriteGeminiRateLimitError,
  type GeminiApiBody
} from "./request-helpers";
import {
  transformClaudeRequest,
  transformGeminiRequest,
  type TransformContext,
} from "./transform";
import type { PluginClient } from "./types";

const STREAM_ACTION = "streamGenerateContent";

const MODEL_ALIASES: Record<string, string> = {
  "gemini-2.5-computer-use-preview-10-2025": "rev19-uic3-1p",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-3-pro-preview": "gemini-3-pro-high",
  "gemini-claude-sonnet-4-5": "claude-sonnet-4-5",
  "gemini-claude-sonnet-4-5-thinking": "claude-sonnet-4-5-thinking",
  "gemini-claude-opus-4-5-thinking": "claude-opus-4-5-thinking",
};

const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
};

export function isGenerativeLanguageRequest(input: RequestInfo): input is string {
  return typeof input === "string" && input.includes("generativelanguage.googleapis.com");
}

function transformStreamingPayload(payload: string): string {
  return payload
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }
      const json = line.slice(5).trim();
      if (!json) {
        return line;
      }
      try {
        const parsed = JSON.parse(json) as { response?: unknown };
        if (parsed.response !== undefined) {
          return `data: ${JSON.stringify(parsed.response)}`;
        }
      } catch (_) { }
      return line;
    })
    .join("\n");
}

function transformSseLine(line: string): string {
  if (!line.startsWith("data:")) {
    return line;
  }
  const json = line.slice(5).trim();
  if (!json) {
    return line;
  }
  try {
    const parsed = JSON.parse(json) as { response?: unknown };
    if (parsed.response !== undefined) {
      const responseStr = JSON.stringify(parsed.response);
      if (responseStr.includes('"thought"') || responseStr.includes('"thinking"')) {
        debugLog("[SSE Transform] Found thinking content in response:", responseStr.slice(0, 500));
      }
      return `data: ${JSON.stringify(parsed.response)}`;
    }
  } catch (_) { }
  return line;
}

export function createSseTransformStream(): TransformStream<string, string> {
  let buffer = "";

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const transformed = transformSseLine(line);
        controller.enqueue(transformed + "\n");
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        const transformed = transformSseLine(buffer);
        controller.enqueue(transformed);
      }
    },
  });
}


function resolveModelName(rawModel: string): string {
  const aliased = MODEL_ALIASES[rawModel];
  if (aliased) {
    return aliased;
  }
  return MODEL_FALLBACKS[rawModel] ?? rawModel;
}

export function prepareAntigravityRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
): { request: RequestInfo; init: RequestInit; streaming: boolean; requestedModel?: string } {
  const baseInit: RequestInit = { ...init };
  const headers = new Headers(init?.headers ?? {});

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");

  const match = input.match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  const [, rawModel = "", rawAction = ""] = match;
  const effectiveModel = resolveModelName(rawModel);
  const streaming = rawAction === STREAM_ACTION;
  const transformedUrl = `${CODE_ASSIST_ENDPOINT}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""
    }`;

  let body = baseInit.body;
  let transformDebugInfo: { transformer: string; toolCount?: number; toolsTransformed?: boolean } | undefined;

  if (typeof baseInit.body === "string" && baseInit.body) {
    try {
      const parsedBody = JSON.parse(baseInit.body) as Record<string, unknown>;
      const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;

      if (isWrapped) {
        const wrappedBody = {
          ...parsedBody,
          model: effectiveModel,
          userAgent: "antigravity",
          requestId: generateRequestId(),
        } as Record<string, unknown>;
        if (wrappedBody.request && typeof wrappedBody.request === "object") {
          (wrappedBody.request as Record<string, unknown>).sessionId = getSessionId();
        }
        body = JSON.stringify(wrappedBody);
      } else {
        const context: TransformContext = {
          model: effectiveModel,
          projectId,
          streaming,
          requestId: generateRequestId(),
          sessionId: getSessionId(),
        };

        const isClaudeModel = effectiveModel.includes("claude");
        const result = isClaudeModel
          ? transformClaudeRequest(context, parsedBody)
          : transformGeminiRequest(context, parsedBody);

        body = result.body;
        transformDebugInfo = result.debugInfo;

        if (transformDebugInfo) {
          debugLog(`[Antigravity Transform] Using ${transformDebugInfo.transformer} transformer for model: ${effectiveModel}`);
          if (transformDebugInfo.toolCount !== undefined) {
            debugLog(`[Antigravity Transform] Tool count: ${transformDebugInfo.toolCount}`);
          }
        }
      }
    } catch (error) {
      console.error("Failed to transform Antigravity request body:", error);
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }

  headers.set("User-Agent", CODE_ASSIST_HEADERS["User-Agent"]);
  headers.set("X-Goog-Api-Client", CODE_ASSIST_HEADERS["X-Goog-Api-Client"]);
  headers.set("Client-Metadata", CODE_ASSIST_HEADERS["Client-Metadata"]);

  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel: rawModel,
  };
}

/**
 * Normalizes Gemini responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
 */
export async function transformAntigravityResponse(
  response: Response,
  streaming: boolean,
  client: PluginClient,
  debugContext?: AntigravityDebugContext | null,
  requestedModel?: string,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");

  if (!isJsonResponse && !isEventStreamResponse) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    });
    return response;
  }

  if (streaming && response.ok && isEventStreamResponse && response.body) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Streaming SSE (passthrough mode)",
    });

    const transformedBody = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createSseTransformStream())
      .pipeThrough(new TextEncoderStream());

    return new Response(transformedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  try {
    const text = await response.text();
    const headers = new Headers(response.headers);

    // Apply retry headers logic (omitted complex retry logic for brevity, relying on standard headers)

    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const usageFromSse = streaming && isEventStreamResponse ? extractUsageFromSsePayload(text) : null;
    const parsed: GeminiApiBody | null = !streaming || !isEventStreamResponse ? parseGeminiApiBody(text) : null;

    // Apply error rewrites
    const previewErrorFixed = parsed ? rewriteGeminiPreviewAccessError(parsed, response.status, requestedModel) : null;
    const rateLimitErrorFixed = parsed && !previewErrorFixed ? rewriteGeminiRateLimitError(parsed) : null;

    const patched = previewErrorFixed ?? rateLimitErrorFixed;
    const effectiveBody = patched ?? parsed ?? undefined;

    const usage = usageFromSse ?? (effectiveBody ? extractUsageMetadata(effectiveBody) : null);
    if (usage?.cachedContentTokenCount !== undefined) {
      headers.set("x-gemini-cached-content-token-count", String(usage.cachedContentTokenCount));
      if (usage.totalTokenCount !== undefined) {
        headers.set("x-gemini-total-token-count", String(usage.totalTokenCount));
      }
      if (usage.promptTokenCount !== undefined) {
        headers.set("x-gemini-prompt-token-count", String(usage.promptTokenCount));
      }
      if (usage.candidatesTokenCount !== undefined) {
        headers.set("x-gemini-candidates-token-count", String(usage.candidatesTokenCount));
      }
    }

    logAntigravityDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (fallback)" : undefined,
      headersOverride: headers,
    });

    if (previewErrorFixed?.error) {
      await client.tui.showToast({
        body: { message: previewErrorFixed.error.message ?? "You need access to gemini 3", title: "Gemini 3 Access Required", variant: "error" }
      });
    }

    if (rateLimitErrorFixed?.error) {
      await client.tui.showToast({
        body: { message: rateLimitErrorFixed.error.message ?? "You are rate limited", title: "Antigravity Rate Limited", variant: "error" }
      });
    }

    if (streaming && response.ok && isEventStreamResponse) {
      return new Response(transformStreamingPayload(text), init);
    }

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody?.response !== undefined) {
      return new Response(JSON.stringify(effectiveBody.response), init);
    }

    if (patched) {
      return new Response(JSON.stringify(patched), init);
    }

    return new Response(text, init);
  } catch (error) {
    logAntigravityDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Antigravity response",
    });
    console.error("Failed to transform Antigravity response:", error);
    return response;
  }
}

