import { describe, expect, it } from "vitest";
import { fakeClock, MINUTE } from "../../../tests/support/console";
import { safeEqual, Sessions, SESSION_COOKIE } from "./session";
import { AttemptThrottle } from "./throttle";

const SECRET = "a".repeat(64);
const HOUR = 60 * MINUTE;

const withCookie = (cookie: string) => new Request("http://localhost/", { headers: { cookie } });
const valueOf = (setCookie: string) => setCookie.split(";")[0];

describe("safeEqual", () => {
  it("compares strings of any length without throwing", () => {
    expect(safeEqual("correct horse", "correct horse")).toBe(true);
    expect(safeEqual("correct horse", "correct hors")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
});

describe("Sessions", () => {
  it("issues an HttpOnly, SameSite=Lax cookie that it then accepts", () => {
    const sessions = new Sessions(SECRET, true);
    const cookie = sessions.issue();

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(sessions.isValid(withCookie(valueOf(cookie)))).toBe(true);
  });

  it("leaves Secure off outside production so the cookie works on http://localhost", () => {
    expect(new Sessions(SECRET, false).issue()).not.toContain("Secure");
  });

  it("rejects a missing, malformed or tampered cookie", () => {
    const sessions = new Sessions(SECRET, false);
    const [expires, signature] = valueOf(sessions.issue()).replace(`${SESSION_COOKIE}=`, "").split(".");

    expect(sessions.isValid(new Request("http://localhost/"))).toBe(false);
    expect(sessions.isValid(withCookie(`${SESSION_COOKIE}=garbage`))).toBe(false);
    expect(sessions.isValid(withCookie(`${SESSION_COOKIE}=${Number(expires) + 9999}.${signature}`))).toBe(false);
    expect(sessions.isValid(withCookie(`${SESSION_COOKIE}=${expires}.${signature}x`))).toBe(false);
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = valueOf(new Sessions("b".repeat(64), false).issue());
    expect(new Sessions(SECRET, false).isValid(withCookie(cookie))).toBe(false);
  });

  it("expires after twelve hours", () => {
    const clock = fakeClock();
    const sessions = new Sessions(SECRET, false, clock.now);
    const cookie = valueOf(sessions.issue());

    clock.advance(12 * HOUR - 1000);
    expect(sessions.isValid(withCookie(cookie))).toBe(true);
    clock.advance(1000);
    expect(sessions.isValid(withCookie(cookie))).toBe(false);
  });

  it("finds its cookie among others", () => {
    const sessions = new Sessions(SECRET, false);
    expect(sessions.isValid(withCookie(`theme=dark; ${valueOf(sessions.issue())}; other=1`))).toBe(true);
  });
});

describe("AttemptThrottle", () => {
  it("blocks a client after five failures and says how long to wait", () => {
    const clock = fakeClock();
    const throttle = new AttemptThrottle(5, 10 * MINUTE, clock.now);

    for (let attempt = 0; attempt < 4; attempt++) throttle.recordFailure("1.2.3.4");
    expect(throttle.retryAfterSeconds("1.2.3.4")).toBe(0);

    throttle.recordFailure("1.2.3.4");
    clock.advance(MINUTE);
    expect(throttle.retryAfterSeconds("1.2.3.4")).toBe(9 * 60);
    expect(throttle.retryAfterSeconds("5.6.7.8")).toBe(0);
  });

  it("lets the client try again when the window has passed", () => {
    const clock = fakeClock();
    const throttle = new AttemptThrottle(5, 10 * MINUTE, clock.now);
    for (let attempt = 0; attempt < 5; attempt++) throttle.recordFailure("1.2.3.4");

    clock.advance(10 * MINUTE);
    expect(throttle.retryAfterSeconds("1.2.3.4")).toBe(0);
  });

  it("forgets failures after a success", () => {
    const throttle = new AttemptThrottle(5, 10 * MINUTE);
    for (let attempt = 0; attempt < 4; attempt++) throttle.recordFailure("1.2.3.4");
    throttle.clear("1.2.3.4");
    throttle.recordFailure("1.2.3.4");
    expect(throttle.retryAfterSeconds("1.2.3.4")).toBe(0);
  });
});
