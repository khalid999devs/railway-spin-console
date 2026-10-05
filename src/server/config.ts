import { randomBytes } from "node:crypto";
import type { ImageOption } from "@/lib/contract";

export const SERVICE_PREFIX = "spin-";
/** The exact form of the names this app generates. Nothing else in the sandbox is ever listed or touched. */
export const OWNED_NAME = /^spin-[a-z0-9]{8}$/;
export const OPERATION_ID = /^[a-z0-9]{8}$/;

export const LIMITS = { maxContainers: 3, lifetimeMs: 30 * 60_000 } as const;

/**
 * Images a visitor may run. Each one was checked with
 * `node scripts/probe.mts imageStop <image>`: it serves HTTP on port 80 and
 * Railway reports its stop. `traefik/whoami` failed that check.
 */
export const IMAGES: readonly ImageOption[] = [
  { id: "nginx", label: "nginx", image: "nginx:alpine" },
  { id: "httpd", label: "Apache", image: "httpd:alpine" },
  { id: "caddy", label: "Caddy", image: "caddy:alpine" },
];
export const CONTAINER_PORT = 80;

export interface AppConfig {
  /** Run against the in-memory fake instead of Railway. */
  fake: boolean;
  sandboxToken: string;
  passphrase: string;
  sessionSecret: string;
  secureCookies: boolean;
}

export const FAKE_PASSPHRASE = "demo";
const MIN_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): AppConfig {
  const secureCookies = env.NODE_ENV === "production";
  if (env.RAILWAY_FAKE === "1") {
    return {
      fake: true,
      sandboxToken: "",
      passphrase: env.CONSOLE_PASSPHRASE || FAKE_PASSPHRASE,
      sessionSecret: env.SESSION_SECRET || randomBytes(32).toString("hex"),
      secureCookies,
    };
  }

  const required = ["RAILWAY_SANDBOX_TOKEN", "CONSOLE_PASSPHRASE", "SESSION_SECRET"] as const;
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}. Set them, or set RAILWAY_FAKE=1 to run without Railway.`);
  }
  if (env.SESSION_SECRET!.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return {
    fake: false,
    sandboxToken: env.RAILWAY_SANDBOX_TOKEN!,
    passphrase: env.CONSOLE_PASSPHRASE!,
    sessionSecret: env.SESSION_SECRET!,
    secureCookies,
  };
}
