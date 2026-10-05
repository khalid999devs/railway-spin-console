# ERD: Spin Console

**Status:** draft for review, 6 Oct 2026. **Author:** Khalid Ahammed.

## Problem

Railway's take-home: build an app with a UI that spins a container up and down through the public GraphQL API, deployed on Railway. The app is small, but it is public and it spends my credit, so two things have to hold beyond the happy path. The screen must never show a state Railway is not reporting, and nothing a visitor does (double click, refresh, lost response, wrong passphrase) may create a duplicate, an orphan or a bill.

## Shape

```
browser ── /api/* ──> Next.js server ──────────────> Railway GraphQL API
 (polls)              ├ serial queue for writes        (sandbox project only,
                      ├ single-flight read cache        project token)
                      └ request budget
```

One Next.js app (App Router, TypeScript), one Railway service, no database. The browser cannot call Railway directly: the endpoint's CORS policy allows only `railway.com`, and the token must stay on the server.

## Decisions

**1. Railway is the only source of truth.** The app stores nothing about containers. Every state on screen is derived from one read of the sandbox environment, so a refresh, an app restart or a deletion made in Railway's dashboard cannot leave the app disagreeing with reality.
*Rejected: a database with an operations table.* It buys an audit history and crash recovery, and costs a second service, migrations and a reconciler to keep two copies of the truth in step. For three containers and one operator that is more machinery than the problem has. It is the first thing I would add for many users (see "Next").

**2. Two projects, one narrow credential.** The app runs in one project and creates containers in a separate sandbox project, holding only a project token for the sandbox. A bug in "destroy" cannot reach the app, and a leaked token cannot reach the rest of my account. The probe confirmed a project token can do every call the app needs.
*Rejected: an account token.* It works, and can delete everything I own.

**3. "Down" means stop, not delete.** Spin up = create service, add domain, turn on sleep, deploy. Spin down = `deploymentStop`; the service and its URL stay. Spin up again = `deploymentRestart`, which the probe showed resumes the same instance in about a second, against 6 to 13 seconds for a fresh deploy. Destroy = `serviceDelete`.
*Rejected: scale to zero* (`numReplicas: 0` is refused by the API) *and delete-as-down* (loses the URL and the fast resume).

**4. One pure function decides state and actions.** `deriveState(instance, now)` returns the state and, for each action, whether it is allowed and why not. The server sends both, so a button is disabled for the same reason the API would refuse the call. Anything unrecognised becomes `unknown` and shows Railway's raw values instead of a guess.

**5. Create is idempotent without a database.** The browser makes an operation id per click and the server names the service `spin-<id>`. Railway rejects a second service with the same name (in the probe, two simultaneous creates produced exactly one), so a repeated request finds the existing service and carries on from whichever step is missing. Writes run one at a time through an in-process queue, which makes the three-container cap race-free on one instance. After a call that got no response, the server reads Railway before repeating it.
*Rejected: an idempotency-key table.* Railway's own uniqueness rule already is one.

**6. Polling, paced by a token bucket.** The browser polls the app: every 2 s while something is in transition, every 15 s otherwise, never while the tab is hidden. The server answers from a single-flight cache, so ten tabs cost what one does, and each Railway read spends a token from a bucket sized from the `RateLimit-Policy` header (at 1,000/hour: one token per 4.5 s, burst of 20). That caps reads at 820 an hour whatever the browsers do and leaves the rest for writes. On a 100/hour plan the same code idles at 90 s.
*Rejected: GraphQL subscriptions.* My one attempt with a project token failed, and a stop does not change `status`, so polling would still be needed. *Rejected: a background poller.* It spends requests when nobody is looking.

**7. Runtime checks at the boundary instead of generated types.** Each response is parsed with Zod, and a test validates every GraphQL document against the committed schema.
*Rejected: gql.tada or codegen.* They type what the schema promises. The probe showed the risk is in what actually arrives, and the validation test already catches schema drift.

**8. One module knows Railway exists.** It picks the auth header, classifies errors from the response body (they arrive as HTTP 200), keeps the `traceId`, and retries only when there was no answer. It sits behind an interface with an in-memory fake that reproduces what the probe saw. Tests use the fake, and `RAILWAY_FAKE=1` runs the whole app without a token.

## What the probe changed

Full notes are in [api-findings.md](api-findings.md). The ones that changed the design:

- **`traefik/whoami` is out.** Railway accepts a stop for it and then reports it as running indefinitely, although the container is down. Images are allowed only after `probe imageStop` shows their stop is reported: `nginx:alpine`, `httpd:alpine`, `caddy:alpine`.
- **A stop is "accepted", not "done".** `deploymentStop` returns `true` whether or not anything happens. The UI shows "stop accepted, waiting for Railway" beside the real state, and says so plainly if Railway never confirms.
- **A sleeping container cannot be stopped or restarted;** the API refuses both. Those buttons are disabled with that reason. Opening the URL wakes it.
- **Sleeping reads `deploymentStopped: true` with a `RUNNING` instance,** a third trap beside the two I expected. `status` is checked first.
- **Railway does not report remaining budget** (no `X-RateLimit-Remaining`), so the app counts its own requests.
- **The domain is created before the deploy,** so the URL exists the moment the container is up.

## States

| State | Railway reports | Allowed |
|---|---|---|
| `idle` | no deployment | start, destroy |
| `starting` | `INITIALIZING`, `BUILDING`, `DEPLOYING`, `QUEUED`, `WAITING`; or `SUCCESS` with its instance still starting | destroy |
| `running` | `SUCCESS`, not stopped, an instance `RUNNING` | stop, destroy |
| `stopping` | `SUCCESS`, stopped, an instance not yet exited | destroy |
| `stopped` | `SUCCESS`, stopped, all instances exited; or `REMOVED` | start, destroy |
| `sleeping` | `SLEEPING` | destroy (wake by URL) |
| `crashed` / `failed` | `CRASHED` / `FAILED` | start (fresh deploy), destroy |
| `removing` | `REMOVING` | none |
| `expired` | older than 30 minutes | none (being destroyed) |
| `unknown` | anything else, shown raw | destroy |

## Cost guards

1. Reads are open; writes need a passphrase, exchanged for a signed HttpOnly cookie, with wrong attempts throttled. It is a cost barrier, not authentication.
2. At most 3 containers, stopped ones included.
3. A fixed list of probed images; no free-text image field.
4. A 30-minute lifetime, enforced by a one-minute tick that calls Railway only when a container is due.
5. Serverless sleep on every container, and a hard usage limit on the account.
6. Destroy only ever targets services in the sandbox listing whose name starts with `spin-`.

## Known limits

- **One app instance.** The queue, cache, budget and throttle live in memory. Two instances could not create duplicates, but could race past the cap and would each count their own budget.
- **As right as Railway's report.** The whoami case shows the API can be wrong about a container; the app repeats what it is told.
- **No history.** Nothing records who did what.
- **Lifetime needs the app running.** If the app is down, containers outlive 30 minutes until it next boots; sleep bounds the cost meanwhile.
- **`crashed` and `failed` are untested against the real API.** No probe deploy failed.

## Measuring success

For this take-home: the smoke test passes from a phone-width browser, the sandbox is empty afterwards, and the state on screen matched Railway's dashboard at every step. As a product I would track time from click to a reachable URL (target: under 15 s, which is mostly Railway's deploy time), share of actions that needed a second attempt, API requests per active hour against budget, and orphaned services found by a daily sweep (target: zero).

## Next

1. **Login with Railway (OAuth).** Each visitor uses their own account, and my token and the passphrase disappear.
2. **Postgres operations table and reconciler,** once there are several users or instances: history, crash recovery, a cap enforced in a transaction.
3. **Logs on each card** from `deploymentLogs`.
4. **Push instead of poll,** if subscriptions or webhooks work for the auth type in use.
5. **Report-vs-reality check:** ping the container's URL and flag when Railway says running and nothing answers.
