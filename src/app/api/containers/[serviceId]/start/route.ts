import { handleWrite } from "@/server/http/respond";

export function POST(request: Request, context: RouteContext<"/api/containers/[serviceId]/start">): Promise<Response> {
  return handleWrite(request, async ({ service }) => service.start((await context.params).serviceId));
}
