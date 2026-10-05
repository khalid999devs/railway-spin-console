"use client";

import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, problemOf } from "@/lib/api-client";
import type { ConsoleSnapshot } from "@/lib/contract";
import { newOperationId } from "@/lib/format";
import { Button } from "./button";
import { ProblemNote } from "./problem-note";

interface CreatePanelProps {
  snapshot: ConsoleSnapshot;
  onPublished: (snapshot: ConsoleSnapshot) => void;
  onRequestUnlock: () => void;
}

export function CreatePanel({ snapshot, onPublished, onRequestUnlock }: CreatePanelProps) {
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
  const image = images.find((option) => option.id === imageId) ?? images[0];
  const hint = full
    ? `The limit of ${maxContainers} is reached. Destroy one to make room.`
    : `Creates a service on Railway from ${image.image}, gives it a public URL and deploys it. Each container is destroyed after ${lifetimeMinutes} minutes.`;

  return (
    <section aria-labelledby="create-heading" className="rounded-xl border border-line bg-surface p-4">
      <h2 id="create-heading" className="text-sm font-semibold">
        New container
      </h2>
      <fieldset className="mt-3" disabled={create.isPending}>
        <legend className="sr-only">Image</legend>
        <div className="grid grid-cols-3 gap-2">
          {images.map((option) => (
            <label
              key={option.id}
              className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-line px-2 text-sm font-medium has-checked:border-accent has-checked:bg-bg has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
            >
              <input
                type="radio"
                name="image"
                value={option.id}
                checked={imageId === option.id}
                onChange={() => {
                  setImageId(option.id);
                  operationId.current = null;
                }}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      {snapshot.unlocked ? (
        <Button variant="primary" className="mt-3 w-full" disabled={full || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Asking Railway…" : "Spin up"}
        </Button>
      ) : (
        <Button variant="primary" className="mt-3 w-full" onClick={onRequestUnlock}>
          Unlock to spin up
        </Button>
      )}
      <p className="mt-2 text-xs text-dim">{hint}</p>
      {create.error ? <ProblemNote problem={problemOf(create.error)!} className="mt-2" /> : null}
    </section>
  );
}
