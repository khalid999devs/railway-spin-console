# What Railway's API did when I probed it

Before writing any app code I ran `scripts/probe.mts` against an empty sandbox project to see how the public GraphQL API behaves for the exact calls this app makes.

- **When:** 5 Oct 2026, 19:58 to 20:18 UTC.
- **Account:** Trial plan, one project token scoped to the sandbox's `production` environment.
- **Volume:** 5 scenarios, 447 requests, 12 services created and all deleted.
- **Raw logs:** `tests/fixtures/probe/*.json` (every request, response and state change, no secrets). The unit tests replay snapshots from them.

Everything below marked **Observed** I saw in those runs. **Not confirmed** means I did not see it and the app does not rely on it.

## 1. A stop that Railway accepts but never reports

**Observed, 10 of 10 attempts across 6 deployments.** `deploymentStop` on a running `traefik/whoami` deployment returns `true`, the deployment log prints `Stopping Container`, and the container's URL stops answering. But the API goes on reporting the deployment as `status: SUCCESS`, `deploymentStopped: false`, instance `RUNNING`, for as long as I watched (120 s in one run). A second and third stop also return `true` and change nothing.

The same call on `nginx:alpine`, `httpd:alpine` and `caddy:alpine` works: the deployment reads `deploymentStopped: true`, instance `EXITED`, within 1.6 to 3.4 s.

| Checked | Result |
|---|---|
| Timing (stop 0.4 s after `SUCCESS`, or 10 s after) | No difference; fails both ways for whoami, works both ways for nginx |
| Restart policy (`ON_FAILURE` default, or `NEVER`) | No difference |
| Container restarted by Railway after the stop? | No; the log shows one start and one stop |
| `deploymentRestart` afterwards | Works; URL answers again within 0.5 s |

**Not confirmed:** the cause. My guess is the exit code: `traefik/whoami` is a bare Go binary that does not handle `SIGTERM`, so it exits non-zero, while the other three exit cleanly. I could not check this from outside.

**What I did about it:** `traefik/whoami` was in my planned image list and I removed it. An image is now allowed only after `node scripts/probe.mts imageStop <image>` shows that Railway reports its stop. The app shows what Railway reports, so for an image like this it would show "running" for a stopped container; the UI says a stop was accepted and that Railway has not confirmed it, rather than showing "stopped" on its own authority.

## 2. Where the API differs from the docs

| # | Docs | Observed |
|---|---|---|
| 1 | The error example puts `traceId` inside `extensions`. | `traceId` is on the error object itself, next to `message`, in all 8 error responses I received (7 distinct messages). `extensions` held only `code`. |
| 2 | The error table lists `BAD_USER_INPUT` as HTTP 400. | It came back as HTTP 200 every time (duplicate service name, `numReplicas: 0`, stopping a sleeping deployment). |
| 3 | Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. | None of the three appeared on any of 447 authenticated responses. Only `RateLimit-Policy` did. A client cannot read how much budget is left; it has to count its own requests. |
| 4 | Limits are listed for Free (100/h), Hobby (1,000/h) and Pro. Trial is not listed. | My Trial account reported `"default";q=1000;w=3600`. |
| 5 | The "list deployments" example filters with `status: { successfulOnly: true }`. | The schema's `DeploymentStatusInput` has only `in` and `notIn`. (Read from the schema, not executed.) |
| 6 | `deploymentRestart` is described as restarting a running deployment. | It also resumes a stopped one, with the same instance id, in about a second. Useful, and undocumented. |

## 3. How a deployment's state reads over time

One request, `environment(id) { serviceInstances { ... latestDeployment { status deploymentStopped instances { status } } } }`, returns everything. These are the sequences I saw, polling once a second.

**After `serviceCreate`:** `latestDeployment` is `null`. Creating a service does not deploy it.

**After `serviceInstanceDeployV2`** (11 deploys, 5.7 to 12.9 s to finish):

| Time | `status` | `deploymentStopped` | instances |
|---|---|---|---|
| +0.3 s | `INITIALIZING` | `true` | none |
| +1.6 s | `DEPLOYING` | `true` | `INITIALIZING` |
| +2.9 s | `DEPLOYING` | `true` | `CREATED` |
| +4.3 s | `DEPLOYING` | `true` | `RUNNING` |
| +9.8 s | `SUCCESS` | `false` | `RUNNING` |

**After `deploymentStop`** (on an image that stops cleanly): for 0.3 to 1.5 s nothing changes, then `SUCCESS` / `true` / `EXITED`. `status` stays `SUCCESS` and `statusUpdatedAt` does not move.

**After `deploymentRestart` on a stopped deployment:** the first read, 0.3 s after the mutation returned, already shows `SUCCESS` / `false` / `RUNNING` with the same instance id.

**After a second `serviceInstanceDeployV2`:** a new deployment becomes `latestDeployment`; the old one reads `REMOVING` and then `REMOVED` within 15 s.

**After 7.8 and 8.2 minutes without traffic** (serverless sleep on): `SLEEPING` / `true` / `RUNNING`. The first HTTP request woke it and got a 200 in 1.5 s; the state then read `SUCCESS` / `false` / `RUNNING`.

### Three traps for anyone deriving "is it up?"

1. A stopped deployment still has `status: SUCCESS`. Reading `SUCCESS` as "up" shows a stopped container as running.
2. A starting deployment has `deploymentStopped: true`. Reading that flag first shows a starting container as stopped.
3. A sleeping deployment has `deploymentStopped: true` **and** an instance that reads `RUNNING`. Reading instances first shows a sleeping container as running; reading the flag first shows it as stopped.

The order that works: transitional and terminal statuses first, and `deploymentStopped` and instances only when `status` is `SUCCESS`.

One more: an instance reads `RUNNING` about 5 s before the deployment reads `SUCCESS`, and the URL returns 404 during that gap. "Running" needs both.

## 4. Errors

**Observed:** every failure I triggered arrived as HTTP 200 with an `errors` array. (I did not send a malformed document, which the docs say returns 400.)

| Call | `message` | `extensions.code` |
|---|---|---|
| Project token sent as `Authorization: Bearer` | `Project Token not found` | `INTERNAL_SERVER_ERROR` |
| `deploymentStop` with an unknown id | `Deployment not found` | `INTERNAL_SERVER_ERROR` |
| `serviceDelete` with an unknown id | `Not Authorized` | `INTERNAL_SERVER_ERROR` |
| `serviceCreate` with a name already in use | `A service named "…" already exists in this project` | `BAD_USER_INPUT` |
| `serviceInstanceUpdate` with `numReplicas: 0` | `Error in numReplicas - Invalid input` | `BAD_USER_INPUT` |
| `deploymentStop` on a sleeping deployment | `Deployment is not stoppable` | `BAD_USER_INPUT` |
| `deploymentRestart` on a sleeping deployment | `Deployment is not restartable` | `BAD_USER_INPUT` |

Two consequences. An authorization failure and a missing resource can look the same (`Not Authorized` for a service that does not exist), so after a failed delete the app re-reads the listing instead of trusting the message. And `INTERNAL_SERVER_ERROR` covers both "you sent the wrong header" and "no such deployment", so the code alone is not enough to classify an error; the app uses the message too.

## 5. What a project token can do

**Observed:** with only the `Project-Access-Token` header, the token could run `projectToken`, `environment`, `deployment`, `deploymentLogs`, `serviceInstance`, `serviceCreate`, `serviceInstanceUpdate`, `serviceInstanceDeployV2`, `serviceDomainCreate`, `deploymentStop`, `deploymentRestart` and `serviceDelete`. That is everything this app needs, so no account token is used.

`projectToken { projectId environmentId }` returns both ids, so nothing is configured by hand.

**Observed, once:** a `graphql-transport-ws` subscription to `deployment(id)` with the token in the connection payload was acknowledged and then answered `{"errors":[{"message":"Problem processing request"}]}`. I tried one way of passing the token, so this shows that my attempt failed, not that subscriptions are impossible with a project token.

## 6. Idempotency

- **Observed:** service names are unique per project. Two `serviceCreate` calls with the same name, sent at the same moment, produced one service and one `already exists` error. This is what the app's idempotent create rests on.
- **Observed:** `serviceDomainCreate` is not idempotent. A second call on the same service created a second domain (`…-production-38b4.up.railway.app`). The app checks for an existing domain first.
- **Observed:** `deploymentStop` on an already stopped deployment returns `true` and changes nothing.

## 7. Domains

- **Observed:** a domain can be created before the first deploy. The URL returns 404 until the deployment reads `SUCCESS` and 200 from then on, so the app creates the domain first and the URL is ready the moment the container is.
- **Observed:** a domain added to a running container answered 200 within 0.9 s and did not trigger a redeploy.
- **Observed:** requests to a stopped container's URL hang (no response within 8 s) rather than failing quickly.

## 8. Deleting

**Observed, 12 deletes:** `serviceDelete` took 2.7 to 7.3 s to return, and the service was missing from the very next listing every time, including when deleted mid-deploy. I did not see a deleted service linger in the listing.

**Observed later, on the deployed app:** one `serviceDelete` had not answered after 15 s, the app's timeout at the time. The service was gone from the listing when the app checked. So the call can be much slower than the probe suggested, and a client should not treat a timeout as a failure.

## 9. Not confirmed, or still open

- Whether `deploymentRestart` still resumes a deployment that has been stopped for hours. I tested stops of up to two minutes. If it fails, the app falls back to a fresh deploy.
- Whether a stopped deployment is billed. I will check the usage page a day after the probe and record the answer in the README.
- What a crashed or failed image deploy looks like. None of my deploys failed, so `crashed` and `failed` in the app come from the schema's enum, not from observation.
- Behaviour at the rate limit (HTTP 429 and `Retry-After`). I stayed under half the hourly budget on purpose.
