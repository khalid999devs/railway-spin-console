import type { RailwayApi, Sandbox, ServiceInstance } from "@/server/railway/api";
import type { RequestBudget } from "@/server/railway/budget";

export interface SandboxReading {
  sandbox: Sandbox;
  instances: ServiceInstance[];
  /** When Railway was asked. */
  asOf: number;
  /** Set when a later read failed and this is the last good answer. */
  problem?: unknown;
}

/** Polls arriving closer together than this share one Railway read. */
const MIN_READ_AGE_MS = 1500;

/**
 * The only path by which the app reads the sandbox. It holds the latest
 * reading, which is a cache of Railway's answer and never a second source of
 * truth: nothing is written to it except what Railway returned.
 */
export class SandboxReader {
  private sandbox?: Promise<Sandbox>;
  private latest?: SandboxReading;
  private inflight?: Promise<SandboxReading>;
  private started = 0;
  private applied = 0;

  constructor(
    private readonly api: RailwayApi,
    private readonly budget: RequestBudget,
    private readonly now: () => number = Date.now,
  ) {}

  /** The latest reading, without asking Railway. */
  peek(): SandboxReading | undefined {
    return this.latest;
  }

  /**
   * For screens. Any number of simultaneous callers share one request, and
   * when the read budget is spent the latest reading is served instead.
   */
  async read(): Promise<SandboxReading> {
    const cached = this.latest;
    if (cached && this.now() - cached.asOf < MIN_READ_AGE_MS) return cached;
    if (this.inflight) return this.inflight;
    if (cached && !this.budget.tryTakeRead()) return cached;

    this.inflight = this.refresh()
      .catch((problem) => {
        if (cached) return { ...cached, problem };
        throw problem;
      })
      .finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  /**
   * For writes, which must see the state after their own mutation: always
   * asks Railway and never joins a request that started earlier.
   */
  async refresh(): Promise<SandboxReading> {
    const order = ++this.started;
    const asOf = this.now();
    const sandbox = await this.identify();
    const instances = await this.api.listInstances(sandbox.environmentId);
    const reading = { sandbox, instances, asOf };
    // A slower, earlier read must not overwrite a newer one.
    if (order > this.applied) {
      this.applied = order;
      this.latest = reading;
    }
    return reading;
  }

  private identify(): Promise<Sandbox> {
    this.sandbox ??= this.api.identify().catch((error) => {
      this.sandbox = undefined;
      throw error;
    });
    return this.sandbox;
  }
}
