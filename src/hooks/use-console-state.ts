"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "@/lib/api-client";
import type { ConsoleSnapshot } from "@/lib/contract";

const STATE_KEY = ["console-state"] as const;
const FALLBACK_POLL_MS = 15_000;

/**
 * The one read the page makes, repeated at the pace the server asks for:
 * fast while something is changing, slow otherwise. TanStack Query pauses the
 * interval while the tab is hidden, so a background tab costs no requests.
 */
export function useConsoleState() {
  return useQuery({
    queryKey: STATE_KEY,
    queryFn: api.state,
    refetchInterval: (query) => query.state.data?.pollAfterMs ?? FALLBACK_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Every write answers with the state after it; showing that at once saves waiting for the next poll. */
export function usePublishSnapshot() {
  const client = useQueryClient();
  return useCallback((snapshot: ConsoleSnapshot) => client.setQueryData(STATE_KEY, snapshot), [client]);
}

export function useRefreshState() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: STATE_KEY }), [client]);
}
