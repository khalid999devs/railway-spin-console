import { handleWrite } from "@/server/http/respond";

export function DELETE(request: Request, context: RouteContext<"/api/containers/[serviceId]">): Promise<Response> {
  return handleWrite(request, async ({ service }) => service.destroy((await context.params).serviceId));
}
