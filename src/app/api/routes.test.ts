import { beforeEach, describe, expect, it } from "vitest";
import type { ApiProblem, ConsoleSnapshot } from "@/lib/contract";
import { RequestBudget } from "@/server/railway/budget";
import { RailwayError } from "@/server/railway/errors";
import { FakeRailway } from "@/server/railway/fake";
import { createRuntime, setRuntime } from "@/server/runtime";
import { fakeClock, MINUTE, SECOND } from "../../../tests/support/console";
import { DELETE as destroy } from "./containers/[serviceId]/route";
import { POST as start } from "./containers/[serviceId]/start/route";
import { POST as stop } from "./containers/[serviceId]/stop/route";
import { POST as createContainer } from "./containers/route";
import { GET as health } from "./health/route";
import { DELETE as lock, POST as unlock } from "./session/route";
import { GET as state } from "./state/route";

const ORIGIN = "https://console.example";
const PASSPHRASE = "open sesame";
const ENV = { RAILWAY_SANDBOX_TOKEN: "unused-with-a-fake", CONSOLE_PASSPHRASE: PASSPHRASE, SESSION_SECRET: "s".repeat(64) };

let clock: ReturnType<typeof fakeClock>;
let railway: FakeRailway;

beforeEach(() => {
  clock = fakeClock();
  railway = new FakeRailway({ now: clock.now, budget: new RequestBudget(clock.now) });
  setRuntime(createRuntime(ENV, { now: clock.now, api: railway }));
});

interface Options {
  cookie?: string;
  body?: unknown;
  origin?: string;
  ip?: string;
}

function request(method: string, path: string, { cookie, body, origin = ORIGIN, ip = "203.0.113.7" }: Options = {}): Request {
  const headers: Record<string, string> = { host: "console.example", origin, "x-real-ip": ip, "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const forService = (serviceId: string) => ({ params: Promise.resolve({ serviceId }) });
const problemOf = async (response: Response) => ((await response.json()) as { problem: ApiProblem }).problem;
const snapshotOf = async (response: Response) => (await response.json()) as ConsoleSnapshot;

async function unlockedCookie(): Promise<string> {
  const response = await unlock(request("POST", "/api/session", { body: { passphrase: PASSPHRASE } }));
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}

const mutations = () => railway.calls.filter((call) => call !== "listInstances");

describe("reads", () => {
  it("are open to anyone and say the visitor is locked", async () => {
    const response = await state(request("GET", "/api/state"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await snapshotOf(response)).toMatchObject({ containers: [], unlocked: false });
  });

  it("say the visitor is unlocked once they hold a session", async () => {
    const response = await state(request("GET", "/api/state", { cookie: await unlockedCookie() }));
    expect((await snapshotOf(response)).unlocked).toBe(true);
  });

  it("pass on Railway's message and trace id when the first read fails", async () => {
    railway.failNext("listInstances", new RailwayError("unauthorized", "Not Authorized", { operation: "SandboxState", traceId: "8150237954655095912" }));
    const response = await state(request("GET", "/api/state"));

    expect(response.status).toBe(502);
    expect(await problemOf(response)).toMatchObject({ code: "railway_unauthorized", traceId: "8150237954655095912" });
  });
});

describe("the passphrase gate", () => {
  it.each([
    ["create", () => createContainer(request("POST", "/api/containers", { body: { operationId: "aaaaaaaa", imageId: "nginx" } }))],
    ["start", () => start(request("POST", "/api/containers/service-1/start"), forService("service-1"))],
    ["stop", () => stop(request("POST", "/api/containers/service-1/stop"), forService("service-1"))],
    ["destroy", () => destroy(request("DELETE", "/api/containers/service-1"), forService("service-1"))],
  ])("refuses %s without a session, before anything reaches Railway", async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(401);
    expect((await problemOf(response)).code).toBe("locked");
    expect(railway.calls).toEqual([]);
  });

  it("refuses a wrong passphrase and sets no cookie", async () => {
    const response = await unlock(request("POST", "/api/session", { body: { passphrase: "open says me" } }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("throttles a client after five wrong attempts, even if the sixth is right", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await unlock(request("POST", "/api/session", { body: { passphrase: "wrong" } }));
    }
    const response = await unlock(request("POST", "/api/session", { body: { passphrase: PASSPHRASE } }));

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(response.headers.get("set-cookie")).toBeNull();

    const other = await unlock(request("POST", "/api/session", { body: { passphrase: PASSPHRASE }, ip: "198.51.100.9" }));
    expect(other.status).toBe(200);

    clock.advance(10 * MINUTE);
    expect((await unlock(request("POST", "/api/session", { body: { passphrase: PASSPHRASE } }))).status).toBe(200);
  });

  it("refuses a forged cookie", async () => {
    const cookie = (await unlockedCookie()).replace(/.$/, "x");
    const response = await createContainer(request("POST", "/api/containers", { cookie, body: { operationId: "aaaaaaaa", imageId: "nginx" } }));
    expect(response.status).toBe(401);
  });

  it("refuses a write sent from another site, even with a valid cookie", async () => {
    const cookie = await unlockedCookie();
    const response = await createContainer(
      request("POST", "/api/containers", { cookie, origin: "https://evil.example", body: { operationId: "aaaaaaaa", imageId: "nginx" } }),
    );
    expect(response.status).toBe(403);
    expect(railway.calls).toEqual([]);
  });

  it("locks again", async () => {
    const response = lock(request("DELETE", "/api/session"));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("writes with a session", () => {
  it("runs the whole lifecycle and returns Railway's state after each step", async () => {
    const cookie = await unlockedCookie();
    const body = { operationId: "aaaaaaaa", imageId: "httpd" };

    const created = await snapshotOf(await createContainer(request("POST", "/api/containers", { cookie, body })));
    expect(created.containers).toMatchObject([{ name: "spin-aaaaaaaa", image: "httpd:alpine", state: "starting" }]);
    const { id } = created.containers[0];

    clock.advance(10 * SECOND);
    expect((await snapshotOf(await state(request("GET", "/api/state")))).containers[0].state).toBe("running");

    expect((await stop(request("POST", `/api/containers/${id}/stop`, { cookie }), forService(id))).status).toBe(200);
    clock.advance(3 * SECOND);
    expect((await snapshotOf(await state(request("GET", "/api/state")))).containers[0].state).toBe("stopped");

    const restarted = await snapshotOf(await start(request("POST", `/api/containers/${id}/start`, { cookie }), forService(id)));
    expect(restarted.containers[0].state).toBe("running");

    const destroyed = await snapshotOf(await destroy(request("DELETE", `/api/containers/${id}`, { cookie }), forService(id)));
    expect(destroyed.containers).toEqual([]);
    expect(await railway.listInstances()).toEqual([]);
  });

  it("answers 400 for an image that is not on the list", async () => {
    const cookie = await unlockedCookie();
    const response = await createContainer(request("POST", "/api/containers", { cookie, body: { operationId: "aaaaaaaa", imageId: "alpine" } }));
    expect(response.status).toBe(400);
    expect(mutations()).toEqual([]);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const cookie = await unlockedCookie();
    const broken = new Request(`${ORIGIN}/api/containers`, { method: "POST", headers: { cookie, host: "console.example" }, body: "{" });
    expect((await createContainer(broken)).status).toBe(400);
  });

  it("answers 409 with the reason when the cap is reached", async () => {
    const cookie = await unlockedCookie();
    for (const operationId of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) {
      await createContainer(request("POST", "/api/containers", { cookie, body: { operationId, imageId: "nginx" } }));
    }
    const response = await createContainer(request("POST", "/api/containers", { cookie, body: { operationId: "dddddddd", imageId: "nginx" } }));

    expect(response.status).toBe(409);
    expect(await problemOf(response)).toMatchObject({ code: "cap_reached", message: expect.stringContaining("3 containers") });
  });

  it("answers 409 with the same reason the screen shows when an action is not allowed", async () => {
    const cookie = await unlockedCookie();
    const created = await snapshotOf(
      await createContainer(request("POST", "/api/containers", { cookie, body: { operationId: "aaaaaaaa", imageId: "nginx" } })),
    );
    const [container] = created.containers;
    const response = await stop(request("POST", `/api/containers/${container.id}/stop`, { cookie }), forService(container.id));

    expect(response.status).toBe(409);
    expect((await problemOf(response)).message).toBe((container.actions.stop as { reason: string }).reason);
  });

  it("answers 404 for a service the app does not own", async () => {
    const cookie = await unlockedCookie();
    const foreign = railway.addForeignService("postgres");
    const response = await destroy(request("DELETE", `/api/containers/${foreign}`, { cookie }), forService(foreign));

    expect(response.status).toBe(404);
    expect(mutations()).toEqual([]);
  });

  it("answers 504 in plain words when Railway does not answer a write", async () => {
    const cookie = await unlockedCookie();
    const lost = () => new RailwayError("no_response", "Railway did not answer", { operation: "ServiceCreate" });
    railway.failNext("createService", lost());
    railway.failNext("createService", lost());

    const response = await createContainer(request("POST", "/api/containers", { cookie, body: { operationId: "aaaaaaaa", imageId: "nginx" } }));

    expect(response.status).toBe(504);
    expect((await problemOf(response)).message).toContain("Railway did not answer");
  });
});

describe("health", () => {
  it("is healthy without calling Railway", () => {
    const response = health();
    expect(response.status).toBe(200);
    expect(railway.calls).toEqual([]);
  });

  it("is unhealthy when a required variable is missing", () => {
    setRuntime(undefined);
    const saved = { ...process.env };
    delete process.env.RAILWAY_FAKE;
    delete process.env.RAILWAY_SANDBOX_TOKEN;
    try {
      expect(health().status).toBe(500);
    } finally {
      process.env = saved;
      setRuntime(undefined);
    }
  });
});
