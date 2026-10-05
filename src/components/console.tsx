"use client";

import { useRef, useState } from "react";
import { useConsoleState, usePublishSnapshot } from "@/hooks/use-console-state";
import { useServerNow } from "@/hooks/use-server-now";
import { problemOf } from "@/lib/api-client";
import type { ConsoleSnapshot } from "@/lib/contract";
import { formatClock } from "@/lib/format";
import { STATE_COPY } from "@/lib/state-copy";
import { Access } from "./access";
import { Button } from "./button";
import { ContainerCard } from "./container-card";
import { CreatePanel } from "./create-panel";
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
  const snapshot = state.data;
  const now = useServerNow(snapshot?.serverTime, state.dataUpdatedAt);
  const announcement = useAnnouncement(snapshot);

  const [unlockOpen, setUnlockOpen] = useState(false);
  const passphraseInput = useRef<HTMLInputElement>(null);
  function requestUnlock() {
    setUnlockOpen(true);
    // The form is hidden until this render commits; focus once it is visible.
    requestAnimationFrame(() => passphraseInput.current?.focus());
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 pb-8 pt-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Spin Console</h1>
        <p className="mt-1 text-sm text-dim">
          Spin a container up and down on Railway through its public API. Every state shown here is what Railway reports.
        </p>
      </header>

      <main className="flex flex-col gap-4">
        {!snapshot ? (
          state.error ? (
            <section className="rounded-xl border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold">Could not read the sandbox</h2>
              <ProblemNote problem={problemOf(state.error)!} className="mt-2" />
              <Button className="mt-3" onClick={() => state.refetch()} disabled={state.isFetching}>
                {state.isFetching ? "Trying…" : "Try again"}
              </Button>
            </section>
          ) : (
            <p role="status" className="rounded-xl border border-line bg-surface p-4 text-sm text-dim">
              Reading the sandbox from Railway…
            </p>
          )
        ) : (
          <>
            {snapshot.mode === "fake" ? (
              <p className="rounded-xl border border-line bg-odd-soft px-4 py-3 text-sm text-odd">
                Fake mode. This is an in-memory simulation of Railway; nothing here creates a real container.
              </p>
            ) : null}

            {state.error || snapshot.problem ? (
              <section className="rounded-xl border border-line bg-bad-soft px-4 py-3">
                <h2 className="text-sm font-semibold text-bad">Showing Railway&apos;s last answer, from {formatClock(snapshot.asOf)}</h2>
                <ProblemNote problem={snapshot.problem ?? problemOf(state.error)!} className="mt-1" />
              </section>
            ) : null}

            <Access unlocked={snapshot.unlocked} open={unlockOpen} onOpenChange={setUnlockOpen} inputRef={passphraseInput} />
            <CreatePanel snapshot={snapshot} onPublished={publish} onRequestUnlock={requestUnlock} />

            <section aria-labelledby="containers-heading">
              <h2 id="containers-heading" className="text-sm font-semibold">
                Containers{" "}
                <span className="font-normal text-dim">
                  {snapshot.containers.length} of {snapshot.limits.maxContainers}
                </span>
              </h2>
              {snapshot.containers.length === 0 ? (
                <div className="mt-2 rounded-xl border border-dashed border-line p-5 text-sm">
                  <p className="font-medium">Nothing is running.</p>
                  <p className="mt-1 text-dim">
                    Pick an image above and spin it up. You get a container on Railway with its own public URL, which you can spin
                    down, spin up again and destroy. At most {snapshot.limits.maxContainers} at a time, and each one is destroyed
                    after {snapshot.limits.lifetimeMinutes} minutes.
                  </p>
                </div>
              ) : (
                <ul className="mt-2 flex flex-col gap-3">
                  {snapshot.containers.map((container) => (
                    <ContainerCard key={container.id} container={container} now={now} unlocked={snapshot.unlocked} onPublished={publish} />
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="legend-heading" className="text-xs text-dim">
              <h2 id="legend-heading" className="font-semibold text-ink">
                What the buttons do
              </h2>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="font-medium text-ink">Spin down</dt>
                <dd>Stops the container. The service and its URL stay, and nothing runs.</dd>
                <dt className="font-medium text-ink">Spin up</dt>
                <dd>Resumes a stopped container in about a second, or deploys one that never ran.</dd>
                <dt className="font-medium text-ink">Destroy</dt>
                <dd>Deletes the service and its URL from Railway.</dd>
              </dl>
            </section>
          </>
        )}
      </main>

      {snapshot ? (
        <footer className="mt-auto border-t border-line pt-4 text-xs leading-relaxed text-dim">
          <p>
            Sandbox <span className="font-mono">{snapshot.sandbox.project}</span> /{" "}
            <span className="font-mono">{snapshot.sandbox.environment}</span> · state as of {formatClock(snapshot.asOf)}
          </p>
          <p>
            Railway API budget: {snapshot.budget.used.toLocaleString("en")} of {snapshot.budget.limit.toLocaleString("en")} requests in the
            last hour, counted by this app{snapshot.budget.source === "assumed" ? " (limit assumed until Railway states it)" : ""}.
          </p>
          <p>
            <a href={REPOSITORY} className="underline underline-offset-2">
              Source and design notes
            </a>
          </p>
        </footer>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
