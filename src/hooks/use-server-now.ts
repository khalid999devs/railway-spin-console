"use client";

import { useEffect, useState } from "react";

/**
 * The server's current time, ticking once a second. Ages and countdowns are
 * measured against Railway's timestamps, so they use the server's clock (as
 * of the last answer) rather than trusting the visitor's.
 */
export function useServerNow(serverTime: string | undefined, receivedAt: number): number {
  const [clientNow, setClientNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClientNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const skew = serverTime ? Date.parse(serverTime) - receivedAt : 0;
  return Math.max(clientNow, receivedAt) + skew;
}
