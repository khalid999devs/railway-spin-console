# ERD: Spin Console

**Status:** built and deployed, 6 Oct 2026. **Author:** Khalid Ahammed.

## Problem

Railway's take-home: an app with a UI that spins a container up and down through the public GraphQL API, deployed on Railway. The app is public and spends my credit, so two things must hold beyond the happy path. The screen never shows a state Railway is not reporting, and nothing a visitor does (double click, refresh, lost response) creates a duplicate, an orphan or a bill.

## Shape

```
browser ── /api/* ──> Next.js server ──────────────> Railway GraphQL API
 (polls)              ├ serial queue for writes        (sandbox project only,
                      ├ single-flight read cache        project token)
                      └ request budget
```

One Next.js app (App Router, TypeScript), one Railway service, no database. A server is required: the API's CORS policy allows only `railway.com`, and the token must not reach a browser.

## Decisions

**1. Railway is the only source of truth.** The app stores nothing about containers; every state on screen comes from one read of the sandbox environment. A refresh, an app restart or a deletion in Railway's dashboard cannot make the app disagree with reality.
*Rejected: a database with an operations table.* It buys history and crash recovery, and costs a second service, migrations and a reconciler to keep two copies of the truth in step. Too much machinery for three containers; first thing to add for many users.

**2. Two projects, one narrow credential.** The app runs in one project and creates containers in a separate sandbox project, holding only a project token for the sandbox. A bug in "destroy" cannot reach the app, and a leaked token cannot reach the rest of my account.
*Rejected: an account token.* It works, and can delete everything I own.

**3. "Down" means stop, not delete.** Up = create service, add domain, enable sleep, deploy. Down = `deploymentStop`; the service and URL stay. Up again = `deploymentRestart`, which resumes the same instance in about a second, against 6 to 13 s for a fresh deploy. Destroy = `serviceDelete`.
*Rejected: scale to zero* (the API refuses `numReplicas: 0`) *and delete-as-down* (loses the URL and the fast resume).

**4. One pure function decides state and actions.** `deriveState(instance, now)` returns the state and, per action, whether it is allowed and why not. The server sends both, so a button is disabled for the reason the API would refuse the call. Anything unrecognised becomes `unknown` and shows Railway's raw values.

**5. Create is idempotent without a database.** The browser makes an operation id per click; the server names the service `spin-<id>`. Railway rejects a duplicate name (two simultaneous creates in the probe produced exactly one), so a repeated request finds the existing service and continues from the missing step. Writes run one at a time through an in-process queue, which makes the three-container cap race-free on one instance. After a call with no response, the server reads Railway before repeating it.
*Rejected: an idempotency-key table.* Railway's uniqueness rule already is one.

**6. Polling, paced by a token bucket.** The browser polls the app at the pace the server asks for: every 2 s during a transition and for 20 s after any write, every 15 s otherwise, never while the tab is hidden. The server answers from a single-flight cache, so ten tabs cost what one does. Each Railway read spends a token from a bucket sized from the `RateLimit-Policy` header (at 1,000/hour: one token per 4.5 s, burst of 20), which caps reads at 820 an hour whatever browsers do. On a 100/hour plan the same code idles at 90 s.
*Rejected: subscriptions.* My attempt with a project token failed, and a stop does not change `status`, so polling would still be needed. *Rejected: a background poller.* It spends requests when nobody is looking.

**7. One module knows Railway exists, and checks what arrives.** It picks the auth header, classifies errors from the body (they arrive as HTTP 200), keeps the `traceId`, retries only when there was no answer, and parses every response with Zod. A test validates each GraphQL document against the committed schema. An in-memory fake behind the same interface reproduces what the probe saw; tests use it, and `RAILWAY_FAKE=1` runs the app without a token.
*Rejected: gql.tada or codegen.* They type what the schema promises; the probe showed the risk is in what arrives.

## What the probe changed

Details in [api-findings.md](api-findings.md).

- **`traefik/whoami` is out.** Railway accepts its stop, then reports it running indefinitely although the container is down. An image is allowed only after `probe imageStop` shows its stop is reported: `nginx:alpine`, `httpd:alpine`, `caddy:alpine`.
- **A stop is "accepted", not "done".** `deploymentStop` returns `true` either way. The UI shows "stop accepted, waiting for Railway" beside the real state, and says so if Railway never confirms.
- **A sleeping container cannot be stopped or restarted;** the API refuses both, so those buttons are disabled with that reason. It also reads `deploymentStopped: true` with a `RUNNING` instance, so `status` is checked first.
- **Railway does not report remaining budget,** so the app counts its own requests.
- **The domain is created before the deploy,** so the URL is ready when the container is.

## States

| State | Railway reports | Allowed |
|---|---|---|
| `idle` | no deployment | start, destroy |
| `starting` | `INITIALIZING`, `BUILDING`, `DEPLOYING`, `QUEUED`, `WAITING`; or `SUCCESS` with its instance still starting | destroy |
| `running` | `SUCCESS`, not stopped, an instance `RUNNING` | stop, destroy |
| `stopping` | `SUCCESS`, stopped, an instance not yet exited | destroy |
| `stopped` | `SUCCESS`, stopped, instances exited; or `REMOVED` | start, destroy |
| `sleeping` | `SLEEPING` | destroy (wake by URL) |
| `crashed`, `failed` | `CRASHED`, `FAILED` | start (fresh deploy), destroy |
| `removing` | `REMOVING` | none |
| `expired` | older than 30 minutes | none (being destroyed) |
| `unknown` | anything else, shown raw | destroy |

## Cost guards

1. Reads are open; writes need a passphrase, exchanged for a signed HttpOnly cookie, wrong attempts throttled. A cost barrier, not authentication.
2. At most 3 containers, stopped ones included.
3. A fixed list of probed images; no free-text field.
4. A 30-minute lifetime, enforced on every read and by a one-minute tick that calls Railway only when a container is due.
5. Serverless sleep on every container, and a hard usage limit on the account.
6. Only services in the sandbox listing named `spin-` plus 8 characters, the form the app generates, are ever shown or touched.

## Known limits

- **One app instance.** Queue, cache, budget and throttle are in memory. Two instances could not create duplicates but could race past the cap.
- **As right as Railway's report.** The whoami case shows the API can be wrong about a container; the app repeats what it is told.
- **No history** of who did what.
- **Lifetime needs the app running.** While it is down, containers outlive 30 minutes; sleep bounds the cost.
- **`crashed` and `failed` are untested against the real API;** no probe deploy failed.

## Measuring success

Here: the smoke test in the README passes at phone width, the sandbox is empty afterwards, and the screen matched Railway's dashboard at every step. As a product: time from click to a reachable URL (target under 15 s, mostly Railway's deploy), share of actions needing a second attempt, API requests per active hour against budget, and orphans found by a daily sweep (target zero).

## Next

1. **Login with Railway (OAuth):** each visitor uses their own account; my token and the passphrase disappear.
2. **Postgres operations table and reconciler** for many users or instances: history, crash recovery, a transactional cap.
3. **Logs on each card** from `deploymentLogs`.
4. **Push instead of poll,** if subscriptions or webhooks work for the auth type.
5. **Report-versus-reality check:** ping each container's URL and flag when Railway says running and nothing answers.
