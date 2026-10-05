import { describe, expect, it } from "vitest";
import { probeEvents, type Scenario } from "../../../tests/support/probe";
import { classifyGraphqlError, type RailwayErrorKind } from "./errors";

const SCENARIOS: Scenario[] = ["lifecycle", "followups"];

/** Every error the probe received from the real API, with the HTTP status it came with. */
const recorded = SCENARIOS.flatMap(probeEvents).flatMap((event) =>
  (event.body?.errors ?? []).map((error) => ({ step: event.step, status: event.status ?? 200, error })),
);

describe("classifyGraphqlError", () => {
  it.each<[string, RailwayErrorKind]>([
    ["auth:projectTokenAsBearer", "unauthorized"],
    ["error:stopMissingDeployment", "not_found"],
    // Railway says "Not Authorized" for a service id that does not exist.
    ["error:deleteMissingService", "unauthorized"],
    ["serviceCreate:sameName", "already_exists"],
    ["update:numReplicasZero", "invalid_input"],
    ["race:createA", "already_exists"],
    ["stop:whileSleeping", "invalid_input"],
    ["restart:afterSleepThenStop", "invalid_input"],
  ])("classifies the recorded %s error as %s", (step, kind) => {
    const hit = recorded.find((each) => each.step === step);
    expect(hit, `no recorded error for ${step}`).toBeDefined();
    expect(classifyGraphqlError(hit!.error, "Test", hit!.status).kind).toBe(kind);
  });

  it("covers every error the probe recorded", () => {
    expect(recorded).toHaveLength(8);
    expect(recorded.every((each) => each.status === 200)).toBe(true);
  });

  it("keeps the trace id from where Railway actually puts it, on the error object", () => {
    for (const { error } of recorded) {
      const classified = classifyGraphqlError(error, "Test", 200);
      expect(classified.traceId).toBe(error.traceId);
      expect(classified.traceId).toMatch(/^\d+$/);
    }
  });

  it("also accepts the trace id where the docs show it, inside extensions", () => {
    const error = { message: "Not Authorized", extensions: { code: "INTERNAL_SERVER_ERROR", traceId: "7992771584715554281" } };
    expect(classifyGraphqlError(error, "Test", 200).traceId).toBe("7992771584715554281");
  });

  it("treats a rejected document as a bug in this app, not as bad input", () => {
    const error = { message: 'Cannot query field "nope" on type "Query".', extensions: { code: "GRAPHQL_VALIDATION_FAILED" } };
    expect(classifyGraphqlError(error, "Test", 400).kind).toBe("invalid_document");
  });

  it("falls back to unknown, keeping Railway's message and the operation name", () => {
    const classified = classifyGraphqlError({ message: "Something new", extensions: { code: "INTERNAL_SERVER_ERROR" } }, "Deploy", 200);
    expect(classified).toMatchObject({ kind: "unknown", message: "Something new", operation: "Deploy", code: "INTERNAL_SERVER_ERROR" });
  });

  it("survives an error with no message", () => {
    expect(classifyGraphqlError({}, "Deploy", 200).kind).toBe("unknown");
  });
});
