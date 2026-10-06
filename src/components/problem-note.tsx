import type { ApiProblem } from "@/lib/contract";

/** An error in plain words, with Railway's trace id when there is one so it can be quoted to support. */
export function ProblemNote({ problem, className = "" }: { problem: ApiProblem; className?: string }) {
  return (
    <p role="alert" className={`text-bad ${className}`}>
      {problem.message}
      {problem.retryAfterSeconds ? ` Try again in ${Math.ceil(problem.retryAfterSeconds / 60)} min.` : null}
      {problem.traceId ? <span className="ml-1 font-mono">(trace {problem.traceId})</span> : null}
    </p>
  );
}
