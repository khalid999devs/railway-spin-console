import type { z } from "zod";
import { parseRatePolicy, type RequestBudget } from "./budget";
import type { GraphqlDocument } from "./documents";
import { classifyGraphqlError, isRailwayError, RailwayError } from "./errors";

export const RAILWAY_ENDPOINT = "https://backboard.railway.com/graphql/v2";

/**
 * A read that hangs is abandoned quickly because it will be repeated. A write is given longer:
 * `serviceDelete` took up to 7 s in the probe and more than 15 s once in production, and giving
 * up early means checking Railway and possibly sending it twice.
 */
const TIMEOUT_MS = { query: 10_000, mutation: 30_000 };
/** Waits before the second and third attempt of a query that got no answer. */
const QUERY_RETRY_DELAYS_MS = [300, 900];

export interface TransportOptions {
  token: string;
  /** A project token goes in its own header; sent as a Bearer token it is rejected as "not found". */
  tokenType: "project" | "account";
  budget: RequestBudget;
  endpoint?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type Transport = <T>(document: GraphqlDocument, variables: Record<string, unknown>, shape: z.ZodType<T>) => Promise<T>;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createTransport(options: TransportOptions): Transport {
  const { token, tokenType, budget, endpoint = RAILWAY_ENDPOINT, fetch: send = fetch, sleep = delay } = options;
  const headers = {
    "content-type": "application/json",
    ...(tokenType === "project" ? { "Project-Access-Token": token } : { Authorization: `Bearer ${token}` }),
  };

  async function attempt<T>(document: GraphqlDocument, variables: Record<string, unknown>, shape: z.ZodType<T>): Promise<T> {
    const operation = document.name;
    budget.record();

    let response: Response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: document.text, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS[document.kind]),
        cache: "no-store",
      });
    } catch (cause) {
      throw new RailwayError("no_response", "Railway did not answer", { operation, cause });
    }
    budget.observePolicy(parseRatePolicy(response.headers.get("ratelimit-policy")));

    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get("retry-after")) || undefined;
      throw new RailwayError("rate_limited", "Railway's hourly request limit is used up", { operation, retryAfterSeconds });
    }

    const body = (await response.json().catch(() => null)) as { data?: unknown; errors?: unknown } | null;
    if (body === null || typeof body !== "object") {
      // A gateway error page: Railway's API never saw, or never answered, the request.
      const kind = response.status >= 500 ? "no_response" : "malformed_response";
      throw new RailwayError(kind, `Railway answered HTTP ${response.status} without a JSON body`, { operation });
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw classifyGraphqlError(body.errors[0], operation, response.status);
    }

    const parsed = shape.safeParse(body.data);
    if (!parsed.success) {
      throw new RailwayError("malformed_response", `Railway's ${operation} response did not have the expected shape`, {
        operation,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return async function request(document, variables, shape) {
    // A mutation that got an answer has run, and one that got none may have.
    // Only queries are repeated here; callers decide what to do about mutations.
    const delays = document.kind === "query" ? QUERY_RETRY_DELAYS_MS : [];
    for (const wait of delays) {
      try {
        return await attempt(document, variables, shape);
      } catch (error) {
        if (!isRailwayError(error, "no_response")) throw error;
        await sleep(wait);
      }
    }
    return attempt(document, variables, shape);
  };
}
