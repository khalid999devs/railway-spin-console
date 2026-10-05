export interface GraphqlDocument {
  name: string;
  kind: "query" | "mutation";
  text: string;
}

const query = (name: string, text: string): GraphqlDocument => ({ name, kind: "query", text });
const mutation = (name: string, text: string): GraphqlDocument => ({ name, kind: "mutation", text });

/** Every document the app sends. `documents.test.ts` validates each one against `schema/railway.graphql`. */
export const documents = {
  tokenCheck: query(
    "TokenCheck",
    `query TokenCheck {
      projectToken { projectId environmentId project { name } environment { name } }
    }`,
  ),
  sandboxState: query(
    "SandboxState",
    `query SandboxState($environmentId: String!) {
      environment(id: $environmentId) {
        serviceInstances {
          edges {
            node {
              serviceId
              serviceName
              createdAt
              source { image }
              domains { serviceDomains { domain } }
              latestDeployment {
                id
                status
                deploymentStopped
                statusUpdatedAt
                instances { id status }
              }
            }
          }
        }
      }
    }`,
  ),
  serviceCreate: mutation(
    "ServiceCreate",
    `mutation ServiceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id }
    }`,
  ),
  domainCreate: mutation(
    "DomainCreate",
    `mutation DomainCreate($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) { domain }
    }`,
  ),
  instanceUpdate: mutation(
    "InstanceUpdate",
    `mutation InstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`,
  ),
  deploy: mutation(
    "Deploy",
    `mutation Deploy($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
    }`,
  ),
  stop: mutation("Stop", `mutation Stop($id: String!) { deploymentStop(id: $id) }`),
  restart: mutation("Restart", `mutation Restart($id: String!) { deploymentRestart(id: $id) }`),
  serviceDelete: mutation(
    "ServiceDelete",
    `mutation ServiceDelete($id: String!, $environmentId: String) {
      serviceDelete(id: $id, environmentId: $environmentId)
    }`,
  ),
} as const satisfies Record<string, GraphqlDocument>;
