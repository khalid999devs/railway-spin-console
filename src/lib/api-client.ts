import type { ApiProblem, ConsoleSnapshot, CreateContainerRequest } from "./contract";

/** Any failed call, carrying the server's plain-words problem (and Railway's trace id when there is one). */
export class ProblemError extends Error {
  constructor(
    readonly problem: ApiProblem,
    readonly status: number,
  ) {
    super(problem.message);
    this.name = "ProblemError";
  }
}

export const problemOf = (error: unknown): ApiProblem | null =>
  error instanceof ProblemError ? error.problem : error ? { code: "unexpected", message: "Something unexpected went wrong in the page." } : null;

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ProblemError({ code: "offline", message: "Could not reach this app. Check your connection." }, 0);
  }
  const payload = (await response.json().catch(() => null)) as { problem?: ApiProblem } | null;
  if (!response.ok) {
    const fallback = { code: `http_${response.status}`, message: `The app answered HTTP ${response.status}.` };
    throw new ProblemError(payload?.problem ?? fallback, response.status);
  }
  return payload as T;
}

export const api = {
  state: () => call<ConsoleSnapshot>("/api/state"),
  unlock: (passphrase: string) => call<{ unlocked: boolean }>("/api/session", "POST", { passphrase }),
  lock: () => call<{ unlocked: boolean }>("/api/session", "DELETE"),
  create: (request: CreateContainerRequest) => call<ConsoleSnapshot>("/api/containers", "POST", request),
  start: (id: string) => call<ConsoleSnapshot>(`/api/containers/${encodeURIComponent(id)}/start`, "POST"),
  stop: (id: string) => call<ConsoleSnapshot>(`/api/containers/${encodeURIComponent(id)}/stop`, "POST"),
  destroy: (id: string) => call<ConsoleSnapshot>(`/api/containers/${encodeURIComponent(id)}`, "DELETE"),
};
