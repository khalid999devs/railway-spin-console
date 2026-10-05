import { describe, expect, it } from "vitest";
import type { ContainerAction, ContainerState } from "@/lib/contract";
import type { ServiceInstance } from "@/server/railway/api";
import { recordedSnapshots } from "../../../tests/support/probe";
import { deriveState, planStart } from "./derive-state";

const LIFETIME_MS = 30 * 60_000;
const CREATED_AT = Date.parse("2026-10-05T20:00:00.000Z");
const SOON_AFTER = CREATED_AT + 60_000;

function instance(status: string | null, deploymentStopped = false, instances: string[] = []): ServiceInstance {
  return {
    serviceId: "service-1",
    name: "spin-abc12345",
    createdAt: new Date(CREATED_AT).toISOString(),
    image: "nginx:alpine",
    domains: ["spin-abc12345-production.up.railway.app"],
    latestDeployment:
      status === null
        ? null
        : {
            id: "deployment-1",
            status,
            deploymentStopped,
            statusUpdatedAt: null,
            instances: instances.map((each, index) => ({ id: `instance-${index}`, status: each })),
          },
  };
}

const stateOf = (status: string | null, stopped?: boolean, instances?: string[]) =>
  deriveState(instance(status, stopped, instances), SOON_AFTER, LIFETIME_MS).state;

describe("deriveState", () => {
  it.each<[string, string | null, boolean, string[], ContainerState]>([
    ["created, never deployed", null, false, [], "idle"],
    ["deploy just accepted", "INITIALIZING", true, [], "starting"],
    ["deploying, instance initialising", "DEPLOYING", true, ["INITIALIZING"], "starting"],
    ["deploying, instance already running", "DEPLOYING", true, ["RUNNING"], "starting"],
    ["building", "BUILDING", false, [], "starting"],
    ["queued", "QUEUED", false, [], "starting"],
    ["waiting", "WAITING", false, [], "starting"],
    ["succeeded, instance not up yet", "SUCCESS", false, [], "starting"],
    ["succeeded, instance restarting", "SUCCESS", false, ["RESTARTING"], "starting"],
    ["up", "SUCCESS", false, ["RUNNING"], "running"],
    ["up, one of two replicas", "SUCCESS", false, ["RUNNING", "CRASHED"], "running"],
    ["stop registered, instance still up", "SUCCESS", true, ["RUNNING"], "stopping"],
    ["stopped", "SUCCESS", true, ["EXITED"], "stopped"],
    ["stopped, instances gone", "SUCCESS", true, [], "stopped"],
    ["deployment removed", "REMOVED", true, ["REMOVED"], "stopped"],
    ["asleep", "SLEEPING", true, ["RUNNING"], "sleeping"],
    ["crashed deployment", "CRASHED", false, ["CRASHED"], "crashed"],
    ["succeeded, instance crashed", "SUCCESS", false, ["CRASHED"], "crashed"],
    ["failed", "FAILED", false, [], "failed"],
    ["being removed", "REMOVING", true, ["EXITED"], "removing"],
    ["succeeded, not stopped, instance exited", "SUCCESS", false, ["EXITED"], "unknown"],
    ["needs approval", "NEEDS_APPROVAL", false, [], "unknown"],
    ["skipped", "SKIPPED", false, [], "unknown"],
    ["a status Railway adds later", "HIBERNATING", false, ["RUNNING"], "unknown"],
  ])("%s -> %s", (_case, status, stopped, instances, expected) => {
    expect(stateOf(status, stopped, instances)).toBe(expected);
  });

  describe("the traps the probe found", () => {
    it("does not read SUCCESS as running once the deployment is stopped", () => {
      expect(stateOf("SUCCESS", true, ["EXITED"])).toBe("stopped");
    });

    it("does not read deploymentStopped as stopped while the deployment is starting", () => {
      expect(stateOf("DEPLOYING", true, ["CREATED"])).toBe("starting");
    });

    it("does not read a sleeping deployment as stopped or as running", () => {
      expect(stateOf("SLEEPING", true, ["RUNNING"])).toBe("sleeping");
    });

    it("does not call it running while the instance is up but the deployment is not", () => {
      expect(stateOf("DEPLOYING", true, ["RUNNING"])).toBe("starting");
    });
  });

  it("replays the recorded lifecycle run in the order Railway reported it", async () => {
    const snapshots = await recordedSnapshots("lifecycle");
    const seen = snapshots.map(({ step, instance }) => {
      const at = Date.parse(instance.createdAt) + 1000;
      return `${step}: ${deriveState(instance, at, LIFETIME_MS).state}`;
    });

    expect(seen).toEqual([
      "afterCreate: idle",
      "afterUpdate: idle",
      "toRunning: starting",
      "toRunning: starting",
      "toRunning: starting",
      "toRunning: starting",
      "toRunning: running",
      "afterDomain: running",
      // Railway still reports running for about a second after accepting a stop.
      "toStopped: running",
      "toStopped: stopped",
      "restartToRunning: running",
      "toStoppedAgain: running",
      "toStoppedAgain: stopped",
      "redeployToRunning: starting",
      "redeployToRunning: starting",
      "redeployToRunning: starting",
      "redeployToRunning: running",
      "toSleeping: running",
      "toSleeping: sleeping",
      "afterWake: running",
    ]);
  });

  it("passes Railway's own values through untouched", () => {
    const { reported } = deriveState(instance("SLEEPING", true, ["RUNNING"]), SOON_AFTER, LIFETIME_MS);
    expect(reported).toEqual({ status: "SLEEPING", deploymentStopped: true, instances: ["RUNNING"] });
  });

  describe("lifetime", () => {
    it("is expired from the moment the lifetime has passed, whatever Railway reports", () => {
      const running = instance("SUCCESS", false, ["RUNNING"]);
      expect(deriveState(running, CREATED_AT + LIFETIME_MS - 1, LIFETIME_MS).state).toBe("running");
      expect(deriveState(running, CREATED_AT + LIFETIME_MS, LIFETIME_MS).state).toBe("expired");
    });

    it("permits nothing on an expired container", () => {
      const { actions } = deriveState(instance("SUCCESS", false, ["RUNNING"]), CREATED_AT + LIFETIME_MS, LIFETIME_MS);
      expect(Object.values(actions).every((action) => !action.allowed)).toBe(true);
    });
  });

  describe("allowed actions", () => {
    const allowed = (status: string | null, stopped?: boolean, instances?: string[]) => {
      const { actions } = deriveState(instance(status, stopped, instances), SOON_AFTER, LIFETIME_MS);
      return (Object.keys(actions) as ContainerAction[]).filter((action) => actions[action].allowed);
    };

    it.each<[ContainerState, string | null, boolean, string[], ContainerAction[]]>([
      ["idle", null, false, [], ["start", "destroy"]],
      ["starting", "DEPLOYING", true, [], ["destroy"]],
      ["running", "SUCCESS", false, ["RUNNING"], ["stop", "destroy"]],
      ["stopping", "SUCCESS", true, ["RUNNING"], ["destroy"]],
      ["stopped", "SUCCESS", true, ["EXITED"], ["start", "destroy"]],
      ["sleeping", "SLEEPING", true, ["RUNNING"], ["destroy"]],
      ["crashed", "CRASHED", false, [], ["start", "destroy"]],
      ["failed", "FAILED", false, [], ["start", "destroy"]],
      ["removing", "REMOVING", true, [], []],
      ["unknown", "SKIPPED", false, [], ["destroy"]],
    ])("%s allows exactly %j", (_state, status, stopped, instances, expected) => {
      expect(allowed(status, stopped, instances)).toEqual(expected);
    });

    it("gives a reason for every refusal", () => {
      const { actions } = deriveState(instance("SLEEPING", true, ["RUNNING"]), SOON_AFTER, LIFETIME_MS);
      expect(actions.stop).toEqual({ allowed: false, reason: expect.stringContaining("sleeping") });
      expect(actions.start).toEqual({ allowed: false, reason: expect.stringContaining("sleeping") });
    });
  });

  it("polls fast only while Railway is expected to change the state by itself", () => {
    const transitional = (status: string | null, stopped?: boolean, instances?: string[]) =>
      deriveState(instance(status, stopped, instances), SOON_AFTER, LIFETIME_MS).transitional;

    expect(transitional("DEPLOYING", true)).toBe(true);
    expect(transitional("SUCCESS", true, ["RUNNING"])).toBe(true);
    expect(transitional("REMOVING", true)).toBe(true);
    expect(transitional("SUCCESS", false, ["RUNNING"])).toBe(false);
    expect(transitional("SUCCESS", true, ["EXITED"])).toBe(false);
    expect(transitional("SLEEPING", true, ["RUNNING"])).toBe(false);
  });
});

describe("planStart", () => {
  it("resumes a stopped deployment instead of deploying again", () => {
    expect(planStart(instance("SUCCESS", true, ["EXITED"]))).toEqual({ kind: "restart", deploymentId: "deployment-1" });
  });

  it.each<[string, string | null]>([
    ["never deployed", null],
    ["crashed", "CRASHED"],
    ["failed", "FAILED"],
    ["removed", "REMOVED"],
  ])("deploys afresh when %s", (_case, status) => {
    expect(planStart(instance(status, true))).toEqual({ kind: "deploy" });
  });
});
