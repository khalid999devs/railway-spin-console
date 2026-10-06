# Design document: Spin Console

Khalid Ahammed · October 2026

## Problem

Build an app with a UI that spins a container up and down through Railway's public GraphQL API, and deploy it on Railway.

The app is public and uses a real Railway account, so two things must hold beyond the happy path:

1. **The screen never shows a state Railway is not reporting.**
2. **Nothing a visitor does creates a duplicate, an orphan or a bill.** This includes a double click, a page refresh, and a response that never arrives.

## Overview

```
browser ── /api/* ──> Next.js server ──────────────> Railway GraphQL API
 (polls)              ├ serial queue for writes        (sandbox project only,
                      ├ single-flight read cache        project token)
                      └ request budget
```

One Next.js app (App Router, TypeScript) deployed as one Railway service, with no database. A server is required because the API's CORS policy allows only `railway.com` and the token must not reach a browser.

## Decisions

### 1. Railway is the only source of truth

The app stores nothing about containers. Every state on the screen comes from one read of the sandbox environment. A refresh, an app restart, or a deletion made in Railway's dashboard cannot make the app disagree with reality.

**Alternative not chosen:** a database with an operations table. It adds history and crash recovery, but also a second service, migrations, and a reconciler to keep two copies of the truth in step. That is too much for three containers. It is the first thing to add for many users.

### 2. Two projects and one narrow credential

The app runs in one Railway project and creates containers in a separate sandbox project. It holds only a project token for the sandbox. A bug in "destroy" cannot reach the app itself, and a leaked token cannot reach the rest of the account.

**Alternative not chosen:** an account token. It works, but it can delete everything in the account.

### 3. "Down" means stop, not delete

| Action | Railway call | Result |
|---|---|---|
| Spin up (new) | create service, add domain, enable sleep, deploy | A running container with a URL |
| Spin down | `deploymentStop` | The container stops; the service and URL stay |
| Spin up (again) | `deploymentRestart` | The same instance resumes in about a second |
| Destroy | `serviceDelete` | The service and URL are deleted |

Resuming takes about a second, compared with 6 to 13 seconds for a fresh deploy.

**Alternatives not chosen:** scaling to zero, because the API refuses `numReplicas: 0`; and deleting on "down", because it loses the URL and the fast resume.

### 4. One pure function decides state and actions

`deriveState` takes what Railway reports about a service and returns its state, plus whether each action is allowed and, if not, why. The server sends both to the browser, so a button is disabled for the same reason the API would refuse the request. Anything unrecognised becomes `unknown` and shows Railway's raw values.

### 5. Create is safe to repeat, without a database

The browser generates an operation id for each click, and the server names the service `spin-<id>`. Railway rejects a duplicate name, even for two requests sent at the same moment, so a repeated request finds the existing service and continues from the step that is missing.

Writes run one at a time through a queue inside the server, which makes the three-container limit exact on a single instance. After a call that got no response, the server reads Railway before sending the call again.

**Alternative not chosen:** an idempotency-key table. Railway's uniqueness rule already does that job.

### 6. Polling, paced by a token bucket

The browser polls the app at a pace the server sets: every 2 seconds while something is changing and for 20 seconds after any write, every 15 seconds otherwise, and not at all while the tab is hidden.

The server answers from a shared cache, so ten open tabs cost the same as one. Each read of Railway spends a token from a bucket sized from the `RateLimit-Policy` header. At 1,000 requests an hour that is one token every 4.5 seconds with a burst of 20, which caps reads at 820 an hour regardless of how many browsers are polling. On a 100-per-hour plan the same code polls every 90 seconds when idle.

**Alternatives not chosen:** GraphQL subscriptions, because a stop does not change `status` and so would not be reported, which means polling would still be needed; and a background poller, because it spends requests when nobody is looking.

### 7. One module knows about Railway and validates what arrives

A single module chooses the auth header, classifies errors from the response body (they arrive as HTTP 200), keeps the `traceId`, retries only when there was no answer, and validates every response with Zod. A test checks each GraphQL document against Railway's schema.

An in-memory fake sits behind the same interface and behaves like the real API. The tests use it, and `RAILWAY_FAKE=1` runs the whole app without a token.

**Alternative not chosen:** generated GraphQL types. They describe what the schema promises, while the risk here is in what actually arrives.

## What testing the real API changed

The API was tested before the app was designed. The full results are in [api-findings.md](api-findings.md). These findings shaped the design:

- **Images are allow-listed after testing.** For `traefik/whoami`, Railway accepts a stop and then keeps reporting the container as running. The app offers only `nginx:alpine`, `httpd:alpine` and `caddy:alpine`, each confirmed to stop and report correctly.
- **A stop is "accepted", not "done".** `deploymentStop` returns `true` before the container has stopped. The interface shows "stop accepted, waiting for Railway" next to the real state.
- **A sleeping container cannot be stopped or restarted.** The API refuses both, so those buttons are disabled with that reason.
- **`status` is checked first.** A sleeping deployment reports `deploymentStopped: true` with a `RUNNING` instance, and a starting one also reports `deploymentStopped: true`.
- **The app counts its own requests,** because Railway does not report the remaining budget.
- **The domain is created before the deploy,** so the URL is ready when the container is.

## States

| State | What Railway reports | Allowed actions |
|---|---|---|
| `idle` | no deployment | start, destroy |
| `starting` | `INITIALIZING`, `BUILDING`, `DEPLOYING`, `QUEUED`, `WAITING`; or `SUCCESS` with its instance still starting | destroy |
| `running` | `SUCCESS`, not stopped, an instance `RUNNING` | stop, destroy |
| `stopping` | `SUCCESS`, stopped, an instance not yet exited | destroy |
| `stopped` | `SUCCESS`, stopped, instances exited; or `REMOVED` | start, destroy |
| `sleeping` | `SLEEPING` | destroy (the URL wakes it) |
| `crashed`, `failed` | `CRASHED`, `FAILED` | start (fresh deploy), destroy |
| `removing` | `REMOVING` | none |
| `expired` | older than 30 minutes | none (being destroyed) |
| `unknown` | anything else, shown as raw values | destroy |

## Cost guards

1. **Passphrase for writes.** Reads are open. Writes need a passphrase, exchanged for a signed HttpOnly cookie, with wrong attempts throttled. It is a cost barrier, not authentication.
2. **At most 3 containers,** stopped ones included.
3. **A fixed list of tested images.** No free-text field.
4. **A 30-minute lifetime,** enforced on every read and by a one-minute timer that calls Railway only when a container is due.
5. **Serverless sleep** on every container, and a usage limit on the account.
6. **Only the app's own services are touched:** those named `spin-` plus 8 characters, the form the app generates.

## Known limits

- **Single instance.** The queue, cache, request budget and throttle are in memory. Two instances could not create duplicates, but could exceed the container limit.
- **The app is as accurate as Railway's report.** If the API reports a wrong status, the app shows it.
- **No history** of who did what.
- **The lifetime needs the app running.** While the app is down, containers live past 30 minutes; sleep keeps the cost low.
- **`crashed` and `failed` are not verified against the real API.** No test deployment failed.

## Measuring success

For this project: the live test in the README passes at phone width, the sandbox is empty afterwards, and the screen matches Railway's dashboard at every step.

As a product, the measures would be:

- time from click to a reachable URL (target under 15 seconds, most of which is Railway's deploy);
- the share of actions that need a second attempt;
- API requests per active hour against the budget;
- orphaned services found by a daily sweep (target zero).

## What to build next

1. **Login with Railway (OAuth).** Each visitor uses their own account, and the shared token and passphrase go away.
2. **A Postgres operations table and reconciler,** for many users or instances: history, crash recovery, and a limit enforced in a transaction.
3. **Logs on each card,** from `deploymentLogs`.
4. **Push instead of poll,** if subscriptions or webhooks are available for the auth type.
5. **A reachability check** that requests each container's URL and flags when Railway says running and nothing answers.
