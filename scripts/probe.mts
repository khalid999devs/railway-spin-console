/**
 * Probes Railway's public GraphQL API against the sandbox project and records
 * what it actually does.
 *
 *   node scripts/probe.mts lifecycle   create, deploy, stop, restart, redeploy, sleep, delete
 *   node scripts/probe.mts followups   questions the first run raised
 *   node scripts/probe.mts stopTiming  whether a stop sent right after SUCCESS takes effect
 *   node scripts/probe.mts stopPolicy  whether the restart policy explains a stop that has no effect
 *   node scripts/probe.mts imageStop <image>...  whether each image really stops (run before adding one to the allow-list)
 *   node scripts/probe.mts cleanup     delete every spin-probe-* service left by a crashed run
 *
 * Add --skip-sleep to leave out the 5 to 15 minute wait for serverless sleep.
 *
 * Every service a run creates carries that run's `spin-probe-<run>` prefix and
 * is deleted on exit, including when a step throws.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const WS_ENDPOINT = "wss://backboard.railway.com/graphql/v2";
const ALL_PROBES = "spin-probe-";
const PREFIX = `${ALL_PROBES}${Date.now().toString(36)}`;
const IMAGES = { lifecycle: "nginx:alpine", followups: "traefik/whoami" };
const MISSING_ID = "00000000-0000-0000-0000-000000000000";
const ROOT = join(import.meta.dirname, "..");

process.loadEnvFile(join(ROOT, ".env.local"));
const TOKEN = process.env.RAILWAY_SANDBOX_TOKEN;
if (!TOKEN) throw new Error("RAILWAY_SANDBOX_TOKEN is not set in .env.local");

// The probe exists to look at responses whose shape is not yet known, so they stay untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Auth = "project" | "bearer";
interface Call {
  status: number;
  body: Json;
  rate: Record<string, string>;
  ms: number;
}

const startedAt = Date.now();
const events: Json[] = [];
let requestCount = 0;

const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => console.log(`${elapsed()}s  ${line}`);

function record(step: string, detail: Json) {
  events.push({ t: Date.now() - startedAt, step, ...detail });
}

async function gql(query: string, variables: Json = {}, auth: Auth = "project"): Promise<Call> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth === "project") headers["Project-Access-Token"] = TOKEN!;
  else headers.Authorization = `Bearer ${TOKEN}`;

  const t0 = Date.now();
  const res = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  requestCount++;

  const rate: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (/ratelimit|retry-after/i.test(name)) rate[name] = value;
  });
  const call = { status: res.status, body: (await res.json()) as Json, rate, ms: Date.now() - t0 };
  if (res.status === 429) throw new Error(`rate limited, retry-after=${rate["retry-after"]}`);
  return call;
}

/** Runs one named operation, logs the outcome, and returns the call without throwing on GraphQL errors. */
async function step(name: string, query: string, variables: Json = {}, auth: Auth = "project") {
  const call = await gql(query, variables, auth);
  record(name, { variables, ...call });
  const errors = call.body.errors as Json[] | undefined;
  const outcome = errors
    ? `ERROR "${errors[0].message}" code=${errors[0].extensions?.code} traceId=${errors[0].traceId ? "on error" : errors[0].extensions?.traceId ? "in extensions" : "absent"}`
    : `ok ${JSON.stringify(call.body.data).slice(0, 160)}`;
  say(`${name} [http ${call.status}, ${call.ms}ms] ${outcome}`);
  return call;
}

const Q = {
  token: `query TokenCheck { projectToken { projectId environmentId name project { name subscriptionType } environment { name } } }`,
  state: `query SandboxState($environmentId: String!) {
    environment(id: $environmentId) {
      id name
      serviceInstances { edges { node {
        id serviceId serviceName createdAt deletedAt sleepApplication numReplicas
        source { image }
        domains { serviceDomains { id domain targetPort } }
        latestDeployment { id status deploymentStopped statusUpdatedAt createdAt staticUrl instances { id status } }
      } } }
    }
  }`,
  deployment: `query DeploymentOne($id: String!) { deployment(id: $id) { id status deploymentStopped statusUpdatedAt instances { id status } } }`,
  create: `mutation ServiceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name createdAt } }`,
  update: `mutation InstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
    serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
  deploy: `mutation Deploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
  domain: `mutation DomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain targetPort } }`,
  stop: `mutation Stop($id: String!) { deploymentStop(id: $id) }`,
  restart: `mutation Restart($id: String!) { deploymentRestart(id: $id) }`,
  logs: `query Logs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity } }`,
  policy: `query Policy($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { restartPolicyType restartPolicyMaxRetries } }`,
  remove: `mutation ServiceDelete($id: String!, $environmentId: String) { serviceDelete(id: $id, environmentId: $environmentId) }`,
};

let environmentId = "";
let projectId = "";

async function listInstances(): Promise<Json[]> {
  const call = await gql(Q.state, { environmentId });
  if (call.body.errors) throw new Error(`state read failed: ${call.body.errors[0].message}`);
  return call.body.data.environment.serviceInstances.edges.map((e: Json) => e.node);
}

function summarise(node: Json | undefined): string {
  if (!node) return "absent from listing";
  const deleted = node.deletedAt ? " deletedAt=set" : "";
  const d = node.latestDeployment;
  if (!d) return `latestDeployment=null${deleted}`;
  const instances = d.instances.map((i: Json) => i.status).join(",") || "none";
  return `deployment=${d.id.slice(0, 8)} status=${d.status} stopped=${d.deploymentStopped} instances=[${instances}]${deleted}`;
}

/** Polls one service once a second, recording each distinct snapshot, until `done` holds or the timeout passes. */
async function watch(label: string, serviceId: string, done: (node: Json | undefined) => boolean, timeoutMs = 120_000, intervalMs = 1000) {
  const t0 = Date.now();
  let last = "";
  let node: Json | undefined;
  while (Date.now() - t0 < timeoutMs) {
    node = (await listInstances()).find((n) => n.serviceId === serviceId);
    const summary = summarise(node);
    if (summary !== last) {
      last = summary;
      const after = ((Date.now() - t0) / 1000).toFixed(1);
      say(`  ${label} +${after}s ${summary}`);
      record(`watch:${label}`, { afterMs: Date.now() - t0, node: node ?? null });
    }
    if (done(node)) return { node, ms: Date.now() - t0, reached: true };
    await sleep(intervalMs);
  }
  say(`  ${label} TIMED OUT after ${timeoutMs / 1000}s`);
  record(`watch:${label}:timeout`, { afterMs: Date.now() - t0 });
  return { node, ms: Date.now() - t0, reached: false };
}

const isRunning = (n?: Json) =>
  n?.latestDeployment?.status === "SUCCESS" &&
  !n.latestDeployment.deploymentStopped &&
  n.latestDeployment.instances.some((i: Json) => i.status === "RUNNING");
const isStopped = (n?: Json) =>
  !!n?.latestDeployment?.deploymentStopped &&
  n.latestDeployment.instances.length > 0 &&
  n.latestDeployment.instances.every((i: Json) => i.status === "EXITED" || i.status === "STOPPED");

async function waitForHttp(label: string, url: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    let seen: string;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "manual" });
      seen = `http ${res.status}`;
    } catch (error) {
      seen = `failed (${(error as Error).name})`;
    }
    if (seen !== last) {
      last = seen;
      say(`  ${label} +${((Date.now() - t0) / 1000).toFixed(1)}s ${seen}`);
      record(`http:${label}`, { afterMs: Date.now() - t0, seen });
    }
    if (seen === "http 200") return true;
    await sleep(2000);
  }
  return false;
}

/** Tries a graphql-transport-ws subscription with the project token and reports whatever the server says. */
async function trySubscription(deploymentId: string) {
  const outcome = await new Promise<string>((resolve) => {
    const ws = new WebSocket(WS_ENDPOINT, "graphql-transport-ws");
    const timer = setTimeout(() => finish("no message within 10s"), 10_000);
    const finish = (text: string) => {
      clearTimeout(timer);
      ws.close();
      resolve(text);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init", payload: { "Project-Access-Token": TOKEN } }));
    ws.onmessage = (message) => {
      const frame = JSON.parse(String(message.data));
      if (frame.type === "connection_ack") {
        ws.send(JSON.stringify({ id: "1", type: "subscribe", payload: { query: `subscription($id: String!) { deployment(id: $id) { id status } }`, variables: { id: deploymentId } } }));
      } else if (frame.type !== "ping") {
        finish(`${frame.type}: ${JSON.stringify(frame.payload).slice(0, 200)}`);
      }
    };
    ws.onclose = (close) => finish(`closed code=${close.code} reason="${close.reason}"`);
    ws.onerror = () => finish("socket error");
  });
  say(`subscription with project token -> ${outcome}`);
  record("subscription", { outcome });
}

async function cleanup(prefix = PREFIX) {
  const leftovers = (await listInstances()).filter((n) => n.serviceName.startsWith(prefix));
  for (const node of leftovers) await step(`cleanup:delete ${node.serviceName}`, Q.remove, { id: node.serviceId, environmentId });
  const t0 = Date.now();
  let remaining = leftovers.length;
  while (remaining > 0 && Date.now() - t0 < 90_000) {
    await sleep(2000);
    remaining = (await listInstances()).filter((n) => n.serviceName.startsWith(prefix)).length;
  }
  const all = await listInstances();
  say(`cleanup: ${remaining} probe services left, ${all.length} services in sandbox in total`);
  record("cleanup", { remaining, total: all.length, afterMs: Date.now() - t0 });
}

const skipSleep = process.argv.includes("--skip-sleep");
const isSleeping = (n?: Json) => n?.latestDeployment?.status === "SLEEPING";
const waitForSleep = (serviceId: string) => {
  say("waiting up to 15 min for serverless sleep, polling every 20s, sending no traffic");
  return watch("toSleeping", serviceId, isSleeping, 15 * 60_000, 20_000);
};

async function identify() {
  const token = await step("tokenCheck", Q.token);
  ({ environmentId, projectId } = token.body.data.projectToken);
  say(`rate-limit headers seen: ${JSON.stringify(token.rate)}`);
}

async function lifecycle() {
  const name = PREFIX;
  const source = { image: IMAGES.lifecycle };

  await step("auth:projectTokenAsBearer", Q.token, {}, "bearer");
  await step("error:stopMissingDeployment", Q.stop, { id: MISSING_ID });
  await step("error:deleteMissingService", Q.remove, { id: MISSING_ID, environmentId });

  const created = await step("serviceCreate", Q.create, { input: { projectId, environmentId, name, source } });
  const serviceId: string = created.body.data.serviceCreate.id;
  await watch("afterCreate", serviceId, () => true);

  const duplicate = await step("serviceCreate:sameName", Q.create, { input: { projectId, environmentId, name, source } });
  const duplicateId = duplicate.body.data?.serviceCreate?.id;
  if (duplicateId) {
    say(`  duplicate name was ACCEPTED as "${duplicate.body.data.serviceCreate.name}"`);
    await step("serviceDelete:duplicate", Q.remove, { id: duplicateId, environmentId });
  }

  await step("update:sleepApplication", Q.update, { serviceId, environmentId, input: { sleepApplication: true } });
  await step("update:numReplicasZero", Q.update, { serviceId, environmentId, input: { numReplicas: 0 } });
  await watch("afterUpdate", serviceId, () => true);

  const firstDeploy = await step("deploy:first", Q.deploy, { serviceId, environmentId });
  const firstDeploymentId: string = firstDeploy.body.data.serviceInstanceDeployV2;
  await watch("toRunning", serviceId, isRunning);

  const domain = await step("domainCreate", Q.domain, { input: { serviceId, environmentId, targetPort: 80 } });
  const host: string | undefined = domain.body.data?.serviceDomainCreate?.domain;
  if (host) await waitForHttp("domainReachable", `https://${host}`);
  await watch("afterDomain", serviceId, isRunning, 20_000);

  await trySubscription(firstDeploymentId);

  await step("stop:first", Q.stop, { id: firstDeploymentId });
  await watch("toStopped", serviceId, isStopped);
  if (host) await waitForHttp("domainWhileStopped", `https://${host}`, 6000);

  await step("restart:stopped", Q.restart, { id: firstDeploymentId });
  await watch("restartToRunning", serviceId, isRunning);

  await step("stop:second", Q.stop, { id: firstDeploymentId });
  await watch("toStoppedAgain", serviceId, isStopped);
  await step("stop:alreadyStopped", Q.stop, { id: firstDeploymentId });

  const secondDeploy = await step("deploy:second", Q.deploy, { serviceId, environmentId });
  const secondDeploymentId: string = secondDeploy.body.data.serviceInstanceDeployV2;
  await watch("redeployToRunning", serviceId, (n) => n?.latestDeployment?.id === secondDeploymentId && isRunning(n));
  await step("previousDeploymentAfterRedeploy", Q.deployment, { id: firstDeploymentId });
  await sleep(15_000);
  await step("previousDeploymentAfterRedeploy:+15s", Q.deployment, { id: firstDeploymentId });

  if (!skipSleep) {
    const slept = await waitForSleep(serviceId);
    if (slept.reached && host) {
      const wokeByHttp = await waitForHttp("wakeByRequest", `https://${host}`, 60_000);
      say(`  request to the domain ${wokeByHttp ? "woke the container" : "did not get a 200 within 60s"}`);
      await watch("afterWake", serviceId, isRunning, 60_000);
    }
  }

  await step("serviceDelete", Q.remove, { id: serviceId, environmentId });
  await watch("toGone", serviceId, (n) => !n, 90_000);
}

async function followups() {
  const name = PREFIX;
  const input = { projectId, environmentId, name, source: { image: IMAGES.followups } };

  const race = await Promise.all([step("race:createA", Q.create, { input }), step("race:createB", Q.create, { input })]);
  const [serviceId, ...extras] = race.map((call) => call.body.data?.serviceCreate?.id).filter(Boolean) as string[];
  say(`  ${extras.length + 1} of 2 simultaneous creates with one name succeeded`);
  for (const id of extras) await step("race:deleteExtra", Q.remove, { id, environmentId });

  const domainInput = { input: { serviceId, environmentId, targetPort: 80 } };
  const domain = await step("domainCreate:beforeFirstDeploy", Q.domain, domainInput);
  const url = `https://${domain.body.data.serviceDomainCreate.domain}`;
  await step("domainCreate:secondOnSameService", Q.domain, domainInput);
  await step("update:sleepApplication", Q.update, { serviceId, environmentId, input: { sleepApplication: true } });

  const deploy = await step("deploy", Q.deploy, { serviceId, environmentId });
  const deploymentId: string = deploy.body.data.serviceInstanceDeployV2;
  await Promise.all([watch("toRunning", serviceId, isRunning), waitForHttp("firstResponse", url)]);

  await step("stop", Q.stop, { id: deploymentId });
  await watch("toStopped", serviceId, isStopped);
  await step("restart", Q.restart, { id: deploymentId });
  await Promise.all([watch("restartToRunning", serviceId, isRunning, 30_000), waitForHttp("responseAfterRestart", url, 60_000)]);

  const other = await step("serviceCreate:second", Q.create, { input: { ...input, name: `${name}-b` } });
  const otherId: string = other.body.data.serviceCreate.id;
  await step("deploy:second", Q.deploy, { serviceId: otherId, environmentId });
  await sleep(1500);
  await step("serviceDelete:whileDeploying", Q.remove, { id: otherId, environmentId });
  await watch("deployingToGone", otherId, (n) => !n, 90_000);

  if (!skipSleep && (await waitForSleep(serviceId)).reached) {
    await step("stop:whileSleeping", Q.stop, { id: deploymentId });
    await watch("sleepingAfterStop", serviceId, isStopped, 20_000);
    await step("restart:afterSleepThenStop", Q.restart, { id: deploymentId });
    await Promise.all([watch("afterSleepRestart", serviceId, isRunning, 30_000), waitForHttp("responseAfterSleepRestart", url, 60_000)]);
  }

  await step("serviceDelete", Q.remove, { id: serviceId, environmentId });
  await watch("toGone", serviceId, (n) => !n, 90_000);
}

/** Stops a deployment either the moment it reads SUCCESS or after a pause, and stops again if the first had no effect. */
async function stopTiming() {
  const cases = [
    { image: IMAGES.followups, pauseMs: 0 },
    { image: IMAGES.followups, pauseMs: 10_000 },
    { image: IMAGES.lifecycle, pauseMs: 0 },
    { image: IMAGES.lifecycle, pauseMs: 10_000 },
  ];
  for (const [index, { image, pauseMs }] of cases.entries()) {
    const label = `${image}@+${pauseMs / 1000}s`;
    const created = await step(`${label} create`, Q.create, { input: { projectId, environmentId, name: `${PREFIX}-${index}`, source: { image } } });
    const serviceId: string = created.body.data.serviceCreate.id;
    const deploy = await step(`${label} deploy`, Q.deploy, { serviceId, environmentId });
    const id: string = deploy.body.data.serviceInstanceDeployV2;
    await watch(`${label} toRunning`, serviceId, isRunning, 60_000);
    await sleep(pauseMs);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await step(`${label} stop#${attempt}`, Q.stop, { id });
      const { reached } = await watch(`${label} afterStop#${attempt}`, serviceId, isStopped, 20_000, 2000);
      if (reached) break;
    }
    await step(`${label} delete`, Q.remove, { id: serviceId, environmentId });
  }
}

/** Stops traefik/whoami under each restart policy and reads its logs, to see whether Railway restarts it after the stop. */
async function stopPolicy() {
  for (const [index, policy] of [null, "NEVER"].entries()) {
    const label = `policy=${policy ?? "default"}`;
    const created = await step(`${label} create`, Q.create, { input: { projectId, environmentId, name: `${PREFIX}-${index}`, source: { image: IMAGES.followups } } });
    const serviceId: string = created.body.data.serviceCreate.id;
    if (policy) await step(`${label} update`, Q.update, { serviceId, environmentId, input: { restartPolicyType: policy } });
    await step(`${label} read policy`, Q.policy, { serviceId, environmentId });

    const deploy = await step(`${label} deploy`, Q.deploy, { serviceId, environmentId });
    const id: string = deploy.body.data.serviceInstanceDeployV2;
    await watch(`${label} toRunning`, serviceId, isRunning, 60_000);
    await sleep(5000);

    await step(`${label} stop`, Q.stop, { id });
    await watch(`${label} afterStop`, serviceId, isStopped, 20_000, 1000);
    const logs = await gql(Q.logs, { deploymentId: id, limit: 40 });
    record(`${label} logs`, { body: logs.body });
    for (const line of logs.body.data?.deploymentLogs ?? []) say(`    log ${line.timestamp} ${line.message}`);
    await step(`${label} delete`, Q.remove, { id: serviceId, environmentId });
  }
}

/** For each image: deploy with a domain, stop, then compare what Railway reports with whether the URL still answers. */
async function imageStop() {
  const images = process.argv.slice(3).filter((arg) => !arg.startsWith("--"));
  if (images.length === 0) throw new Error("imageStop needs at least one image");
  for (const [index, image] of images.entries()) {
    const created = await step(`${image} create`, Q.create, { input: { projectId, environmentId, name: `${PREFIX}-${index}`, source: { image } } });
    const serviceId: string = created.body.data.serviceCreate.id;
    const domain = await step(`${image} domain`, Q.domain, { input: { serviceId, environmentId, targetPort: 80 } });
    const url = `https://${domain.body.data.serviceDomainCreate.domain}`;
    const deploy = await step(`${image} deploy`, Q.deploy, { serviceId, environmentId });
    const id: string = deploy.body.data.serviceInstanceDeployV2;
    await Promise.all([watch(`${image} toRunning`, serviceId, isRunning, 90_000), waitForHttp(`${image} firstResponse`, url, 90_000)]);
    await sleep(5000);

    await step(`${image} stop`, Q.stop, { id });
    const stopped = await watch(`${image} afterStop`, serviceId, isStopped, 30_000, 2000);
    const answers = await waitForHttp(`${image} urlAfterStop`, url, 9000);
    say(`  ${image}: Railway reports ${stopped.reached ? "stopped" : "STILL RUNNING"}, URL ${answers ? "STILL ANSWERS" : "does not answer"}`);
    record(`${image} verdict`, { reportedStopped: stopped.reached, urlAnswers: answers });
    await step(`${image} delete`, Q.remove, { id: serviceId, environmentId });
  }
}

const scenarios: Record<string, () => Promise<void>> = { imageStop, lifecycle, followups, stopTiming, stopPolicy, cleanup: () => cleanup(ALL_PROBES) };
const scenario = process.argv[2] ?? "";
if (!scenarios[scenario]) throw new Error(`usage: node scripts/probe.mts <${Object.keys(scenarios).join("|")}> [--skip-sleep]`);

try {
  await identify();
  await scenarios[scenario]();
} catch (error) {
  say(`FAILED: ${(error as Error).message}`);
  record("failed", { message: (error as Error).message });
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => say(`CLEANUP FAILED, check the sandbox by hand: ${error.message}`));
  const dir = join(ROOT, "tests", "fixtures", "probe");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${scenario}-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ scenario, startedAt: new Date(startedAt).toISOString(), requestCount, events }, null, 2));
  say(`${requestCount} API requests; raw log written to ${file}`);
}
