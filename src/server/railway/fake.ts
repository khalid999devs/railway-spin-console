import type { Deployment, RailwayApi, Sandbox, ServiceInstance } from "./api";
import type { RequestBudget } from "./budget";
import { RailwayError } from "./errors";

/** Timings taken from the probe (docs/api-findings.md), rounded. */
export const OBSERVED_TIMINGS = { deployMs: 8_000, stopMs: 1_500, sleepAfterMs: 8 * 60_000 };

/** What a starting deployment reported, by milliseconds since the deploy call. */
const DEPLOY_TIMELINE: { fromMs: number; status: string; instances: string[] }[] = [
  { fromMs: 0, status: "INITIALIZING", instances: [] },
  { fromMs: 1_500, status: "DEPLOYING", instances: ["INITIALIZING"] },
  { fromMs: 2_800, status: "DEPLOYING", instances: ["CREATED"] },
  { fromMs: 4_200, status: "DEPLOYING", instances: ["RUNNING"] },
];

type Method = Exclude<keyof RailwayApi, "identify">;

interface FakeDeployment {
  id: string;
  instanceId: string;
  deployedAt: number;
  sleeps: boolean;
  /** When the last stop takes effect; null while no stop is pending or in force. */
  stoppedFrom: number | null;
  lastTrafficAt: number;
}

interface FakeService {
  id: string;
  name: string;
  image: string;
  createdAt: number;
  sleepEnabled: boolean;
  domains: string[];
  deployment: FakeDeployment | null;
}

interface FakeOptions {
  now?: () => number;
  budget?: RequestBudget;
  timings?: Partial<typeof OBSERVED_TIMINGS>;
}

/**
 * An in-memory Railway that behaves the way the probe saw the real one
 * behave, including the parts that surprise: a new deployment reads
 * `deploymentStopped: true`, a stopped one keeps `status: SUCCESS`, a second
 * domain call adds a second domain, and a sleeping deployment refuses stop
 * and restart.
 *
 * Nothing runs on a timer. Each deployment stores when things were asked of
 * it, and its state is computed from the clock at read time, so tests move a
 * fake clock instead of waiting.
 */
export class FakeRailway implements RailwayApi {
  readonly sandbox: Sandbox = {
    projectId: "fake-project",
    environmentId: "fake-environment",
    projectName: "spin-sandbox (fake)",
    environmentName: "production",
  };
  /** Every call made, in order, for tests to assert on. */
  readonly calls: Method[] = [];

  private readonly now: () => number;
  private readonly budget?: RequestBudget;
  private readonly timings: typeof OBSERVED_TIMINGS;
  private readonly services = new Map<string, FakeService>();
  private readonly faults = new Map<Method, ("lost_response" | RailwayError)[]>();
  private sequence = 0;

  constructor({ now = Date.now, budget, timings }: FakeOptions = {}) {
    this.now = now;
    this.budget = budget;
    this.timings = { ...OBSERVED_TIMINGS, ...timings };
    budget?.observePolicy({ limit: 1000, windowMs: 3_600_000 });
  }

  async identify() {
    this.budget?.record();
    return this.sandbox;
  }

  listInstances() {
    return this.call("listInstances", () => [...this.services.values()].map((service) => this.view(service)));
  }

  createService({ name, image }: { name: string; image: string }) {
    return this.call("createService", () => {
      if ([...this.services.values()].some((service) => service.name === name)) {
        throw this.refusal("already_exists", "createService", `A service named "${name}" already exists in this project`);
      }
      const id = this.nextId("service");
      this.services.set(id, { id, name, image, createdAt: this.now(), sleepEnabled: false, domains: [], deployment: null });
      return { id };
    });
  }

  createDomain({ serviceId }: { serviceId: string }) {
    return this.call("createDomain", () => {
      const service = this.service(serviceId, "createDomain");
      const suffix = service.domains.length === 0 ? "" : `-${this.nextId("d")}`;
      const domain = `${service.name}-production${suffix}.up.railway.app`;
      service.domains.push(domain);
      return { domain };
    });
  }

  enableSleep(serviceId: string) {
    return this.call("enableSleep", () => {
      this.service(serviceId, "enableSleep").sleepEnabled = true;
    });
  }

  deploy(serviceId: string) {
    return this.call("deploy", () => {
      const service = this.service(serviceId, "deploy");
      const deployedAt = this.now();
      service.deployment = {
        id: this.nextId("deployment"),
        instanceId: this.nextId("instance"),
        deployedAt,
        // Sleep applies only to deployments created after it was switched on.
        sleeps: service.sleepEnabled,
        stoppedFrom: null,
        lastTrafficAt: deployedAt + this.timings.deployMs,
      };
      return service.deployment.id;
    });
  }

  stopDeployment(deploymentId: string) {
    return this.call("stopDeployment", () => {
      const deployment = this.deployment(deploymentId, "stopDeployment");
      if (this.isSleeping(deployment)) throw this.refusal("invalid_input", "stopDeployment", "Deployment is not stoppable");
      deployment.stoppedFrom ??= this.now() + this.timings.stopMs;
    });
  }

  restartDeployment(deploymentId: string) {
    return this.call("restartDeployment", () => {
      const deployment = this.deployment(deploymentId, "restartDeployment");
      if (this.isSleeping(deployment)) throw this.refusal("invalid_input", "restartDeployment", "Deployment is not restartable");
      deployment.stoppedFrom = null;
      deployment.lastTrafficAt = this.now();
    });
  }

  deleteService(serviceId: string) {
    return this.call("deleteService", () => {
      this.service(serviceId, "deleteService");
      this.services.delete(serviceId);
    });
  }

  /** Test control: the next call to `method` takes effect, but its answer never arrives. */
  loseResponseOf(method: Method): void {
    this.queueFault(method, "lost_response");
  }

  /** Test control: the next call to `method` fails with `error` and changes nothing. */
  failNext(method: Method, error: RailwayError): void {
    this.queueFault(method, error);
  }

  /** Test control: what an HTTP request to the container's URL does to a sleeping deployment. */
  receiveTraffic(serviceId: string): void {
    const deployment = this.services.get(serviceId)?.deployment;
    if (deployment) deployment.lastTrafficAt = this.now();
  }

  /** Test control: a service that exists in the sandbox but was not created by this app. */
  addForeignService(name: string): string {
    const id = this.nextId("service");
    this.services.set(id, { id, name, image: "postgres:17", createdAt: this.now(), sleepEnabled: false, domains: [], deployment: null });
    return id;
  }

  private async call<T>(method: Method, effect: () => T): Promise<T> {
    this.calls.push(method);
    this.budget?.record();
    const fault = this.faults.get(method)?.shift();
    if (fault instanceof RailwayError) throw fault;
    const result = effect();
    if (fault === "lost_response") throw new RailwayError("no_response", "Railway did not answer", { operation: method });
    return result;
  }

  private view(service: FakeService): ServiceInstance {
    return {
      serviceId: service.id,
      name: service.name,
      createdAt: new Date(service.createdAt).toISOString(),
      image: service.image,
      domains: [...service.domains],
      latestDeployment: service.deployment && this.report(service.deployment),
    };
  }

  private report(deployment: FakeDeployment): Deployment {
    const { id, instanceId, deployedAt, stoppedFrom } = deployment;
    const now = this.now();
    const instances = (statuses: string[]) => statuses.map((status) => ({ id: instanceId, status }));

    if (now - deployedAt < this.timings.deployMs) {
      const stage = DEPLOY_TIMELINE.findLast((each) => now - deployedAt >= each.fromMs) ?? DEPLOY_TIMELINE[0];
      return { id, status: stage.status, deploymentStopped: true, statusUpdatedAt: null, instances: instances(stage.instances) };
    }
    const succeededAt = new Date(deployedAt + this.timings.deployMs).toISOString();
    if (stoppedFrom !== null && now >= stoppedFrom) {
      // A stop is not a status change: `status` and `statusUpdatedAt` stay as they were.
      return { id, status: "SUCCESS", deploymentStopped: true, statusUpdatedAt: succeededAt, instances: instances(["EXITED"]) };
    }
    if (this.isSleeping(deployment)) {
      const sleptAt = new Date(deployment.lastTrafficAt + this.timings.sleepAfterMs).toISOString();
      return { id, status: "SLEEPING", deploymentStopped: true, statusUpdatedAt: sleptAt, instances: instances(["RUNNING"]) };
    }
    return { id, status: "SUCCESS", deploymentStopped: false, statusUpdatedAt: succeededAt, instances: instances(["RUNNING"]) };
  }

  private isSleeping(deployment: FakeDeployment): boolean {
    const stopped = deployment.stoppedFrom !== null && this.now() >= deployment.stoppedFrom;
    return deployment.sleeps && !stopped && this.now() - deployment.lastTrafficAt >= this.timings.sleepAfterMs;
  }

  private service(id: string, operation: Method): FakeService {
    const service = this.services.get(id);
    // Railway answers "Not Authorized", not "not found", for a service id it does not know.
    if (!service) throw this.refusal("unauthorized", operation, "Not Authorized");
    return service;
  }

  private deployment(id: string, operation: Method): FakeDeployment {
    for (const service of this.services.values()) if (service.deployment?.id === id) return service.deployment;
    throw this.refusal("not_found", operation, "Deployment not found");
  }

  private refusal(kind: RailwayError["kind"], operation: Method, message: string): RailwayError {
    return new RailwayError(kind, message, { operation, traceId: `fake-${this.nextId("trace")}` });
  }

  private queueFault(method: Method, fault: "lost_response" | RailwayError): void {
    this.faults.set(method, [...(this.faults.get(method) ?? []), fault]);
  }

  private nextId(kind: string): string {
    return `${kind}-${++this.sequence}`;
  }
}
