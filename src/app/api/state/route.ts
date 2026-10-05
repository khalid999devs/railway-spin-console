import { json, problemResponse } from "@/server/http/respond";
import { getRuntime } from "@/server/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const { service, sessions } = getRuntime();
    return json(await service.snapshot(sessions.isValid(request)));
  } catch (error) {
    return problemResponse(error);
  }
}
