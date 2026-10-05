"use client";

import { useMutation } from "@tanstack/react-query";
import { type FormEvent, type RefObject, useState } from "react";
import { useRefreshState } from "@/hooks/use-console-state";
import { api, problemOf } from "@/lib/api-client";
import { Button } from "./button";
import { ProblemNote } from "./problem-note";

interface AccessProps {
  unlocked: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * Reading is open to everyone; changing anything needs the shared passphrase.
 * It is a barrier against a stranger spending the owner's credit, not a login.
 */
export function Access({ unlocked, open, onOpenChange, inputRef }: AccessProps) {
  const refresh = useRefreshState();
  const [passphrase, setPassphrase] = useState("");

  const unlock = useMutation({
    mutationFn: api.unlock,
    onSuccess: async () => {
      setPassphrase("");
      onOpenChange(false);
      await refresh();
    },
  });
  const lock = useMutation({ mutationFn: api.lock, onSuccess: refresh });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (passphrase) unlock.mutate(passphrase);
  }

  if (unlocked) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-2">
        <p className="text-sm">Unlocked. You can make changes from this browser.</p>
        <Button onClick={() => lock.mutate()} disabled={lock.isPending}>
          Lock
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">Read-only. Changes need the passphrase.</p>
        <Button aria-expanded={open} aria-controls="unlock-form" onClick={() => onOpenChange(!open)}>
          {open ? "Cancel" : "Unlock"}
        </Button>
      </div>
      <form id="unlock-form" hidden={!open} onSubmit={submit} className="mt-3 pb-2">
        <label htmlFor="passphrase" className="block text-sm font-medium">
          Passphrase
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            ref={inputRef}
            id="passphrase"
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-base"
          />
          <Button type="submit" variant="primary" disabled={!passphrase || unlock.isPending}>
            {unlock.isPending ? "Checking…" : "Unlock"}
          </Button>
        </div>
        {unlock.error ? <ProblemNote problem={problemOf(unlock.error)!} className="mt-2" /> : null}
      </form>
    </div>
  );
}
