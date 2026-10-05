import { z } from "zod";
import { safeEqual } from "@/server/auth/session";
import { ConsoleError } from "@/server/console/problems";
import { assertSameOrigin, clientKey, json, problemResponse, readBody } from "@/server/http/respond";
import { getRuntime } from "@/server/runtime";

const unlockRequest = z.object({ passphrase: z.string().min(1).max(200) });

/** Exchanges the shared passphrase for a session cookie. */
export async function POST(request: Request): Promise<Response> {
  try {
    const { config, sessions, throttle } = getRuntime();
    assertSameOrigin(request);
    const client = clientKey(request);

    const wait = throttle.retryAfterSeconds(client);
    if (wait > 0) throw new ConsoleError("throttled", "Too many wrong attempts. Try again later.", wait);

    const { passphrase } = await readBody(request, unlockRequest);
    if (!safeEqual(passphrase, config.passphrase)) {
      throttle.recordFailure(client);
      throw new ConsoleError("locked", "That passphrase is not right.");
    }
    throttle.clear(client);
    return json({ unlocked: true }, { headers: { "set-cookie": sessions.issue() } });
  } catch (error) {
    return problemResponse(error);
  }
}

export function DELETE(request: Request): Response {
  try {
    assertSameOrigin(request);
    return json({ unlocked: false }, { headers: { "set-cookie": getRuntime().sessions.clear() } });
  } catch (error) {
    return problemResponse(error);
  }
}
