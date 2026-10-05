import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "spin_session";
const SESSION_SECONDS = 12 * 60 * 60;

/** Compares in constant time. Hashing first gives both sides the same length, which `timingSafeEqual` requires. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Stateless sessions: the cookie is an expiry time signed with HMAC-SHA256,
 * so the server keeps no session table and a restart logs nobody out.
 * It proves "this browser knew the passphrase", nothing about who is using it.
 */
export class Sessions {
  constructor(
    private readonly secret: string,
    private readonly secure: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  issue(): string {
    const expires = Math.floor(this.now() / 1000) + SESSION_SECONDS;
    return this.cookie(`${expires}.${this.sign(expires)}`, SESSION_SECONDS);
  }

  clear(): string {
    return this.cookie("", 0);
  }

  isValid(request: Request): boolean {
    const [expires, signature, ...rest] = readCookie(request, SESSION_COOKIE)?.split(".") ?? [];
    if (!expires || !signature || rest.length > 0 || !/^\d+$/.test(expires)) return false;
    return Number(expires) * 1000 > this.now() && safeEqual(signature, this.sign(Number(expires)));
  }

  private sign(expires: number): string {
    return createHmac("sha256", this.secret).update(`spin-session.v1.${expires}`).digest("base64url");
  }

  private cookie(value: string, maxAge: number): string {
    const attributes = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
    if (this.secure) attributes.push("Secure");
    return attributes.join("; ");
  }
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const pair of header.split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}
