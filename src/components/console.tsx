"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useConsoleState, usePublishSnapshot, useRefreshState } from "@/hooks/use-console-state";
import { useServerNow } from "@/hooks/use-server-now";
import { api, problemOf } from "@/lib/api-client";
import type { ConsoleSnapshot } from "@/lib/contract";
import { formatClock } from "@/lib/format";
import { STATE_COPY } from "@/lib/state-copy";
import { Button } from "./button";
import { ContainerCard } from "./container-card";
import { ControlPanel } from "./control-panel";
import { ProblemNote } from "./problem-note";

const REPOSITORY = "https://github.com/khalid999devs/railway-spin-console";

/** What changed between two snapshots, in words, for screen readers. */
function describeChanges(previous: ConsoleSnapshot, next: ConsoleSnapshot): string {
  const before = new Map(previous.containers.map((container) => [container.id, container]));
  const changes: string[] = [];
  for (const container of next.containers) {
    const earlier = before.get(container.id);
    before.delete(container.id);
    const label = STATE_COPY[container.state].label.toLowerCase();
    if (!earlier) changes.push(`${container.name} was created and is ${label}.`);
    else if (earlier.state !== container.state) changes.push(`${container.name} is now ${label}.`);
  }
  for (const gone of before.values()) changes.push(`${gone.name} was removed.`);
  return changes.join(" ");
}

function useAnnouncement(snapshot: ConsoleSnapshot | undefined): string {
  const [seen, setSeen] = useState(snapshot);
  const [announcement, setAnnouncement] = useState("");
  if (snapshot && snapshot !== seen) {
    setSeen(snapshot);
    const changes = seen ? describeChanges(seen, snapshot) : "";
    if (changes) setAnnouncement(changes);
  }
  return announcement;
}

export function Console() {
  const state = useConsoleState();
  const publish = usePublishSnapshot();
  const refresh = useRefreshState();
  const lock = useMutation({ mutationFn: api.lock, onSuccess: refresh });

  const snapshot = state.data;
  const now = useServerNow(snapshot?.serverTime, state.dataUpdatedAt);
  const announcement = useAnnouncement(snapshot);
  const problem = snapshot?.problem ?? problemOf(state.error);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-5 px-4 pb-6 pt-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Spin Console</h1>
          <p className="mt-0.5 text-sm text-dim">Spin containers up and down on Railway. Every state shown is what Railway reports.</p>
        </div>
        {snapshot?.unlocked ? (
          <Button onClick={() => lock.mutate()} disabled={lock.isPending}>
            Lock
          </Button>
        ) : null}
      </header>

      <main className="flex flex-col gap-5">
        {!snapshot ? (
          problem ? (
            <section className="rounded-lg border border-line bg-surface p-4 text-sm">
              <h2 className="font-medium">Could not read the sandbox</h2>
              <ProblemNote problem={problem} className="mt-1" />
              <Button className="mt-3" onClick={() => state.refetch()} disabled={state.isFetching}>
                {state.isFetching ? "Trying…" : "Try again"}
              </Button>
            </section>
          ) : (
            <p role="status" className="text-sm text-dim">
              Reading the sandbox from Railway…
            </p>
          )
        ) : (
          <>
            {snapshot.mode === "fake" ? (
              <p className="rounded-lg bg-odd-soft px-4 py-2.5 text-sm text-odd">Fake mode: an in-memory Railway. Nothing here is real.</p>
            ) : null}

            {problem ? (
              <section className="rounded-lg bg-bad-soft px-4 py-2.5 text-sm">
                <h2 className="font-medium text-bad">Showing Railway&apos;s last answer, from {formatClock(snapshot.asOf)}</h2>
                <ProblemNote problem={problem} className="mt-0.5" />
              </section>
            ) : null}

            <ControlPanel snapshot={snapshot} onPublished={publish} />

            <section aria-labelledby="containers-heading">
              <h2 id="containers-heading" className="flex items-baseline justify-between text-sm font-medium">
                Containers
                <span className="font-normal text-dim">
                  {snapshot.containers.length} of {snapshot.limits.maxContainers}
                </span>
              </h2>
              {snapshot.containers.length === 0 ? (
                <p className="mt-2 rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-dim">
                  No containers yet. Spin one up to get a container on Railway with its own public URL.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-3">
                  {snapshot.containers.map((container) => (
                    <ContainerCard key={container.id} container={container} now={now} unlocked={snapshot.unlocked} onPublished={publish} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>

      {snapshot ? (
        <footer className="mt-auto flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line pt-4 text-xs text-dim">
          <p>
            <span className="font-mono">
              {snapshot.sandbox.project}/{snapshot.sandbox.environment}
            </span>{" "}
            · {snapshot.budget.used.toLocaleString("en")} of {snapshot.budget.limit.toLocaleString("en")} API requests this hour · as of{" "}
            {formatClock(snapshot.asOf)}
          </p>
          <a href={REPOSITORY} className="underline underline-offset-2">
            Source
          </a>
        </footer>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
