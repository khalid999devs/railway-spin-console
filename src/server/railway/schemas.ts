import { z } from "zod";

/**
 * What each response must contain for the app to use it. Statuses stay
 * `z.string()` so an unfamiliar value flows through to the UI as "unknown"
 * instead of failing here.
 */
const deployment = z.object({
  id: z.string(),
  status: z.string(),
  deploymentStopped: z.boolean(),
  statusUpdatedAt: z.string().nullable(),
  instances: z.array(z.object({ id: z.string(), status: z.string() })),
});

const serviceInstance = z.object({
  serviceId: z.string(),
  serviceName: z.string(),
  createdAt: z.string(),
  source: z.object({ image: z.string().nullable() }).nullable(),
  domains: z.object({ serviceDomains: z.array(z.object({ domain: z.string() })) }),
  latestDeployment: deployment.nullable(),
});

export const responses = {
  tokenCheck: z.object({
    projectToken: z.object({
      projectId: z.string(),
      environmentId: z.string(),
      project: z.object({ name: z.string() }),
      environment: z.object({ name: z.string() }),
    }),
  }),
  sandboxState: z.object({
    environment: z.object({
      serviceInstances: z.object({ edges: z.array(z.object({ node: serviceInstance })) }),
    }),
  }),
  serviceCreate: z.object({ serviceCreate: z.object({ id: z.string() }) }),
  domainCreate: z.object({ serviceDomainCreate: z.object({ domain: z.string() }) }),
  instanceUpdate: z.object({ serviceInstanceUpdate: z.boolean() }),
  deploy: z.object({ serviceInstanceDeployV2: z.string() }),
  stop: z.object({ deploymentStop: z.boolean() }),
  restart: z.object({ deploymentRestart: z.boolean() }),
  serviceDelete: z.object({ serviceDelete: z.boolean() }),
};
