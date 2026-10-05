import { z } from "zod";
import { handleWrite, readBody } from "@/server/http/respond";

const createRequest = z.object({ operationId: z.string(), imageId: z.string() });

export function POST(request: Request): Promise<Response> {
  return handleWrite(request, async ({ service }) => service.create(await readBody(request, createRequest)));
}
