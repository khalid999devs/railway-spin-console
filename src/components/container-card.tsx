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
  return `${status} · stopped ${deploymentStopped ? "yes" : "no"} · ${instances.join(", ") || "no instances"}`;
}

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
  const refusal = actions[spin].allowed ? null : actions[spin].reason;

  const waited = accepted ? now - accepted.at : 0;
  const awaitingReport = accepted !== null && waited < UNCONFIRMED_AFTER_MS;
  const acceptedNote = !accepted
    ? null
    : awaitingReport
      ? `${ACTION_COPY[accepted.action].label} accepted ${formatDuration(waited)} ago. Waiting for Railway to report it.`
      : `Railway accepted the ${ACTION_COPY[accepted.action].label.toLowerCase()} ${formatDuration(waited)} ago and still reports ${copy.label.toLowerCase()}. You can try again.`;

  const titleId = `container-${container.id}`;

  return (
    <li>
      <article aria-labelledby={titleId} className="rounded-lg border border-line bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id={titleId} className="truncate font-mono text-sm font-medium">
              {container.name}
            </h3>
            <p className="mt-0.5 text-xs text-dim">
              {container.image ?? "unknown image"} · {formatDuration(now - Date.parse(container.createdAt))} old ·{" "}
              {formatDuration(Date.parse(container.expiresAt) - now)} left
            </p>
          </div>
          <StateChip state={state} />
        </div>

        <div className="mt-3 text-xs">
          {container.url ? (
            <a href={container.url} target="_blank" rel="noreferrer" className="block truncate font-mono underline underline-offset-2">
              {container.url.replace("https://", "")}
            </a>
          ) : (
            <span className="text-dim">No public URL yet.</span>
          )}
          <p className="mt-1.5 min-h-8 font-mono sm:min-h-0">
            <span className="font-sans text-dim">Railway reports </span>
            {reportedLine(container.reported)}
          </p>
        </div>

        <div className="mt-4 flex gap-2">
          <Button
            variant="primary"
            className="flex-1 sm:flex-none"
            disabled={!unlocked || busy || awaitingReport || refusal !== null}
            onClick={() => act.mutate(spin)}
          >
            {doing(spin) ? `${ACTION_COPY[spin].doing}…` : ACTION_COPY[spin].label}
          </Button>
          <Button variant="danger" className="flex-1 sm:flex-none" disabled={!unlocked || busy || !actions.destroy.allowed} onClick={destroy}>
            {doing("destroy") ? "Destroying…" : confirmingDestroy ? "Tap again to destroy" : "Destroy"}
          </Button>
        </div>

        <div aria-live="polite" className="mt-2 min-h-4 text-xs text-dim">
          {act.error ? <ProblemNote problem={problemOf(act.error)!} /> : (acceptedNote ?? refusal ?? copy.hint)}
        </div>
      </article>
    </li>
  );
}
