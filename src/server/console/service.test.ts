import { beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayError } from "@/server/railway/errors";
import { create, makeConsole, MINUTE, SECOND } from "../../../tests/support/console";
import { ConsoleError } from "./problems";

let ctx: ReturnType<typeof makeConsole>;
beforeEach(() => {
  ctx = makeConsole();
});

/** Lets the read cache age out, then reads what the screen would show. */
async function screen() {
  ctx.clock.advance(2 * SECOND);
  return (await ctx.service.snapshot(true)).containers;
}

/** Creates a container and waits for Railway to report it running. */
async function running(operationId: string) {
  await ctx.service.create(create(operationId));
  ctx.clock.advance(10 * SECOND);
  const container = (await screen()).find((each) => each.name === `spin-${operationId}`)!;
  expect(container.state).toBe("running");
  return container;
}

const refusal = (promise: Promise<unknown>) => promise.then(() => expect.unreachable("expected a refusal"), (error: ConsoleError) => error);

describe("create", () => {
  it("creates the service, its domain, sleep and a deployment, in that order", async () => {
    await ctx.service.create(create("aaaaaaaa", "caddy"));

    expect(ctx.mutations()).toEqual(["createService", "createDomain", "enableSleep", "deploy"]);
    const [container] = await screen();
    expect(container).toMatchObject({
      name: "spin-aaaaaaaa",
      image: "caddy:alpine",
      url: "https://spin-aaaaaaaa-production.up.railway.app",
      state: "starting",
    });
  });

  it("is shown as running only once Railway reports it", async () => {
    await ctx.service.create(create("aaaaaaaa"));
    ctx.clock.advance(5 * SECOND);
    expect((await screen())[0]).toMatchObject({ state: "starting", reported: { status: "DEPLOYING", instances: ["RUNNING"] } });
    ctx.clock.advance(5 * SECOND);
    expect((await screen())[0].state).toBe("running");
  });

  it("does nothing the second time the same operation id arrives", async () => {
    await ctx.service.create(create("aaaaaaaa"));
    const before = ctx.mutations().length;

    await ctx.service.create(create("aaaaaaaa"));

    expect(ctx.mutations()).toHaveLength(before);
    expect(await screen()).toHaveLength(1);
  });

  it("makes one container from a double click", async () => {
    await Promise.all([ctx.service.create(create("aaaaaaaa")), ctx.service.create(create("aaaaaaaa"))]);

    expect(ctx.mutations().filter((call) => call === "createService")).toHaveLength(1);
    expect(ctx.mutations().filter((call) => call === "deploy")).toHaveLength(1);
    expect(await screen()).toHaveLength(1);
  });

  it("does not restart a container when a stale repeat of its create arrives after a stop", async () => {
    const container = await running("aaaaaaaa");
    await ctx.service.stop(container.id);
    ctx.clock.advance(5 * SECOND);

    await ctx.service.create(create("aaaaaaaa"));

    expect((await screen())[0].state).toBe("stopped");
  });

  it("finishes a create that was interrupted before the deploy", async () => {
    ctx.railway.failNext("deploy", new RailwayError("unknown", "Deploy is unavailable", { operation: "Deploy" }));
    await expect(ctx.service.create(create("aaaaaaaa"))).rejects.toThrow("Deploy is unavailable");
    expect((await screen())[0].state).toBe("idle");

    await ctx.service.create(create("aaaaaaaa"));

    const calls = ctx.mutations();
    expect(calls.filter((call) => call === "createService")).toHaveLength(1);
    expect(calls.filter((call) => call === "createDomain")).toHaveLength(1);
    expect((await screen())[0].state).toBe("starting");
  });

  it("adopts the service when another instance of the app created it first", async () => {
    const createService = ctx.railway.createService.bind(ctx.railway);
    vi.spyOn(ctx.railway, "createService").mockImplementationOnce(async (input) => {
      await createService(input);
      return createService(input);
    });

    await ctx.service.create(create("aaaaaaaa"));

    const containers = await screen();
    expect(containers).toHaveLength(1);
    expect(containers[0].state).toBe("starting");
  });

  it.each([
    ["an image that is not on the list", create("aaaaaaaa", "traefik/whoami")],
    ["a free-text image", create("aaaaaaaa", "evil/miner:latest")],
    ["an operation id that could change the service name", create("../../etc")],
    ["an operation id of the wrong length", create("abc")],
  ])("refuses %s without calling Railway", async (_case, request) => {
    expect(await refusal(ctx.service.create(request))).toMatchObject({ code: "invalid_request" });
    expect(ctx.railway.calls).toEqual([]);
  });
});

describe("when Railway does not answer", () => {
  it.each(["createService", "createDomain", "deploy"] as const)("does not repeat %s once it sees the call took effect", async (method) => {
    ctx.railway.loseResponseOf(method);

    await ctx.service.create(create("aaaaaaaa"));

    expect(ctx.mutations().filter((call) => call === method)).toHaveLength(1);
    const [container, ...others] = await screen();
    expect(others).toEqual([]);
    expect(container.state).toBe("starting");
    expect(container.url).toBe("https://spin-aaaaaaaa-production.up.railway.app");
  });

  it("repeats a call that had no effect, once", async () => {
    ctx.railway.failNext("deploy", new RailwayError("no_response", "Railway did not answer", { operation: "Deploy" }));

    await ctx.service.create(create("aaaaaaaa"));

    expect(ctx.mutations().filter((call) => call === "deploy")).toHaveLength(2);
    expect((await screen())[0].state).toBe("starting");
  });

  it("reports the failure when the repeat goes unanswered too", async () => {
    const lost = () => new RailwayError("no_response", "Railway did not answer", { operation: "Deploy" });
    ctx.railway.failNext("deploy", lost());
    ctx.railway.failNext("deploy", lost());

    await expect(ctx.service.create(create("aaaaaaaa"))).rejects.toMatchObject({ kind: "no_response" });
    expect((await screen())[0].state).toBe("idle");
  });

  it("still stops and deletes when those answers are lost", async () => {
    const container = await running("aaaaaaaa");

    ctx.railway.loseResponseOf("stopDeployment");
    await ctx.service.stop(container.id);
    // Railway takes a moment to report a stop, so the check cannot see the first one and it is sent again.
    // That is safe: in the probe a stop on a stopped deployment returned true and changed nothing.
    expect(ctx.mutations().filter((call) => call === "stopDeployment")).toHaveLength(2);
    expect((await screen())[0].state).toBe("stopped");

    ctx.railway.loseResponseOf("deleteService");
    await ctx.service.destroy(container.id);
    expect(ctx.mutations().filter((call) => call === "deleteService")).toHaveLength(1);
    expect(await screen()).toEqual([]);
  });
});

describe("the cap", () => {
  it("lets exactly three of four simultaneous creates through", async () => {
    const results = await Promise.allSettled(["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd"].map((id) => ctx.service.create(create(id))));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "cap_reached" } });
    expect(await screen()).toHaveLength(3);
  });

  it("counts stopped containers", async () => {
    for (const id of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) await ctx.service.create(create(id));
    ctx.clock.advance(10 * SECOND);
    for (const container of await screen()) await ctx.service.stop(container.id);

    expect(await refusal(ctx.service.create(create("dddddddd")))).toMatchObject({ code: "cap_reached" });
  });

  it("frees a place when a container is destroyed", async () => {
    for (const id of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) await ctx.service.create(create(id));
    await ctx.service.destroy((await screen())[0].id);

    await ctx.service.create(create("dddddddd"));
    expect(await screen()).toHaveLength(3);
  });

  it("does not count services this app did not create", async () => {
    ctx.railway.addForeignService("postgres");
    ctx.railway.addForeignService("spin-probe-leftover");
    for (const id of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) await ctx.service.create(create(id));
    expect(await screen()).toHaveLength(3);
  });
});

describe("stop and start again", () => {
  it("shows what Railway reports after a stop: still running for a moment, then stopped", async () => {
    const container = await running("aaaaaaaa");

    await ctx.service.stop(container.id);
    expect((await ctx.service.snapshot(true)).containers[0].state).toBe("running");

    expect((await screen())[0]).toMatchObject({ state: "stopped", reported: { status: "SUCCESS", deploymentStopped: true } });
  });

  it("keeps the service and its URL when stopped", async () => {
    const container = await running("aaaaaaaa");
    await ctx.service.stop(container.id);
    const [stopped] = await screen();
    expect(stopped).toMatchObject({ id: container.id, url: container.url });
  });

  it("resumes a stopped container with a restart, not a new deploy or a second domain", async () => {
    const container = await running("aaaaaaaa");
    await ctx.service.stop(container.id);
    await screen();
    const before = ctx.mutations().length;

    await ctx.service.start(container.id);

    expect(ctx.mutations().slice(before)).toEqual(["restartDeployment"]);
    expect((await screen())[0].state).toBe("running");
  });

  it("deploys afresh if Railway will not resume the deployment", async () => {
    const container = await running("aaaaaaaa");
    await ctx.service.stop(container.id);
    await screen();
    const before = ctx.mutations().length;
    ctx.railway.failNext("restartDeployment", new RailwayError("invalid_input", "Deployment is not restartable", { operation: "Restart" }));

    await ctx.service.start(container.id);

    expect(ctx.mutations().slice(before)).toEqual(["restartDeployment", "enableSleep", "deploy"]);
    expect((await screen())[0].state).toBe("starting");
  });

  it.each([
    ["stop", "starting", "Wait until it is running."],
    ["start", "starting", "It is already starting."],
  ] as const)("refuses %s while %s, with the reason and without calling Railway", async (action, _state, reason) => {
    await ctx.service.create(create("aaaaaaaa"));
    const [container] = await screen();
    const before = ctx.mutations().length;

    expect(await refusal(ctx.service[action](container.id))).toMatchObject({ code: "not_allowed", message: reason });
    expect(ctx.mutations()).toHaveLength(before);
  });

  it("refuses to stop a sleeping container, as Railway would, and sees it wake on traffic", async () => {
    const container = await running("aaaaaaaa");
    ctx.clock.advance(9 * MINUTE);
    expect((await screen())[0].state).toBe("sleeping");

    expect(await refusal(ctx.service.stop(container.id))).toMatchObject({ code: "not_allowed" });
    expect(ctx.mutations()).not.toContain("stopDeployment");

    ctx.railway.receiveTraffic(container.id);
    expect((await screen())[0].state).toBe("running");
  });
});

describe("destroy", () => {
  it("deletes the service", async () => {
    const container = await running("aaaaaaaa");
    await ctx.service.destroy(container.id);
    expect(await screen()).toEqual([]);
  });

  it("never touches a service this app did not create, even when given its id", async () => {
    const database = ctx.railway.addForeignService("postgres");
    const lookalike = ctx.railway.addForeignService("spin-doctor");

    for (const id of [database, lookalike]) {
      expect(await refusal(ctx.service.destroy(id))).toMatchObject({ code: "not_found" });
      expect(await refusal(ctx.service.stop(id))).toMatchObject({ code: "not_found" });
      expect(await refusal(ctx.service.start(id))).toMatchObject({ code: "not_found" });
    }
    expect(ctx.mutations()).toEqual([]);
    expect(await ctx.railway.listInstances()).toHaveLength(2);
  });

  it("does not show services it did not create", async () => {
    ctx.railway.addForeignService("postgres");
    expect(await screen()).toEqual([]);
  });

  it("refuses an id that is not in the sandbox", async () => {
    expect(await refusal(ctx.service.destroy("service-999"))).toMatchObject({ code: "not_found" });
    expect(ctx.mutations()).toEqual([]);
  });

  it("treats Railway's \"Not Authorized\" as success when the service is in fact gone", async () => {
    const container = await running("aaaaaaaa");
    const deleteService = ctx.railway.deleteService.bind(ctx.railway);
    vi.spyOn(ctx.railway, "deleteService").mockImplementationOnce(async (id) => {
      await deleteService(id);
      return deleteService(id);
    });

    await ctx.service.destroy(container.id);
    expect(await screen()).toEqual([]);
  });

  it("reports Railway's \"Not Authorized\" when the service is still there", async () => {
    const container = await running("aaaaaaaa");
    ctx.railway.failNext("deleteService", new RailwayError("unauthorized", "Not Authorized", { operation: "ServiceDelete", traceId: "42" }));

    await expect(ctx.service.destroy(container.id)).rejects.toMatchObject({ kind: "unauthorized", traceId: "42" });
    expect(await screen()).toHaveLength(1);
  });
});

describe("lifetime", () => {
  it("marks a container expired at 30 minutes and permits nothing on it", async () => {
    const container = await running("aaaaaaaa");
    expect(Date.parse(container.expiresAt) - Date.parse(container.createdAt)).toBe(30 * MINUTE);

    ctx.clock.advance(30 * MINUTE);
    const [expired] = (await ctx.service.snapshot(true)).containers;

    expect(expired.state).toBe("expired");
    expect(Object.values(expired.actions).map((action) => action.allowed)).toEqual([false, false, false]);
  });

  it("destroys expired containers on the timer, and only those", async () => {
    await ctx.service.create(create("aaaaaaaa"));
    ctx.clock.advance(20 * MINUTE);
    await ctx.service.create(create("bbbbbbbb"));
    ctx.clock.advance(11 * MINUTE);

    await ctx.service.enforceLifetimes();

    expect((await screen()).map((each) => each.name)).toEqual(["spin-bbbbbbbb"]);
  });

  it("spends no Railway requests on the timer while nothing is due", async () => {
    await ctx.service.create(create("aaaaaaaa"));
    const before = ctx.railway.calls.length;

    for (let minute = 0; minute < 29; minute++) {
      ctx.clock.advance(MINUTE);
      await ctx.service.enforceLifetimes();
    }

    expect(ctx.railway.calls).toHaveLength(before);
  });

  it("reads the sandbox once after a restart, then destroys what expired while the app was down", async () => {
    await ctx.service.create(create("aaaaaaaa"));
    ctx.clock.advance(45 * MINUTE);
    const restarted = ctx.connect();

    await restarted.service.enforceLifetimes();

    expect(await ctx.railway.listInstances()).toEqual([]);
  });

  it("starts a sweep when a visitor's read finds an expired container", async () => {
    await ctx.service.create(create("aaaaaaaa"));
    ctx.clock.advance(31 * MINUTE);

    expect((await ctx.service.snapshot(false)).containers[0].state).toBe("expired");
    await vi.waitFor(() => expect(ctx.mutations()).toContain("deleteService"));
  });

  it("never expires a service it did not create", async () => {
    ctx.railway.addForeignService("postgres");
    ctx.clock.advance(24 * 60 * MINUTE);
    await ctx.service.enforceLifetimes();
    expect(await ctx.railway.listInstances()).toHaveLength(1);
  });
});

describe("Railway as the only source of truth", () => {
  it("shows the same containers after an app restart", async () => {
    await running("aaaaaaaa");
    const restarted = ctx.connect();
    expect((await restarted.service.snapshot(false)).containers).toMatchObject([{ name: "spin-aaaaaaaa", state: "running" }]);
  });

  it("drops a container that was deleted in Railway's dashboard", async () => {
    const container = await running("aaaaaaaa");
    await ctx.railway.deleteService(container.id);

    expect(await screen()).toEqual([]);
    expect(await refusal(ctx.service.stop(container.id))).toMatchObject({ code: "not_found" });
  });

  it("follows a stop made in Railway's dashboard", async () => {
    await running("aaaaaaaa");
    const [instance] = await ctx.railway.listInstances();
    await ctx.railway.stopDeployment(instance.latestDeployment!.id);
    ctx.clock.advance(5 * SECOND);

    expect((await screen())[0].state).toBe("stopped");
  });
});

describe("snapshot", () => {
  it("tells the browser to poll fast only during a transition", async () => {
    expect((await ctx.service.snapshot(true)).pollAfterMs).toBe(15_000);
    await ctx.service.create(create("aaaaaaaa"));
    expect((await ctx.service.snapshot(true)).pollAfterMs).toBe(2000);
    ctx.clock.advance(30 * SECOND);
    expect((await ctx.service.snapshot(true)).pollAfterMs).toBe(15_000);
  });

  it("keeps polling fast after a stop, while Railway still reports running", async () => {
    const container = await running("aaaaaaaa");
    ctx.clock.advance(30 * SECOND);

    await ctx.service.stop(container.id);
    const afterStop = await ctx.service.snapshot(true);
    expect(afterStop.containers[0].state).toBe("running");
    expect(afterStop.pollAfterMs).toBe(2000);

    ctx.clock.advance(30 * SECOND);
    expect((await ctx.service.snapshot(true)).pollAfterMs).toBe(15_000);
  });

  it("reports the limits, the image list, the sandbox and the request budget", async () => {
    const snapshot = await ctx.service.snapshot(false);
    expect(snapshot).toMatchObject({
      limits: { maxContainers: 3, lifetimeMinutes: 30 },
      sandbox: { environment: "production" },
      budget: { limit: 1000, used: 2 },
      unlocked: false,
      mode: "fake",
    });
    expect(snapshot.limits.images.map((image) => image.image)).toEqual(["nginx:alpine", "httpd:alpine", "caddy:alpine"]);
  });
});
