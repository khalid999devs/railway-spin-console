import type { ContainerAction, ContainerState } from "./contract";

export type Tone = "ok" | "busy" | "rest" | "bad" | "odd" | "neutral";

interface StateCopy {
  label: string;
  tone: Tone;
  /** One line saying what this state means for the visitor. */
  meaning: string;
  /** The spin button to show: the allowed one, or the one whose refusal is worth explaining. */
  spin: "start" | "stop";
}

export const STATE_COPY: Record<ContainerState, StateCopy> = {
  idle: { label: "Created", tone: "neutral", meaning: "The service exists but has not been deployed.", spin: "start" },
  starting: { label: "Starting", tone: "busy", meaning: "Railway is deploying it. This takes about ten seconds.", spin: "stop" },
  running: { label: "Running", tone: "ok", meaning: "Up and answering at its URL.", spin: "stop" },
  stopping: { label: "Stopping", tone: "busy", meaning: "Railway is shutting the container down.", spin: "start" },
  stopped: { label: "Stopped", tone: "neutral", meaning: "Nothing is running. The service and its URL are kept.", spin: "start" },
  sleeping: { label: "Sleeping", tone: "rest", meaning: "Idle for a few minutes, so Railway put it to sleep. Opening its URL wakes it.", spin: "stop" },
  crashed: { label: "Crashed", tone: "bad", meaning: "The container exited by itself. Spinning up deploys it afresh.", spin: "start" },
  failed: { label: "Failed", tone: "bad", meaning: "The deploy did not succeed. Spinning up tries again.", spin: "start" },
  removing: { label: "Removing", tone: "neutral", meaning: "Railway is removing it.", spin: "start" },
  expired: { label: "Expired", tone: "neutral", meaning: "Past its lifetime. It is being destroyed.", spin: "start" },
  unknown: { label: "Unknown", tone: "odd", meaning: "Railway reports a state this app does not recognise. Its raw values are below.", spin: "stop" },
};

export const ACTION_COPY: Record<ContainerAction, { label: string; doing: string }> = {
  start: { label: "Spin up", doing: "Spinning up" },
  stop: { label: "Spin down", doing: "Spinning down" },
  destroy: { label: "Destroy", doing: "Destroying" },
};
