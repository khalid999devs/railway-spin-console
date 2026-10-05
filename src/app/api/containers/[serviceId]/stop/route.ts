import { handleWrite } from "@/server/http/respond";

export function POST(request: Request, context: RouteContext<"/api/containers/[serviceId]/stop">): Promise<Response> {
  return handleWrite(request, async ({ service }) => service.stop((await context.params).serviceId));
}
