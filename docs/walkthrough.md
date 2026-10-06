# Walkthrough

My preparation notes for the code review: a 30-minute path through the code, the questions I expect, and how I would extend it.

## The 30-minute script

| Minutes | Show | Say |
|---|---|---|
| 0–3 | The live app in a phone-width window. Spin up, wait for running, open the URL, spin down, spin up again, destroy. | Two promises: the screen never shows a state Railway is not reporting, and nothing a visitor does creates a duplicate, an orphan or a bill. |
| 3–7 | `scripts/probe.mts`, `docs/api-findings.md` | I probed the API before designing. Three findings shaped the app: `status` stays `SUCCESS` after a stop, a starting or sleeping deployment reads `deploymentStopped: true`, and `traefik/whoami` accepts a stop that Railway then never reports. |
| 7–12 | `src/server/console/derive-state.ts` and its test | The heart. One pure function from Railway's report to a state and the allowed actions. `status` is read first, the flag only under `SUCCESS`. The `REFUSALS` table is exhaustive by type. The test replays the recorded probe run. |
| 12–17 | `src/server/railway/` : `api.ts`, `transport.ts`, `errors.ts`, `schemas.ts`, `budget.ts`, `fake.ts` | The only code that knows Railway exists. Errors arrive as HTTP 200, so they are classified from the body. Only unanswered queries are retried. Statuses are parsed as strings so a new one becomes "unknown" instead of a crash. The fake computes state from the clock, so tests advance time instead of waiting. |
| 17–23 | `src/server/console/service.ts` | `write()` puts every mutation through a serial queue, reads Railway before and after. `create` is idempotent on the operation id because the id is the service name and Railway refuses duplicates. `settle` is "look before repeating". `bringUp` is shared by create and start. |
| 23–25 | `reader.ts`, `view.ts` | Single-flight cache: ten tabs, one request. A slower earlier read cannot overwrite a newer one. Only names matching `spin-` plus 8 characters are ever listed or touched. |
| 25–27 | `src/server/http/respond.ts`, `src/server/auth/` | Reads are open. `handleWrite` is the one gate: same origin, then a signed cookie. The passphrase is a cost barrier and I call it that. |
| 27–29 | `src/components/container-card.tsx`, `src/hooks/use-console-state.ts` | One query. The server says how fast to poll. "Accepted" and "reported" are different things, and the card shows both. |
| 29–30 | `docs/erd.md`, "Next" | Login with Railway first, then a database when there are many users. |

## Where things are

```
scripts/probe.mts            the API probe (5 scenarios) and an image vetting command
scripts/check-bundle.mts     fails if the API host or a secret is in the client bundle
schema/railway.graphql       Railway's schema, introspected without a token
tests/fixtures/probe/        raw request/response logs from the probe, replayed by tests
src/server/railway/          Railway client, error classification, budget, fake
src/server/console/          deriveState, service (use cases), reader (cache), queue, view
src/server/auth/             signed session cookie, attempt throttle
src/server/http/respond.ts   JSON helpers and the write gate
src/server/runtime.ts        composition root: the one place that picks real or fake
src/app/api/                 route handlers, each a few lines
src/components/, src/hooks/  the page
e2e/console.spec.ts          one Playwright pass at phone width against the fake
```

## Questions I expect, and my answers

**1. Why no database?**
Because the only data is Railway's. A table of containers would be a second copy of the truth, and then I need a reconciler for when the copies disagree: someone deletes a service in the dashboard, or my server dies between Railway's write and mine. With Railway as the single source there is nothing to reconcile. What I give up is history, per-user data and a cap that holds across several instances. That is the first thing I would add for a real product.

**2. What happens on a double click?**
Three layers. The button disables while the request is in flight. If two requests still arrive, they carry the same operation id, the serial queue runs them one after the other, and the second finds the service already listed. If two app instances raced, Railway itself refuses the second `serviceCreate` with "already exists", which I observed with two simultaneous calls, and the loser adopts the existing service.

**3. What if the server dies halfway through a create?**
The service exists on Railway in whatever step it reached, and that is what the screen shows: for example "Created, not deployed" with a Spin up button. Pressing create again with the same operation id, or pressing Spin up, runs only the missing steps: a domain if there is none, then the deploy. Nothing is lost because nothing was only in memory.

**4. Why polling instead of subscriptions?**
A stop does not change `status`, so a status subscription would not report it, and my one attempt to subscribe with a project token failed. I would still need polling as a fallback, so I built only the polling. It is driven by the browser, so with no tab open the app makes no Railway requests at all.

**5. How do you stay inside the rate limit?**
Railway does not send the remaining budget (the docs say it does; I never saw the header in 447 responses), so I count requests myself. Reads spend from a token bucket that refills at 80% of the limit taken from `RateLimit-Policy`, with a burst of 20. That gives a hard bound: at 1,000 an hour, at most 820 reads, whatever browsers do. All tabs share one cached read. The footer shows the count.

**6. Why Zod instead of generated GraphQL types?**
Generated types describe what the schema promises at build time. What bit me in the probe was runtime behaviour. So I parse every response with Zod, and a test validates each document against the committed schema, which catches drift the way codegen would. With nine documents, hand-written schemas were less work than the tooling. With fifty I would switch to codegen and keep Zod only at the edges that matter.

**7. Is the passphrase real security?**
No, and the docs say so. It is one shared secret that stops a stranger spending my credit. It is compared in constant time, exchanged for an HMAC-signed HttpOnly SameSite=Lax cookie, and wrong attempts are throttled per address. It has no users, no revocation short of changing the secret, and the throttle is per instance. The real answer is Login with Railway, so each visitor acts as themselves.

**8. What breaks with two instances of the app?**
Duplicates still cannot happen, because Railway's name uniqueness is the lock. The cap can be exceeded by a race between instances, each instance counts its own budget, and each has its own throttle. The fix is to move those three into shared storage, at which point the database earns its place.

**9. What surprised you about the API?**
That `deploymentStop` returns `true` for `traefik/whoami`, the container goes down, and the API keeps reporting it as running. I tested timing and restart policy and could not find the cause; my guess is the exit code. It made me add an image vetting command and it is why the UI separates "accepted" from "reported". Smaller ones: `traceId` is on the error object, not in `extensions`; `BAD_USER_INPUT` comes back as HTTP 200; a missing service answers "Not Authorized".

**10. What did you do, and what did Claude do?**
Claude Code wrote the code, the probe and the first drafts of the documents, working from a brief I prepared. I set the constraints (small and stateless, two projects, the cost guards, phone first), did the account and secret steps, reviewed the ERD before the build and accepted what the probe changed. I am here to show I understand it well enough to change it.

**11. What is the weakest part?**
The app is exactly as right as Railway's report, and I have shown the report can be wrong. A check that pings each container's URL and flags a disagreement is on the list. Second: `crashed` and `failed` have never been seen against the real API, because no probe deploy failed.

**12. Why route handlers and not server actions or tRPC?**
Route handlers are plain functions from `Request` to `Response`, so the tests call them directly with no framework running. The browser polls, which wants a GET endpoint anyway. I use tRPC at work and like it; for seven endpoints it would be one more thing to read.

## Bugs worth telling

- **Refusals came back as HTTP 500 in the real server, and every unit test passed.** Next.js loads a module once per bundle, so an error thrown by the runtime's copy of `ConsoleError` was not an `instanceof` the route's copy. I found it by running the lifecycle against real Railway through `next dev`. Errors are now matched by name, and the Playwright test checks a refusal through the production build.
- **After a stop, the page would have waited 15 seconds to notice.** Railway reports "running" for a second or two after accepting a stop, so no state says "about to change". The server now asks browsers to poll fast for 20 seconds after any write.
- **A stale repeat of a create could restart a stopped container.** Create now brings a service up only if it has never been deployed.
- **A delete that outlived the timeout.** On the live app one `serviceDelete` took more than 15 seconds. The transport gave up, the service looked at Railway, saw the container gone and reported success: "look before repeating" doing its job in production. Writes now get 30 seconds.

## How I would extend it

1. **Login with Railway.** Replace `Sessions` and the passphrase with OAuth; the Railway client takes the visitor's token instead of mine; the sandbox becomes "a project you pick". `RailwayApi` does not change.
2. **Operations table.** Postgres with one row per requested operation, a worker that drives each row to done, and the cap enforced in a transaction. `ConsoleService.write` becomes "insert a row", and `settle` becomes the worker's retry rule.
3. **Logs.** Add `deploymentLogs` to `RailwayApi`, a `/api/containers/[id]/logs` route and a collapsible panel on the card.
4. **Report versus reality.** A server-side HEAD request to each running container's URL, shown as a second line under "Railway reports".
5. **More images.** Each one goes through `npm run probe -- imageStop <image>` first.
