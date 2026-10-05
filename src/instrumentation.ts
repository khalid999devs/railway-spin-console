const LIFETIME_TICK_MS = 60_000;

/** Runs once when the server starts: begins the one-minute lifetime check. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getRuntime } = await import("@/server/runtime");

  const tick = () => {
    Promise.resolve()
      .then(() => getRuntime().service.enforceLifetimes())
      .catch((error) => console.error("[lifetime]", error instanceof Error ? error.message : error));
  };
  tick();
  // unref: the timer must not keep the process alive after SIGTERM.
  setInterval(tick, LIFETIME_TICK_MS).unref();
}
