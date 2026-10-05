import { AttemptThrottle } from "./auth/throttle";
import { Sessions } from "./auth/session";
import { loadConfig, type AppConfig } from "./config";
import { SandboxReader } from "./console/reader";
import { ConsoleService } from "./console/service";
import type { RailwayApi } from "./railway/api";
import { RequestBudget } from "./railway/budget";
import { createRailwayClient } from "./railway/client";
import { FakeRailway } from "./railway/fake";
import { createTransport } from "./railway/transport";

export interface Runtime {
  config: AppConfig;
  service: ConsoleService;
  sessions: Sessions;
  throttle: AttemptThrottle;
}

interface Overrides {
  now?: () => number;
  /** Tests pass their own fake so they can drive and inspect it. */
  api?: RailwayApi;
}

/** Wires the app together. The one place that chooses between Railway and the fake. */
export function createRuntime(env: Record<string, string | undefined>, { now = Date.now, api }: Overrides = {}): Runtime {
  const config = loadConfig(env);
  const budget = new RequestBudget(now);
  const railway =
    api ??
    (config.fake
      ? new FakeRailway({ now, budget })
      : createRailwayClient(createTransport({ token: config.sandboxToken, tokenType: "project", budget })));
  const reader = new SandboxReader(railway, budget, now);

  return {
    config,
    service: new ConsoleService({ api: railway, reader, budget, mode: config.fake ? "fake" : "live", now }),
    sessions: new Sessions(config.sessionSecret, config.secureCookies, now),
    throttle: new AttemptThrottle(undefined, undefined, now),
  };
}

// Next.js may load this module more than once (route bundles, instrumentation, dev reloads).
// The queue, cache and budget must exist once per process, so the instance lives on globalThis.
const holder = globalThis as typeof globalThis & { __spinConsole?: Runtime };

export function getRuntime(): Runtime {
  return (holder.__spinConsole ??= createRuntime(process.env));
}

export function setRuntime(runtime: Runtime | undefined): void {
  holder.__spinConsole = runtime;
}
