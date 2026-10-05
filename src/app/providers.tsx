"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

let browserClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  // The next poll is the retry, so a failed read is not repeated on top of it.
  const create = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (typeof window === "undefined") return create();
  return (browserClient ??= create());
}

export function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={getQueryClient()}>{children}</QueryClientProvider>;
}
