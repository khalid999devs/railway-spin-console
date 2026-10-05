/**
 * The app's whole view of Railway. Everything outside `src/server/railway`
 * depends on this interface, never on GraphQL, so the real client and the
 * in-memory fake are interchangeable.
 *
 * Statuses are plain strings on purpose: a value Railway adds later must reach
 * `deriveState` and show up as "unknown", not fail parsing.
 */
export interface Sandbox {
  projectId: string;
  environmentId: string;
  projectName: string;
  environmentName: string;
}

export interface Deployment {
  id: string;
  status: string;
  deploymentStopped: boolean;
  statusUpdatedAt: string | null;
  instances: { id: string; status: string }[];
}

export interface ServiceInstance {
  serviceId: string;
  name: string;
  createdAt: string;
  image: string | null;
  domains: string[];
  latestDeployment: Deployment | null;
}

export interface RailwayApi {
  identify(): Promise<Sandbox>;
  listInstances(environmentId: string): Promise<ServiceInstance[]>;
  createService(input: { projectId: string; environmentId: string; name: string; image: string }): Promise<{ id: string }>;
  createDomain(input: { serviceId: string; environmentId: string; targetPort: number }): Promise<{ domain: string }>;
  enableSleep(serviceId: string, environmentId: string): Promise<void>;
  deploy(serviceId: string, environmentId: string): Promise<string>;
  stopDeployment(deploymentId: string): Promise<void>;
  restartDeployment(deploymentId: string): Promise<void>;
  deleteService(serviceId: string, environmentId: string): Promise<void>;
}
