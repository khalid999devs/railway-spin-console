import type { RailwayApi, ServiceInstance } from "./api";
import { documents } from "./documents";
import { responses } from "./schemas";
import type { Transport } from "./transport";

/** Maps the app's nine Railway operations onto GraphQL. No logic lives here beyond reshaping. */
export function createRailwayClient(request: Transport): RailwayApi {
  return {
    async identify() {
      const { projectToken: token } = await request(documents.tokenCheck, {}, responses.tokenCheck);
      return {
        projectId: token.projectId,
        environmentId: token.environmentId,
        projectName: token.project.name,
        environmentName: token.environment.name,
      };
    },

    async listInstances(environmentId) {
      const data = await request(documents.sandboxState, { environmentId }, responses.sandboxState);
      return data.environment.serviceInstances.edges.map(
        ({ node }): ServiceInstance => ({
          serviceId: node.serviceId,
          name: node.serviceName,
          createdAt: node.createdAt,
          image: node.source?.image ?? null,
          domains: node.domains.serviceDomains.map((entry) => entry.domain),
          latestDeployment: node.latestDeployment,
        }),
      );
    },

    async createService({ projectId, environmentId, name, image }) {
      const input = { projectId, environmentId, name, source: { image } };
      const data = await request(documents.serviceCreate, { input }, responses.serviceCreate);
      return data.serviceCreate;
    },

    async createDomain(input) {
      const data = await request(documents.domainCreate, { input }, responses.domainCreate);
      return data.serviceDomainCreate;
    },

    async enableSleep(serviceId, environmentId) {
      await request(documents.instanceUpdate, { serviceId, environmentId, input: { sleepApplication: true } }, responses.instanceUpdate);
    },

    async deploy(serviceId, environmentId) {
      const data = await request(documents.deploy, { serviceId, environmentId }, responses.deploy);
      return data.serviceInstanceDeployV2;
    },

    async stopDeployment(id) {
      await request(documents.stop, { id }, responses.stop);
    },

    async restartDeployment(id) {
      await request(documents.restart, { id }, responses.restart);
    },

    async deleteService(id, environmentId) {
      await request(documents.serviceDelete, { id, environmentId }, responses.serviceDelete);
    },
  };
}
