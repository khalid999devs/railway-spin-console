import type { ActionAvailability, ContainerAction, ContainerState, ReportedState } from "@/lib/contract";
import type { ServiceInstance } from "@/server/railway/api";

export interface DerivedState {
  state: ContainerState;
  transitional: boolean;
  actions: Record<ContainerAction, ActionAvailability>;
  reported: ReportedState;
}

const STARTING_STATUSES = new Set(["INITIALIZING", "BUILDING", "DEPLOYING", "QUEUED", "WAITING"]);
const INSTANCE_STARTING = new Set(["INITIALIZING", "CREATED", "RESTARTING"]);
const INSTANCE_DOWN = new Set(["EXITED", "STOPPED", "REMOVED"]);
const TRANSITIONAL: ReadonlySet<ContainerState> = new Set(["starting", "stopping", "removing", "expired"]);

export const expiresAt = (instance: ServiceInstance, lifetimeMs: number) => Date.parse(instance.createdAt) + lifetimeMs;

/**
 * Turns what Railway reports about one service into the state the app shows
 * and the actions it permits. Pure: the same input always gives the same
 * answer, and nothing here remembers a previous call.
 *
 * The order matters. `deploymentStopped` is true for a deployment that is
 * still starting and for one that is asleep, and `status` stays SUCCESS after
 * a stop, so `status` is read first and the flag only when status is SUCCESS.
 */
export function deriveState(instance: ServiceInstance, now: number, lifetimeMs: number): DerivedState {
  const deployment = instance.latestDeployment;
  const reported: ReportedState = {
    status: deployment?.status ?? null,
    deploymentStopped: deployment?.deploymentStopped ?? null,
    instances: deployment?.instances.map((each) => each.status) ?? [],
  };
  const state = now >= expiresAt(instance, lifetimeMs) ? "expired" : stateOf(reported);
  return { state, transitional: TRANSITIONAL.has(state), actions: actionsFor(state), reported };
}

function stateOf({ status, deploymentStopped, instances }: ReportedState): ContainerState {
  if (status === null) return "idle";
  if (STARTING_STATUSES.has(status)) return "starting";
  if (status === "SLEEPING") return "sleeping";
  if (status === "CRASHED") return "crashed";
  if (status === "FAILED") return "failed";
  if (status === "REMOVING") return "removing";
  if (status === "REMOVED") return "stopped";
  if (status !== "SUCCESS") return "unknown";

  if (deploymentStopped) return instances.every((each) => INSTANCE_DOWN.has(each)) ? "stopped" : "stopping";
  if (instances.includes("RUNNING")) return "running";
  if (instances.includes("CRASHED")) return "crashed";
  if (instances.every((each) => INSTANCE_STARTING.has(each))) return "starting";
  return "unknown";
}

const BEING_REMOVED = "It is being removed.";
const EXPIRED = "It is past its lifetime and is being destroyed.";
const UNRECOGNISED = "Railway reports a state this app does not recognise.";

/** For each state, the actions that are refused and why. An action not listed is allowed. */
const REFUSALS: Record<ContainerState, Partial<Record<ContainerAction, string>>> = {
  idle: { stop: "It has not been deployed." },
  starting: { start: "It is already starting.", stop: "Wait until it is running." },
  running: { start: "It is already running." },
  stopping: { start: "Wait until it has stopped.", stop: "It is already stopping." },
  stopped: { stop: "It is already stopped." },
  sleeping: {
    start: "Railway will not restart a sleeping container. Open its URL to wake it.",
    stop: "Railway will not stop a sleeping container. Open its URL to wake it.",
  },
  crashed: { stop: "Nothing is running." },
  failed: { stop: "Nothing is running." },
  removing: { start: BEING_REMOVED, stop: BEING_REMOVED, destroy: BEING_REMOVED },
  expired: { start: EXPIRED, stop: EXPIRED, destroy: EXPIRED },
  unknown: { start: UNRECOGNISED, stop: UNRECOGNISED },
};

function actionsFor(state: ContainerState): Record<ContainerAction, ActionAvailability> {
  const refused = REFUSALS[state];
  const availability = (action: ContainerAction): ActionAvailability =>
    refused[action] ? { allowed: false, reason: refused[action] } : { allowed: true };
  return { start: availability("start"), stop: availability("stop"), destroy: availability("destroy") };
}

export type StartPlan = { kind: "restart"; deploymentId: string } | { kind: "deploy" };

/**
 * A stopped deployment can be resumed in about a second with the same
 * instance; anything else (never deployed, crashed, failed, removed) needs a
 * fresh deploy.
 */
export function planStart(instance: ServiceInstance): StartPlan {
  const deployment = instance.latestDeployment;
  if (deployment?.status === "SUCCESS" && deployment.deploymentStopped) return { kind: "restart", deploymentId: deployment.id };
  return { kind: "deploy" };
}
