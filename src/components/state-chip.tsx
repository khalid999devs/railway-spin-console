import type { ContainerState } from "@/lib/contract";
import { STATE_COPY, type Tone } from "@/lib/state-copy";

const TONES: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  busy: "bg-busy-soft text-busy",
  rest: "bg-rest-soft text-rest",
  bad: "bg-bad-soft text-bad",
  odd: "bg-odd-soft text-odd",
  neutral: "bg-bg text-dim",
};

/** The state in words. Colour and the dot only repeat what the label already says. */
export function StateChip({ state }: { state: ContainerState }) {
  const { label, tone } = STATE_COPY[state];
  return (
    <span className={`inline-flex min-w-24 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${TONES[tone]}`}>
      <span aria-hidden className={`size-1.5 rounded-full bg-current ${tone === "busy" ? "animate-pulse motion-reduce:animate-none" : ""}`} />
      {label}
    </span>
  );
}
