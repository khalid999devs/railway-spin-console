import type { z } from "zod";
import type { ApiProblem } from "@/lib/contract";
import { ConsoleError, describeProblem } from "@/server/console/problems";
import { getRuntime, type Runtime } from "@/server/runtime";

const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { ...NO_STORE, ...init.headers } });
}

export function problemResponse(error: unknown): Response {
  const { status, problem } = describeProblem(error);
  if (status === 500) console.error("[api] unexpected error:", error);
  const headers = problem.retryAfterSeconds ? { "retry-after": String(problem.retryAfterSeconds) } : undefined;
  return json({ problem } satisfies { problem: ApiProblem }, { status, headers });
}

export async function readBody<T>(request: Request, shape: z.ZodType<T>): Promise<T> {
  const parsed = shape.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) throw new ConsoleError("invalid_request", "The request body is not in the expected form.");
  return parsed.data;
}

/** Railway's edge puts the visitor's address in `X-Real-IP`. */
export const clientKey = (request: Request) => request.headers.get("x-real-ip") ?? "local";

/**
 * A browser sends `Origin` with every cross-site write. Refusing a foreign
 * one stops another site from using a visitor's session cookie, on top of
 * what `SameSite=Lax` already blocks.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (URL.parse(origin)?.host !== host) throw new ConsoleError("forbidden", "Requests from another site are not accepted.");
}

/** Reads are open to anyone. Every write goes through here: same site, then a valid session. */
export async function handleWrite(request: Request, action: (runtime: Runtime) => Promise<void>): Promise<Response> {
  try {
    const runtime = getRuntime();
    assertSameOrigin(request);
    if (!runtime.sessions.isValid(request)) throw new ConsoleError("locked", "Enter the passphrase to make changes.");
    await action(runtime);
    return json(await runtime.service.snapshot(true));
  } catch (error) {
    return problemResponse(error);
  }
}
