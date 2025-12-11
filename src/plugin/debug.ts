import { createLogger } from "./logger";

const MAX_BODY_PREVIEW_CHARS = 2000;

const log = createLogger("debug");

export interface AntigravityDebugContext {
  id: string;
  streaming: boolean;
  startedAt: number;
}

interface AntigravityDebugRequestMeta {
  originalUrl: string;
  resolvedUrl: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  streaming: boolean;
  projectId?: string;
  sessionId?: string;
}

interface AntigravityDebugResponseMeta {
  body?: string;
  note?: string;
  error?: unknown;
  headersOverride?: HeadersInit;
}

let requestCounter = 0;

export function startAntigravityDebugRequest(meta: AntigravityDebugRequestMeta): AntigravityDebugContext | null {
  const id = `ANTIGRAVITY-${++requestCounter}`;
  const method = meta.method ?? "GET";

  log.debug(`${id} ${method} ${meta.resolvedUrl}`, {
    originalUrl: meta.originalUrl !== meta.resolvedUrl ? meta.originalUrl : undefined,
    projectId: meta.projectId,
    sessionId: meta.sessionId,
    streaming: meta.streaming,
    headers: maskHeaders(meta.headers),
    bodyPreview: formatBodyPreview(meta.body),
  });

  return { id, streaming: meta.streaming, startedAt: Date.now() };
}

export function logAntigravityDebugResponse(
  context: AntigravityDebugContext | null | undefined,
  response: Response,
  meta: AntigravityDebugResponseMeta = {},
): void {
  if (!context) {
    return;
  }

  const durationMs = Date.now() - context.startedAt;

  log.debug(`${context.id} Response ${response.status} ${response.statusText} (${durationMs}ms)`, {
    headers: maskHeaders(meta.headersOverride ?? response.headers),
    note: meta.note,
    error: meta.error ? formatError(meta.error) : undefined,
    bodyPreview: meta.body ? truncateForLog(meta.body) : undefined,
  });
}

function maskHeaders(headers?: HeadersInit | Headers): Record<string, string> {
  if (!headers) {
    return {};
  }

  const result: Record<string, string> = {};
  const parsed = headers instanceof Headers ? headers : new Headers(headers);
  parsed.forEach((value, key) => {
    if (key.toLowerCase() === "authorization") {
      result[key] = "[redacted]";
    } else {
      result[key] = value;
    }
  });
  return result;
}

function formatBodyPreview(body?: BodyInit | null): string | undefined {
  if (body == null) {
    return undefined;
  }

  if (typeof body === "string") {
    return truncateForLog(body);
  }

  if (body instanceof URLSearchParams) {
    return truncateForLog(body.toString());
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return `[Blob size=${body.size}]`;
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return "[FormData payload omitted]";
  }

  return `[${body.constructor?.name ?? typeof body} payload omitted]`;
}

function truncateForLog(text: string): string {
  if (text.length <= MAX_BODY_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_BODY_PREVIEW_CHARS)}... (truncated ${text.length - MAX_BODY_PREVIEW_CHARS} chars)`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
