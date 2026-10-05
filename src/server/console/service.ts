import type { ConsoleSnapshot, ContainerAction, CreateContainerRequest } from "@/lib/contract";
import { CONTAINER_PORT, IMAGES, LIMITS, OPERATION_ID, SERVICE_PREFIX } from "@/server/config";
import type { RailwayApi, Sandbox, ServiceInstance } from "@/server/railway/api";
import type { RequestBudget } from "@/server/railway/budget";
import { isRailwayError } from "@/server/railway/errors";
import { deriveState, planStart } from "./derive-state";
import { ConsoleError, describeProblem } from "./problems";
import { createSerialQueue } from "./queue";
import type { SandboxReader } from "./reader";
import { ownedInstances, toSnapshot } from "./view";

interface WriteContext {
  sandbox: Sandbox;
  /** This app's containers as Railway listed them when the write reached the front of the queue. */
  owned: ServiceInstance[];
}

interface Dependencies {
  api: RailwayApi;
  reader: SandboxReader;
  budget: RequestBudget;
  mode: ConsoleSnapshot["mode"];
  now?: () => number;
}

/**
 * Runs a mutation. If Railway gave no answer the mutation may or may not have
 * happened, so look at Railway before sending it a second time.
 */
async function settle(mutate: () => Promise<unknown>, tookEffect: () => Promise<boolean>): Promise<void> {
  try {
    await mutate();
  } catch (error) {
    if (!isRailwayError(error, "no_response")) throw error;
    if (await tookEffect()) return;
    await mutate();
  }
}

/** For mutations that are harmless to repeat, so there is nothing to look at first. */
const cannotTell = async () => false;

/**
 * Every use case of the console. It keeps no record of containers: each write
 * starts from a fresh reading of Railway and ends with another.
 */
export class ConsoleService {
  private readonly api: RailwayApi;
  private readonly reader: SandboxReader;
  private readonly budget: RequestBudget;
  private readonly mode: ConsoleSnapshot["mode"];
  private readonly now: () => number;
  private readonly enqueue = createSerialQueue();
  private sweeping = false;

  constructor({ api, reader, budget, mode, now = Date.now }: Dependencies) {
    this.api = api;
    this.reader = reader;
    this.budget = budget;
    this.mode = mode;
    this.now = now;
  }

  async snapshot(unlocked: boolean): Promise<ConsoleSnapshot> {
    const reading = await this.reader.read();
    const snapshot = toSnapshot(reading, {
      now: this.now(),
      unlocked,
      mode: this.mode,
      budget: this.budget.snapshot(),
      readIntervalMs: this.budget.readIntervalMs,
      problem: reading.problem === undefined ? undefined : describeProblem(reading.problem).problem,
    });
    if (snapshot.containers.some((container) => container.state === "expired")) this.sweepInBackground();
    return snapshot;
  }

  /**
   * Idempotent on the operation id. The id becomes the service name, Railway
   * refuses a second service with that name, and a repeat of the request picks
   * up whichever steps the first attempt did not finish.
   */
  async create({ operationId, imageId }: CreateContainerRequest): Promise<void> {
    const image = IMAGES.find((option) => option.id === imageId);
    if (!image) throw new ConsoleError("invalid_request", "That image is not on the allowed list.");
    if (!OPERATION_ID.test(operationId)) throw new ConsoleError("invalid_request", "The operation id must be 8 lowercase letters or digits.");
    const name = `${SERVICE_PREFIX}${operationId}`;

    return this.write(async (context) => {
      let service = context.owned.find((each) => each.name === name);
      if (!service) {
        if (context.owned.length >= LIMITS.maxContainers) {
          throw new ConsoleError("cap_reached", `The limit is ${LIMITS.maxContainers} containers, stopped ones included. Destroy one first.`);
        }
        service = await this.createService(context.sandbox, name, image.image);
      }
      // A repeat of a request that got as far as deploying has nothing left to do, whatever has happened since.
      if (!service.latestDeployment) await this.bringUp(context.sandbox, service);
    });
  }

  start(serviceId: string): Promise<void> {
    return this.write((context) => this.bringUp(context.sandbox, this.permitted(context, serviceId, "start")));
  }

  stop(serviceId: string): Promise<void> {
    return this.write(async (context) => {
      const deployment = this.permitted(context, serviceId, "stop").latestDeployment!;
      await settle(
        () => this.api.stopDeployment(deployment.id),
        async () => (await this.find(serviceId))?.latestDeployment?.deploymentStopped === true,
      );
    });
  }

  destroy(serviceId: string): Promise<void> {
    return this.write((context) => this.remove(context.sandbox, this.permitted(context, serviceId, "destroy")));
  }

  /** Destroys every container past its lifetime. Returns how many it removed. */
  sweepExpired(): Promise<number> {
    let removed = 0;
    return this.write(async (context) => {
      const expired = context.owned.filter((each) => deriveState(each, this.now(), LIMITS.lifetimeMs).state === "expired");
      for (const service of expired) {
        await this.remove(context.sandbox, service);
        removed++;
      }
    }).then(() => removed);
  }

  /**
   * Called once a minute. It calls Railway only when a container it already
   * knows about is due, or when it has not read the sandbox since boot, so an
   * idle app spends no requests.
   */
  async enforceLifetimes(): Promise<void> {
    const known = this.reader.peek() ?? (await this.reader.refresh());
    const due = ownedInstances(known.instances).some((each) => deriveState(each, this.now(), LIMITS.lifetimeMs).state === "expired");
    if (due) await this.sweepExpired();
  }

  private sweepInBackground(): void {
    if (this.sweeping) return;
    this.sweeping = true;
    this.sweepExpired()
      .catch((error) => console.error("[lifetime] sweep failed:", error instanceof Error ? error.message : error))
      .finally(() => (this.sweeping = false));
  }

  /** Runs one write at a time, each starting from what Railway reports now and leaving a fresh reading behind. */
  private write(task: (context: WriteContext) => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      const reading = await this.reader.refresh();
      try {
        await task({ sandbox: reading.sandbox, owned: ownedInstances(reading.instances) });
      } finally {
        await this.reader.refresh().catch(() => undefined);
      }
    });
  }

  /** The named container, if this app owns it and Railway's state permits the action. */
  private permitted(context: WriteContext, serviceId: string, action: ContainerAction): ServiceInstance {
    const service = context.owned.find((each) => each.serviceId === serviceId);
    if (!service) throw new ConsoleError("not_found", "That container is not in the sandbox. It may already have been removed.");
    const availability = deriveState(service, this.now(), LIMITS.lifetimeMs).actions[action];
    if (!availability.allowed) throw new ConsoleError("not_allowed", availability.reason);
    return service;
  }

  private async find(serviceId: string): Promise<ServiceInstance | undefined> {
    const reading = await this.reader.refresh();
    return ownedInstances(reading.instances).find((each) => each.serviceId === serviceId);
  }

  private async createService({ projectId, environmentId }: Sandbox, name: string, image: string): Promise<ServiceInstance> {
    const findByName = async () => ownedInstances((await this.reader.refresh()).instances).find((each) => each.name === name);
    try {
      await settle(
        () => this.api.createService({ projectId, environmentId, name, image }),
        async () => (await findByName()) !== undefined,
      );
    } catch (error) {
      // Another request, or another instance of this app, created it first. That is the outcome we wanted.
      if (!isRailwayError(error, "already_exists")) throw error;
    }
    const service = await findByName();
    if (!service) throw new Error(`Railway accepted ${name} but does not list it`);
    return service;
  }

  /** Makes a container reachable and running: a domain if it has none, then a resume or a deploy. */
  private async bringUp({ environmentId }: Sandbox, service: ServiceInstance): Promise<void> {
    const { serviceId } = service;

    // The domain comes first so the URL is ready when the container is. A second call would add a second domain.
    if (service.domains.length === 0) {
      await settle(
        () => this.api.createDomain({ serviceId, environmentId, targetPort: CONTAINER_PORT }),
        async () => ((await this.find(serviceId))?.domains.length ?? 0) > 0,
      );
    }

    const plan = planStart(service);
    if (plan.kind === "restart") {
      try {
        await settle(
          () => this.api.restartDeployment(plan.deploymentId),
          async () => (await this.find(serviceId))?.latestDeployment?.deploymentStopped === false,
        );
        return;
      } catch (error) {
        // Not seen in the probe, but if Railway will not resume this deployment a fresh deploy still brings it up.
        if (!isRailwayError(error, "invalid_input", "not_found")) throw error;
      }
    }

    // Sleep only applies to deployments created after it is switched on.
    await settle(() => this.api.enableSleep(serviceId, environmentId), cannotTell);
    const previous = service.latestDeployment?.id;
    await settle(
      () => this.api.deploy(serviceId, environmentId),
      async () => {
        const latest = (await this.find(serviceId))?.latestDeployment?.id;
        return latest !== undefined && latest !== previous;
      },
    );
  }

  private async remove({ environmentId }: Sandbox, service: ServiceInstance): Promise<void> {
    const gone = async () => (await this.find(service.serviceId)) === undefined;
    try {
      await settle(() => this.api.deleteService(service.serviceId, environmentId), gone);
    } catch (error) {
      // Railway answers "Not Authorized" for a service that no longer exists, so check before believing it.
      if (isRailwayError(error, "unauthorized", "not_found") && (await gone())) return;
      throw error;
    }
  }
}
