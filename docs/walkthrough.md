# Code tour

A guide to reading the code: where to start, what each part does, and how the app could be extended.

## Reading order

The code is easiest to follow in this order.

| # | File | What it does |
|---|---|---|
| 1 | [`src/server/console/derive-state.ts`](../src/server/console/derive-state.ts) | The core of the app. One pure function turns what Railway reports about a service into a state and a list of allowed actions. |
| 2 | [`src/server/railway/api.ts`](../src/server/railway/api.ts) | The interface the rest of the app uses to talk to Railway. Nothing outside `src/server/railway` knows about GraphQL. |
| 3 | [`src/server/railway/transport.ts`](../src/server/railway/transport.ts) | Sends requests to Railway: the auth header, timeouts, error handling, and the rule that only unanswered queries are retried. |
| 4 | [`src/server/railway/errors.ts`](../src/server/railway/errors.ts) | Classifies errors. Railway returns most errors as HTTP 200, so they are read from the response body. |
| 5 | [`src/server/railway/budget.ts`](../src/server/railway/budget.ts) | Counts requests against Railway's hourly limit and paces reads with a token bucket. |
| 6 | [`src/server/console/service.ts`](../src/server/console/service.ts) | The use cases: create, start, stop, destroy, and automatic expiry. |
| 7 | [`src/server/console/reader.ts`](../src/server/console/reader.ts) | Reads the sandbox from Railway and shares one request between all visitors. |
| 8 | [`src/server/http/respond.ts`](../src/server/http/respond.ts) | The gate every write goes through: same origin, then a valid session. |
| 9 | [`src/app/api`](../src/app/api) | The route handlers. Each is a few lines that call the service. |
| 10 | [`src/components/container-card.tsx`](../src/components/container-card.tsx) | One container on the screen, its buttons, and the note that separates "accepted" from "reported by Railway". |
| 11 | [`src/server/railway/fake.ts`](../src/server/railway/fake.ts) | An in-memory Railway used by the tests and by `npm run dev:fake`. |

## How a request travels

**A read.** The page polls `GET /api/state`. The route handler asks `ConsoleService` for a snapshot. The service asks `SandboxReader`, which either returns its recent reading or makes one request to Railway. Each service is passed through `deriveState`, and the result is sent to the browser together with how soon to ask again.

**A write.** The page sends, for example, `POST /api/containers/{id}/stop`. `handleWrite` checks the request comes from the same site and carries a valid session cookie. `ConsoleService` then puts the work on a serial queue, reads Railway's current state, checks with `deriveState` that the action is allowed, calls Railway, reads the state again, and returns it.

## Key ideas in the code

- **Writes are serialised.** `ConsoleService.write` runs every change through one queue, starting and ending with a fresh read of Railway.
- **Create is safe to repeat.** The operation id sent by the browser becomes the service name. If the service already exists, `create` continues from whichever step is missing.
- **Unanswered writes are checked, not retried.** `settle` in `service.ts` asks Railway whether the change happened before sending it a second time.
- **Statuses are plain strings.** The response schemas do not restrict status values, so a status Railway adds later shows up as `unknown` instead of breaking the app.
- **The fake follows a clock.** `FakeRailway` computes each deployment's state from the time, so tests move a clock forward instead of waiting.

## Where things are

```
src/server/railway/          Railway client, error classification, request budget, fake
src/server/console/          deriveState, service, reader, queue, view
src/server/auth/             session cookie, attempt throttle
src/server/http/respond.ts   JSON helpers and the write gate
src/server/runtime.ts        wires the app together and picks the real client or the fake
src/app/api/                 route handlers
src/components/, src/hooks/  the page
scripts/                     API probe, live smoke test, bundle check
e2e/                         Playwright test
```

## Extending it

- **Login with Railway.** Replace the passphrase session with OAuth and pass each visitor's token to the Railway client. The `RailwayApi` interface stays the same.
- **A database.** Add an operations table and a worker that completes each operation. `ConsoleService.write` becomes "record the operation", and the container limit is enforced in a transaction.
- **Logs.** Add a `deploymentLogs` method to `RailwayApi`, a route that returns them, and a panel on the container card.
- **More images.** Add the image to `IMAGES` in [`src/server/config.ts`](../src/server/config.ts) after `npm run probe -- imageStop <image>` confirms Railway reports its stop.
