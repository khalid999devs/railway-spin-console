import type { ApiProblem } from "@/lib/contract";
import { RailwayError, type RailwayErrorKind } from "@/server/railway/errors";

export type ConsoleErrorCode = "invalid_request" | "not_found" | "not_allowed" | "cap_reached" | "locked" | "throttled" | "forbidden";

/** A request this app refuses on its own authority, before or instead of asking Railway. */
export class ConsoleError extends Error {
  constructor(
    readonly code: ConsoleErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ConsoleError";
  }
}

const CONSOLE_STATUS: Record<ConsoleErrorCode, number> = {
  invalid_request: 400,
  locked: 401,
  forbidden: 403,
  not_found: 404,
  not_allowed: 409,
  cap_reached: 409,
  throttled: 429,
};

const RAILWAY_STATUS: Partial<Record<RailwayErrorKind, number>> = { rate_limited: 429, no_response: 504 };

const RAILWAY_WORDING: Partial<Record<RailwayErrorKind, (error: RailwayError) => string>> = {
  no_response: () => "Railway did not answer. Nothing here was changed on its say-so; what you see is the last state it reported.",
  rate_limited: () => "Railway's hourly request limit for this app is used up.",
  unauthorized: (error) => `Railway refused this app's token for ${error.operation}: "${error.message}".`,
  malformed_response: (error) => `Railway's answer to ${error.operation} was not in the expected form.`,
};

export interface DescribedProblem {
  status: number;
  problem: ApiProblem;
}

/** Turns any thrown value into plain words plus the facts worth showing: Railway's message and trace id. */
export function describeProblem(error: unknown): DescribedProblem {
  if (error instanceof ConsoleError) {
    const { code, message, retryAfterSeconds } = error;
    return { status: CONSOLE_STATUS[code], problem: { code, message, retryAfterSeconds } };
  }
  if (error instanceof RailwayError) {
    const message = RAILWAY_WORDING[error.kind]?.(error) ?? `Railway refused ${error.operation}: "${error.message}".`;
    return {
      status: RAILWAY_STATUS[error.kind] ?? 502,
      problem: { code: `railway_${error.kind}`, message, traceId: error.traceId, retryAfterSeconds: error.retryAfterSeconds },
    };
  }
  return { status: 500, problem: { code: "internal", message: "Something went wrong in this app, not in Railway." } };
}
