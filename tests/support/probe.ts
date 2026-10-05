import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceInstance } from "@/server/railway/api";
import { createRailwayClient } from "@/server/railway/client";
import type { Transport } from "@/server/railway/transport";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "probe");

interface ProbeEvent {
  step: string;
  status?: number;
  body?: { data?: unknown; errors?: Record<string, unknown>[] };
  node?: unknown;
}

export type Scenario = "lifecycle" | "followups" | "stopTiming" | "stopPolicy" | "imageStop";

/** The raw events one probe scenario recorded against the real API. */
export function probeEvents(scenario: Scenario): ProbeEvent[] {
  const file = readdirSync(FIXTURES).find((name) => name.startsWith(`${scenario}-`));
  if (!file) throw new Error(`no probe fixture for ${scenario}`);
  return JSON.parse(readFileSync(join(FIXTURES, file), "utf8")).events;
}

export interface RecordedSnapshot {
  step: string;
  instance: ServiceInstance;
}

/**
 * Every state snapshot a scenario recorded, passed through the real response
 * schema and client mapping, so tests see exactly what the app would.
 */
export async function recordedSnapshots(scenario: Scenario): Promise<RecordedSnapshot[]> {
  const snapshots: RecordedSnapshot[] = [];
  for (const event of probeEvents(scenario)) {
    if (!event.step.startsWith("watch:") || !event.node) continue;
    const data = { environment: { serviceInstances: { edges: [{ node: event.node }] } } };
    const replay: Transport = async (_document, _variables, shape) => shape.parse(data);
    const [instance] = await createRailwayClient(replay).listInstances("recorded");
    snapshots.push({ step: event.step.replace("watch:", ""), instance });
  }
  return snapshots;
}
