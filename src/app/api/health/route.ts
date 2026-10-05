import { json, problemResponse } from "@/server/http/respond";
import { getRuntime } from "@/server/runtime";

/**
 * Railway's deploy health check. Healthy means the process is up and its
 * configuration is complete; it does not call Railway's API, so an API
 * outage cannot take this app's own deploy down.
 */
export function GET(): Response {
  try {
    const { config } = getRuntime();
    return json({ ok: true, mode: config.fake ? "fake" : "live" });
  } catch (error) {
    console.error("[health]", error instanceof Error ? error.message : error);
    return problemResponse(error);
  }
}
