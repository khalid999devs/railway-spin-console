"use client";

import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { useRefreshState } from "@/hooks/use-console-state";
import { api, problemOf } from "@/lib/api-client";
import type { ConsoleSnapshot } from "@/lib/contract";
import { newOperationId } from "@/lib/format";
import { Button } from "./button";
import { ProblemNote } from "./problem-note";

const FIELD = "min-h-11 w-full min-w-0 rounded-md border border-line bg-bg px-3 text-sm sm:min-h-9";

interface ControlPanelProps {
  snapshot: ConsoleSnapshot;
  onPublished: (snapshot: ConsoleSnapshot) => void;
}

/** The page's one form: the passphrase while locked, a new container once unlocked. */
export function ControlPanel({ snapshot, onPublished }: ControlPanelProps) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      {snapshot.unlocked ? <CreateForm snapshot={snapshot} onPublished={onPublished} /> : <UnlockForm />}
    </section>
  );
}

/**
 * Reading is open to everyone; changing anything needs the shared passphrase.
 * It is a barrier against a stranger spending the owner's credit, not a login.
 */
function UnlockForm() {
  const refresh = useRefreshState();
  const [passphrase, setPassphrase] = useState("");
  const unlock = useMutation({ mutationFn: api.unlock, onSuccess: refresh });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (passphrase) unlock.mutate(passphrase);
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="passphrase" className="text-sm font-medium">
        Passphrase
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="passphrase"
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          className={FIELD}
        />
        <Button type="submit" variant="primary" disabled={!passphrase || unlock.isPending}>
          {unlock.isPending ? "Checking…" : "Unlock"}
        </Button>
      </div>
      <div className="mt-2 text-xs text-dim">
        {unlock.error ? <ProblemNote problem={problemOf(unlock.error)!} /> : "Read-only until unlocked."}
      </div>
    </form>
  );
}

function CreateForm({ snapshot, onPublished }: ControlPanelProps) {
  const { images, maxContainers, lifetimeMinutes } = snapshot.limits;
  const [imageId, setImageId] = useState(images[0].id);
  // One id per intended container. It survives a failed attempt, so pressing the button again repeats the
  // same operation and the server finishes it instead of starting a second one.
  const operationId = useRef<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.create({ operationId: (operationId.current ??= newOperationId()), imageId }),
    onSuccess: (next) => {
      operationId.current = null;
      onPublished(next);
    },
  });

  const full = snapshot.containers.length >= maxContainers;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!full && !create.isPending) create.mutate();
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="image" className="text-sm font-medium">
        Image
      </label>
      <div className="mt-1.5 flex gap-2">
        <select
          id="image"
          value={imageId}
          disabled={create.isPending}
          onChange={(event) => {
            setImageId(event.target.value);
            operationId.current = null;
          }}
          className={`${FIELD} font-mono`}
        >
          {images.map((option) => (
            <option key={option.id} value={option.id}>
              {option.image}
            </option>
          ))}
        </select>
        <Button type="submit" variant="primary" className="shrink-0" disabled={full || create.isPending}>
          {create.isPending ? "Creating…" : "Spin up"}
        </Button>
      </div>
      <div className="mt-2 text-xs text-dim">
        {create.error ? (
          <ProblemNote problem={problemOf(create.error)!} />
        ) : full ? (
          `Limit of ${maxContainers} reached. Destroy one to make room.`
        ) : (
          `Up to ${maxContainers} containers. Each gets a public URL and is destroyed after ${lifetimeMinutes} minutes.`
        )}
      </div>
    </form>
  );
}
