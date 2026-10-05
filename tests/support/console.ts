import { SandboxReader } from "@/server/console/reader";
import { ConsoleService } from "@/server/console/service";
import { RequestBudget } from "@/server/railway/budget";
import { FakeRailway } from "@/server/railway/fake";

export const START = Date.parse("2026-10-06T09:00:00.000Z");
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

export function fakeClock(start = START) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A console wired to the in-memory Railway and a clock the test controls. */
export function makeConsole() {
  const clock = fakeClock();
  const budget = new RequestBudget(clock.now);
  const railway = new FakeRailway({ now: clock.now, budget });
  const connect = () => {
    const reader = new SandboxReader(railway, budget, clock.now);
    return { reader, service: new ConsoleService({ api: railway, reader, budget, mode: "fake", now: clock.now }) };
  };
  /** Mutations sent to Railway so far, leaving out reads. */
  const mutations = () => railway.calls.filter((call) => call !== "listInstances");
  return { clock, budget, railway, mutations, connect, ...connect() };
}

export const create = (operationId: string, imageId = "nginx") => ({ operationId, imageId });
