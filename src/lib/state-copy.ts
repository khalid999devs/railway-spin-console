import type { ContainerAction, ContainerState } from "./contract";

export type Tone = "ok" | "busy" | "rest" | "bad" | "odd" | "neutral";

interface StateCopy {
  label: string;
  tone: Tone;
  /** The spin button to show: the allowed one, or the one whose refusal explains the state. */
  spin: "start" | "stop";
  /** Shown when the spin button is allowed and the state still needs a word of explanation. */
  hint?: string;
}

export const STATE_COPY: Record<ContainerState, StateCopy> = {
  idle: { label: "Created", tone: "neutral", spin: "start", hint: "Created but not deployed." },
  starting: { label: "Starting", tone: "busy", spin: "stop" },
  running: { label: "Running", tone: "ok", spin: "stop" },
  stopping: { label: "Stopping", tone: "busy", spin: "start" },
  stopped: { label: "Stopped", tone: "neutral", spin: "start", hint: "The service and its URL are kept. Spin up resumes it." },
  sleeping: { label: "Sleeping", tone: "rest", spin: "stop" },
  crashed: { label: "Crashed", tone: "bad", spin: "start", hint: "The container exited by itself. Spin up deploys it afresh." },
  failed: { label: "Failed", tone: "bad", spin: "start", hint: "The deploy failed. Spin up tries again." },
  removing: { label: "Removing", tone: "neutral", spin: "start" },
  expired: { label: "Expired", tone: "neutral", spin: "start" },
  unknown: { label: "Unknown", tone: "odd", spin: "stop" },
};

export const ACTION_COPY: Record<ContainerAction, { label: string; doing: string }> = {
  start: { label: "Spin up", doing: "Spinning up" },
  stop: { label: "Spin down", doing: "Spinning down" },
  destroy: { label: "Destroy", doing: "Destroying" },
};
