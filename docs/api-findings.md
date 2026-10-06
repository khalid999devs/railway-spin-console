# Railway API findings

How Railway's public GraphQL API behaves in practice for the calls this app makes, including the places where it differs from the documentation.

- **Tested:** 5 and 6 October 2026, with a project token on a Trial account.
- **Method:** [`scripts/probe.mts`](../scripts/probe.mts) runs each call against an empty project and records every request and response.
- **Recordings:** [`tests/fixtures/probe`](../tests/fixtures/probe). The unit tests replay them.

## Summary

- A stopped deployment still reports `status: SUCCESS`. The stop shows only in `deploymentStopped` and the instance status.
- A starting deployment and a sleeping deployment both report `deploymentStopped: true`.
- Errors arrive as HTTP 200 with an `errors` array, and the `traceId` is on the error object.
- The remaining rate-limit budget is not sent in response headers.
- Service names are unique within a project, even for two requests sent at the same moment.
- `deploymentRestart` resumes a stopped deployment in about a second.
- For one image, `traefik/whoami`, a stop is accepted but never reported.

## 1. Reading a deployment's state

One request returns the state of every service in an environment:

```graphql
environment(id: $id) {
  serviceInstances { edges { node {
    serviceId serviceName
    latestDeployment { status deploymentStopped instances { status } }
  } } }
}
```

**After `serviceCreate`,** `latestDeployment` is `null`. Creating a service does not deploy it.

**After `serviceInstanceDeployV2`,** a deployment takes 6 to 13 seconds to finish and reports:

| Time | `status` | `deploymentStopped` | Instance |
|---|---|---|---|
| +0.3 s | `INITIALIZING` | `true` | none |
| +1.6 s | `DEPLOYING` | `true` | `INITIALIZING` |
| +2.9 s | `DEPLOYING` | `true` | `CREATED` |
| +4.3 s | `DEPLOYING` | `true` | `RUNNING` |
| +9.8 s | `SUCCESS` | `false` | `RUNNING` |

The instance reads `RUNNING` about five seconds before the deployment reads `SUCCESS`. The public URL returns 404 during that gap.

**After a second deploy,** the new deployment becomes `latestDeployment` and the previous one reads `REMOVING`, then `REMOVED`.

### Three cases that are easy to misread

| Situation | `status` | `deploymentStopped` | Instance |
|---|---|---|---|
| Stopped | `SUCCESS` | `true` | `EXITED` |
| Starting | `DEPLOYING` | `true` | `CREATED` |
| Sleeping | `SLEEPING` | `true` | `RUNNING` |

- Treating `SUCCESS` as "running" shows a stopped container as running.
- Reading `deploymentStopped` first shows a starting container as stopped.
- Reading the instance first shows a sleeping container as running.

The order that works is `status` first, then `deploymentStopped` and the instance only when `status` is `SUCCESS`.

## 2. Stopping and restarting

**`deploymentStop`** returns `true` immediately. For up to 1.5 seconds the state is unchanged, then it reads `SUCCESS`, `deploymentStopped: true`, instance `EXITED`. The `status` and `statusUpdatedAt` fields do not change. Calling it on a deployment that is already stopped also returns `true`.

**`deploymentRestart`** on a stopped deployment brings back the same instance. The state reads `SUCCESS`, not stopped, `RUNNING` within about a second, and the URL answers within half a second.

**Requests to a stopped container's URL** get no answer, rather than a quick error.

**Scaling to zero** is not available: `serviceInstanceUpdate` with `numReplicas: 0` is rejected.

### An image whose stop is not reported

For `traefik/whoami`, `deploymentStop` returns `true`, the deployment log prints `Stopping Container`, and the URL stops answering. The API, however, keeps reporting `status: SUCCESS`, `deploymentStopped: false`, instance `RUNNING`. This happened on 10 of 10 attempts across 6 deployments, and was still the case after 120 seconds.

| Checked | Result |
|---|---|
| Stopping right after `SUCCESS`, or 10 seconds later | No difference |
| Restart policy `ON_FAILURE` or `NEVER` | No difference |
| Whether Railway restarted the container | It did not; the log shows one start and one stop |
| `deploymentRestart` afterwards | Works; the URL answers again |

`nginx:alpine`, `httpd:alpine` and `caddy:alpine` all stop and report correctly, within 1.6 to 3.4 seconds. The cause was not found. A possible explanation is the exit code: `traefik/whoami` is a bare Go binary that does not handle `SIGTERM`.

Because of this, the app only offers images that pass `npm run probe -- imageStop <image>`, and its interface shows "stop accepted" separately from the state Railway reports.

## 3. Errors

Every error arrived as HTTP 200 with an `errors` array.

| Call | `message` | `extensions.code` |
|---|---|---|
| Project token sent as `Authorization: Bearer` | `Project Token not found` | `INTERNAL_SERVER_ERROR` |
| `deploymentStop` with an unknown id | `Deployment not found` | `INTERNAL_SERVER_ERROR` |
| `serviceDelete` with an unknown id | `Not Authorized` | `INTERNAL_SERVER_ERROR` |
| `serviceCreate` with a name already in use | `A service named "…" already exists in this project` | `BAD_USER_INPUT` |
| `serviceInstanceUpdate` with `numReplicas: 0` | `Error in numReplicas - Invalid input` | `BAD_USER_INPUT` |
| `deploymentStop` on a sleeping deployment | `Deployment is not stoppable` | `BAD_USER_INPUT` |
| `deploymentRestart` on a sleeping deployment | `Deployment is not restartable` | `BAD_USER_INPUT` |

Two things follow:

- **The code alone does not identify an error.** `INTERNAL_SERVER_ERROR` covers both a wrong auth header and a missing deployment, so the message has to be read as well.
- **A missing service looks like a permission error.** `serviceDelete` on an unknown id answers `Not Authorized`, so after a failed delete it is worth checking whether the service still exists.

## 4. Differences from the documentation

| Topic | Documentation | Observed |
|---|---|---|
| `traceId` | Shown inside `extensions` | On the error object itself, next to `message` |
| `BAD_USER_INPUT` | Listed as HTTP 400 | Returned as HTTP 200 |
| Rate-limit headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` on each response | Not present on any of 447 authenticated responses. Only `RateLimit-Policy` was sent |
| Trial plan limit | Not listed (Free is 100 per hour, Hobby 1,000) | `RateLimit-Policy: "default";q=1000;w=3600` |
| Deployment list filter | Example uses `status: { successfulOnly: true }` | The schema's `DeploymentStatusInput` has only `in` and `notIn` |
| `deploymentRestart` | Described for running deployments | Also resumes a stopped deployment |

Since the remaining budget is not reported, a client has to count its own requests.

## 5. Creating services and domains

- **Service names are unique within a project.** Two `serviceCreate` calls with the same name, sent at the same moment, produced one service and one `already exists` error.
- **`serviceDomainCreate` can be called before the first deploy.** The URL returns 404 until the deployment reads `SUCCESS`, and 200 from then on.
- **`serviceDomainCreate` is not safe to repeat.** A second call on the same service created a second domain.
- **Adding a domain to a running container** did not trigger a redeploy, and the URL answered within a second.

## 6. Deleting

`serviceDelete` usually returns in 3 to 7 seconds, and the service is gone from the next listing, including when it is deleted in the middle of a deploy. On one occasion the call had not answered after 15 seconds, although the service had already been removed. A client should not treat a timeout on this call as a failure.

## 7. Project tokens

A project token, sent in the `Project-Access-Token` header, could run every call this app needs: `projectToken`, `environment`, `serviceCreate`, `serviceInstanceUpdate`, `serviceInstanceDeployV2`, `serviceDomainCreate`, `deploymentStop`, `deploymentRestart` and `serviceDelete`.

`projectToken { projectId environmentId }` returns both ids, so they do not need to be configured.

A `graphql-transport-ws` subscription to `deployment(id)` with the project token in the connection payload was acknowledged and then answered with `Problem processing request`. Only this one way of passing the token was tried.

## 8. Serverless sleep

With `sleepApplication` enabled, a container with no traffic went to sleep after about 8 minutes (7.8 and 8.2 minutes in two runs) and reported `SLEEPING`. The first request to its URL woke it and received a 200 in 1.5 seconds.

A sleeping deployment cannot be stopped or restarted through the API; both calls are refused.

## 9. Not tested

- Whether `deploymentRestart` still resumes a deployment that has been stopped for hours. Stops of up to two minutes were tested.
- Whether a stopped deployment is billed.
- What a crashed or failed image deployment reports. No deployment failed during testing.
- Behaviour at the rate limit (HTTP 429 and `Retry-After`).
