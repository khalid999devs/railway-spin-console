import type { ApiProblem, ConsoleSnapshot, ContainerView } from "@/lib/contract";
import { IMAGES, LIMITS, OWNED_NAME } from "@/server/config";
import type { ServiceInstance } from "@/server/railway/api";
import type { BudgetSnapshot } from "@/server/railway/budget";
import { deriveState, expiresAt } from "./derive-state";
import type { SandboxReading } from "./reader";

const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 15_000;

/** The services this app created, oldest first so cards keep their place on screen. */
export function ownedInstances(instances: ServiceInstance[]): ServiceInstance[] {
  return instances.filter((instance) => OWNED_NAME.test(instance.name)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function toView(instance: ServiceInstance, now: number): ContainerView {
  const derived = deriveState(instance, now, LIMITS.lifetimeMs);
  return {
    id: instance.serviceId,
    name: instance.name,
    image: instance.image,
    url: instance.domains[0] ? `https://${instance.domains[0]}` : null,
    createdAt: instance.createdAt,
    expiresAt: new Date(expiresAt(instance, LIMITS.lifetimeMs)).toISOString(),
    ...derived,
  };
}

interface SnapshotContext {
  now: number;
  unlocked: boolean;
  mode: ConsoleSnapshot["mode"];
  budget: BudgetSnapshot;
  /** How long one read token takes to refill; idle polling stays at half that pace or slower. */
  readIntervalMs: number;
  /** True for a short while after any write, when Railway may not yet report its effect. */
  settling: boolean;
  problem?: ApiProblem;
}

export function toSnapshot(reading: SandboxReading, context: SnapshotContext): ConsoleSnapshot {
  const containers = ownedInstances(reading.instances).map((instance) => toView(instance, context.now));
  const active = context.settling || containers.some((container) => container.transitional);
  return {
    containers,
    limits: { maxContainers: LIMITS.maxContainers, lifetimeMinutes: LIMITS.lifetimeMs / 60_000, images: [...IMAGES] },
    budget: context.budget,
    sandbox: { project: reading.sandbox.projectName, environment: reading.sandbox.environmentName },
    asOf: new Date(reading.asOf).toISOString(),
    serverTime: new Date(context.now).toISOString(),
    pollAfterMs: active ? ACTIVE_POLL_MS : Math.max(IDLE_POLL_MS, Math.round(2 * context.readIntervalMs)),
    unlocked: context.unlocked,
    mode: context.mode,
    problem: context.problem,
  };
}
