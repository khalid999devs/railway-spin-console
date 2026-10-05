/** "45 s", "12 min", "1 h 5 min". Rounds down, and never shows a negative duration. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Eight characters from a random UUID: enough to make a click unique, short enough for a service name. */
export function newOperationId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}
