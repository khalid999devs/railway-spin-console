/** Types shared by the server's JSON responses and the browser. No runtime code, no server imports. */

export type ContainerState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "sleeping"
  | "crashed"
  | "failed"
  | "removing"
  | "expired"
  | "unknown";

export type ContainerAction = "start" | "stop" | "destroy";

export type ActionAvailability = { allowed: true } | { allowed: false; reason: string };

/** Railway's own values, passed through untouched so the UI can show what it was told. */
export interface ReportedState {
  status: string | null;
  deploymentStopped: boolean | null;
  instances: string[];
}

export interface ContainerView {
  id: string;
  name: string;
  image: string | null;
  url: string | null;
  createdAt: string;
  expiresAt: string;
  state: ContainerState;
  /** True while Railway is expected to change this state by itself, so the browser polls faster. */
  transitional: boolean;
  actions: Record<ContainerAction, ActionAvailability>;
  reported: ReportedState;
}

export interface ImageOption {
  id: string;
  label: string;
  image: string;
}

export interface ApiProblem {
  code: string;
  message: string;
  traceId?: string;
  retryAfterSeconds?: number;
}

export interface ConsoleSnapshot {
  containers: ContainerView[];
  limits: { maxContainers: number; lifetimeMinutes: number; images: ImageOption[] };
  budget: { limit: number; used: number; windowSeconds: number; source: "railway" | "assumed" };
  sandbox: { project: string; environment: string };
  /** When Railway was last read. Everything in `containers` is true as of this moment. */
  asOf: string;
  /** The server's clock when this was sent, so countdowns do not depend on the visitor's clock. */
  serverTime: string;
  pollAfterMs: number;
  unlocked: boolean;
  mode: "live" | "fake";
  /** Set when the latest read failed and `containers` is the last good answer. */
  problem?: ApiProblem;
}

export interface CreateContainerRequest {
  operationId: string;
  imageId: string;
}
