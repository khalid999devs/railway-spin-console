import { describe, expect, it } from "vitest";
import { IMAGES, loadConfig, OWNED_NAME } from "./config";

const COMPLETE = { RAILWAY_SANDBOX_TOKEN: "token-value", CONSOLE_PASSPHRASE: "passphrase-value", SESSION_SECRET: "s".repeat(64) };

describe("loadConfig", () => {
  it("accepts a complete environment", () => {
    expect(loadConfig(COMPLETE)).toMatchObject({ fake: false, sandboxToken: "token-value", secureCookies: false });
    expect(loadConfig({ ...COMPLETE, NODE_ENV: "production" }).secureCookies).toBe(true);
  });

  it("names every missing variable and prints no values", () => {
    const attempt = () => loadConfig({ CONSOLE_PASSPHRASE: "passphrase-value" });
    expect(attempt).toThrow("RAILWAY_SANDBOX_TOKEN, SESSION_SECRET");
    expect(attempt).not.toThrow("passphrase-value");
  });

  it("refuses a session secret that is too short to be random", () => {
    expect(() => loadConfig({ ...COMPLETE, SESSION_SECRET: "short" })).toThrow("at least 32");
  });

  it("needs no token in fake mode", () => {
    const config = loadConfig({ RAILWAY_FAKE: "1" });
    expect(config).toMatchObject({ fake: true, passphrase: "demo" });
    expect(config.sessionSecret).toHaveLength(64);
  });
});

describe("the names this app owns", () => {
  it.each(["spin-abc12345", "spin-00000000"])("owns %s", (name) => {
    expect(OWNED_NAME.test(name)).toBe(true);
  });

  it.each(["postgres", "spin-", "spin-doctor", "spin-probe-muvo9oh9", "my-spin-abc12345", "spin-ABC12345", "spin-abc123456"])(
    "does not own %s",
    (name) => {
      expect(OWNED_NAME.test(name)).toBe(false);
    },
  );
});

describe("the image list", () => {
  it("holds only the images whose stop the probe saw Railway report", () => {
    expect(IMAGES.map((image) => image.image)).toEqual(["nginx:alpine", "httpd:alpine", "caddy:alpine"]);
  });
});
