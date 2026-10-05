"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, problemOf } from "@/lib/api-client";
import type { ConsoleSnapshot, ContainerAction, ContainerState, ContainerView } from "@/lib/contract";
import { formatDuration } from "@/lib/format";
import { ACTION_COPY, STATE_COPY } from "@/lib/state-copy";
import { Button } from "./button";
import { ProblemNote } from "./problem-note";
import { StateChip } from "./state-chip";

/** After this long without Railway reporting a change, stop saying "waiting" and say so. */
const UNCONFIRMED_AFTER_MS = 30_000;
const CONFIRM_DESTROY_MS = 4_000;

interface ContainerCardProps {
  container: ContainerView;
  now: number;
  unlocked: boolean;
  onPublished: (snapshot: ConsoleSnapshot) => void;
}

interface Accepted {
  action: ContainerAction;
  at: number;
  fromState: ContainerState;
}

function reportedLine({ status, deploymentStopped, instances }: ContainerView["reported"]): string {
  if (status === null) return "no deployment";
  return `status ${status} · stopped ${deploymentStopped ? "yes" : "no"} · instances ${instances.join(", ") || "none"}`;
}

const URL_HINT: Partial<Record<ContainerState, string>> = {
  running: "Opens in a new tab.",
  sleeping: "Opening it wakes the container.",
  starting: "Answers once the container is running.",
};

export function ContainerCard({ container, now, unlocked, onPublished }: ContainerCardProps) {
  const { state, actions } = container;
  const copy = STATE_COPY[state];

  // Railway answering "accepted" is not Railway reporting the change. Until its reported state moves, the
  // card says the request was accepted and keeps showing the state Railway actually reports.
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  if (accepted && state !== accepted.fromState) setAccepted(null);

  const act = useMutation({
    mutationFn: (action: ContainerAction) => api[action](container.id),
    onSuccess: (snapshot, action) => {
      setAccepted({ action, at: now, fromState: state });
      onPublished(snapshot);
    },
  });

  const [confirmingDestroy, setConfirmingDestroy] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  function destroy() {
    clearTimeout(confirmTimer.current);
    if (confirmingDestroy) {
      setConfirmingDestroy(false);
      act.mutate("destroy");
      return;
    }
    setConfirmingDestroy(true);
    confirmTimer.current = setTimeout(() => setConfirmingDestroy(false), CONFIRM_DESTROY_MS);
  }

  const spin = copy.spin;
  const busy = act.isPending;
  const doing = (action: ContainerAction) => busy && act.variables === action;
  const spinRefusal = unlocked ? (actions[spin].allowed ? null : actions[spin].reason) : "Locked. Unlock above to make changes.";

  const waited = accepted ? now - accepted.at : 0;
  const awaitingReport = accepted !== null && waited < UNCONFIRMED_AFTER_MS;
  const acceptedNote = !accepted
    ? null
    : awaitingReport
      ? `${ACTION_COPY[accepted.action].label} accepted ${formatDuration(waited)} ago. Waiting for Railway to report it.`
      : `Railway accepted the ${ACTION_COPY[accepted.action].label.toLowerCase()} ${formatDuration(waited)} ago and still reports ${copy.label.toLowerCase()}. You can try again.`;

  const host = container.url?.replace("https://", "");
  const titleId = `container-${container.id}`;

  return (
    <li>
      <article aria-labelledby={titleId} className="rounded-xl border border-line bg-surface p-4">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id={titleId} className="truncate font-mono text-sm font-semibold">
              {container.name}
            </h3>
            <p className="mt-0.5 text-xs text-dim">
              {container.image ?? "unknown image"} · {formatDuration(now - Date.parse(container.createdAt))} old ·{" "}
              {formatDuration(Date.parse(container.expiresAt) - now)} left
            </p>
          </div>
          <StateChip state={state} />
        </header>

        <p className="mt-3 min-h-10 text-sm">{copy.meaning}</p>

        <div className="mt-2 min-h-10 text-xs">
          {container.url ? (
            <a href={container.url} target="_blank" rel="noreferrer" className="block truncate py-1 font-mono text-accent underline underline-offset-2">
              {host}
            </a>
          ) : (
            <span className="block py-1 text-dim">No public URL yet.</span>
          )}
          <span className="text-dim">{container.url ? (URL_HINT[state] ?? "Does not answer while the container is down.") : null}</span>
        </div>

        <p className="mt-3 border-t border-line pt-3 font-mono text-[11px] leading-relaxed text-dim">
          <span className="font-sans">Railway reports: </span>
          {reportedLine(container.reported)}
        </p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="primary" disabled={busy || awaitingReport || spinRefusal !== null} onClick={() => act.mutate(spin)}>
            {doing(spin) ? `${ACTION_COPY[spin].doing}…` : ACTION_COPY[spin].label}
          </Button>
          <Button variant="danger" disabled={busy || !unlocked || !actions.destroy.allowed} onClick={destroy}>
            {doing("destroy") ? "Destroying…" : confirmingDestroy ? "Tap again to destroy" : "Destroy"}
          </Button>
        </div>

        <div aria-live="polite" className="mt-2 min-h-5 text-xs text-dim">
          {act.error ? <ProblemNote problem={problemOf(act.error)!} className="text-xs" /> : (acceptedNote ?? spinRefusal)}
        </div>
      </article>
    </li>
  );
}
