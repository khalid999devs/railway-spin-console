import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RequestBudget } from "./budget";
import type { GraphqlDocument } from "./documents";
import { RailwayError } from "./errors";
import { createTransport } from "./transport";

const TOKEN = "11111111-2222-3333-4444-555555555555";
const QUERY: GraphqlDocument = { name: "Read", kind: "query", text: "query Read { ok }" };
const MUTATION: GraphqlDocument = { name: "Write", kind: "mutation", text: "mutation Write { ok }" };
const shape = z.object({ ok: z.boolean() });

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers } });

function setup(responses: (Response | Error)[], tokenType: "project" | "account" = "project") {
  const send = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("test sent more requests than it prepared responses for");
    if (next instanceof Error) throw next;
    return next;
  });
  const budget = new RequestBudget(() => 0);
  const sleep = vi.fn(async () => {});
  const request = createTransport({ token: TOKEN, tokenType, budget, fetch: send as unknown as typeof fetch, sleep });
  const headersOf = (call: number) => send.mock.calls[call][1]?.headers as Record<string, string>;
  return { request, send, budget, sleep, headersOf };
}

const caught = (promise: Promise<unknown>) => promise.then(() => expect.unreachable("expected a rejection"), (error: RailwayError) => error);

describe("transport", () => {
  it("sends a project token in its own header, not as a Bearer token", async () => {
    const { request, headersOf } = setup([json({ data: { ok: true } })]);
    await request(QUERY, {}, shape);
    expect(headersOf(0)["Project-Access-Token"]).toBe(TOKEN);
    expect(headersOf(0).Authorization).toBeUndefined();
  });

  it("sends an account token as a Bearer token", async () => {
    const { request, headersOf } = setup([json({ data: { ok: true } })], "account");
    await request(QUERY, {}, shape);
    expect(headersOf(0).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headersOf(0)["Project-Access-Token"]).toBeUndefined();
  });

  it("classifies an error that arrives as HTTP 200, keeping the trace id", async () => {
    const body = { data: null, errors: [{ message: "Not Authorized", extensions: { code: "INTERNAL_SERVER_ERROR" }, traceId: "123" }] };
    const { request } = setup([json(body)]);
    expect(await caught(request(MUTATION, {}, shape))).toMatchObject({ kind: "unauthorized", traceId: "123", operation: "Write" });
  });

  it("never repeats a mutation that got no answer", async () => {
    const { request, send } = setup([new TypeError("fetch failed")]);
    expect(await caught(request(MUTATION, {}, shape))).toMatchObject({ kind: "no_response" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("repeats a query that got no answer, with a pause, up to three attempts", async () => {
    const { request, send, sleep } = setup([new TypeError("fetch failed"), new Response("bad gateway", { status: 502 }), json({ data: { ok: true } })]);
    expect(await request(QUERY, {}, shape)).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[300], [900]]);
  });

  it("gives up on a query after three unanswered attempts", async () => {
    const { request, send } = setup([new TypeError("a"), new TypeError("b"), new TypeError("c")]);
    expect(await caught(request(QUERY, {}, shape))).toMatchObject({ kind: "no_response" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not repeat a query that Railway answered with an error", async () => {
    const { request, send } = setup([json({ errors: [{ message: "Deployment not found" }] })]);
    expect(await caught(request(QUERY, {}, shape))).toMatchObject({ kind: "not_found" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports the rate limit with Railway's Retry-After and does not retry into it", async () => {
    const { request, send } = setup([new Response("", { status: 429, headers: { "retry-after": "120" } })]);
    expect(await caught(request(QUERY, {}, shape))).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 120 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects a response that lacks the fields the app relies on", async () => {
    const { request } = setup([json({ data: { ok: "yes" } })]);
    expect(await caught(request(MUTATION, {}, shape))).toMatchObject({ kind: "malformed_response" });
  });

  it("counts every attempt against the budget and learns the limit from the response", async () => {
    const policy = { "ratelimit-policy": '"default";q=1000;w=3600' };
    const { request, budget } = setup([new TypeError("fetch failed"), json({ data: { ok: true } }, { headers: policy })]);
    await request(QUERY, {}, shape);
    expect(budget.snapshot()).toMatchObject({ used: 2, limit: 1000, source: "railway" });
  });

  it("never puts the token in an error", async () => {
    const failures = [new TypeError(`connect failed for ${TOKEN}`), json({ errors: [{ message: "Not Authorized" }] }), json({ data: {} })];
    for (const failure of failures) {
      const { request } = setup([failure]);
      const error = await caught(request(MUTATION, {}, shape));
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(TOKEN);
    }
  });
});
