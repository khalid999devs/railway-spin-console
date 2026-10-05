export type RailwayErrorKind =
  | "unauthorized"
  | "not_found"
  | "already_exists"
  | "invalid_input"
  | "invalid_document"
  | "rate_limited"
  | "no_response"
  | "malformed_response"
  | "unknown";

interface RailwayErrorDetails {
  operation: string;
  traceId?: string;
  code?: string;
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class RailwayError extends Error {
  readonly kind: RailwayErrorKind;
  readonly operation: string;
  readonly traceId?: string;
  readonly code?: string;
  readonly retryAfterSeconds?: number;

  constructor(kind: RailwayErrorKind, message: string, details: RailwayErrorDetails) {
    super(message, { cause: details.cause });
    this.name = "RailwayError";
    this.kind = kind;
    this.operation = details.operation;
    this.traceId = details.traceId;
    this.code = details.code;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/**
 * Matches by name rather than `instanceof`: Next.js can load this module once
 * per bundle, and an error thrown by one copy is not an instance of the other
 * copy's class.
 */
export const isRailwayError = (error: unknown, ...kinds: RailwayErrorKind[]): error is RailwayError =>
  error instanceof Error && error.name === "RailwayError" && (kinds.length === 0 || kinds.includes((error as RailwayError).kind));

interface GraphqlError {
  message?: unknown;
  traceId?: unknown;
  extensions?: { code?: unknown; traceId?: unknown };
}

/**
 * Railway returns failures as HTTP 200 with an `errors` array, and uses
 * `INTERNAL_SERVER_ERROR` for both "wrong credentials" and "no such
 * deployment", so the message has to be read as well as the code.
 */
export function classifyGraphqlError(error: GraphqlError, operation: string, httpStatus: number): RailwayError {
  const message = typeof error.message === "string" ? error.message : "Railway returned an error without a message";
  const code = typeof error.extensions?.code === "string" ? error.extensions.code : undefined;
  // Observed on the error object; the docs show it inside `extensions`. Accept either.
  const trace = error.traceId ?? error.extensions?.traceId;
  const traceId = typeof trace === "string" || typeof trace === "number" ? String(trace) : undefined;

  return new RailwayError(kindOf(message, code, httpStatus), message, { operation, traceId, code });
}

function kindOf(message: string, code: string | undefined, httpStatus: number): RailwayErrorKind {
  if (code === "GRAPHQL_VALIDATION_FAILED" || code === "GRAPHQL_PARSE_FAILED" || httpStatus === 400) return "invalid_document";
  if (/not authorized|token not found|unauthorized/i.test(message)) return "unauthorized";
  if (/already exists/i.test(message)) return "already_exists";
  if (/not found/i.test(message)) return "not_found";
  if (code === "BAD_USER_INPUT") return "invalid_input";
  return "unknown";
}
