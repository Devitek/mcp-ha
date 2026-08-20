import { describe, expect, it } from "vitest";
import { AuthRateLimiter } from "./ratelimit.js";

function limiter(startAt = 0) {
  let now = startAt;
  const rl = new AuthRateLimiter(() => now);
  return { rl, advance: (ms: number) => (now += ms) };
}

describe("AuthRateLimiter (audit D3)", () => {
  it("lets the first failures through then blocks progressively", () => {
    const { rl } = limiter();
    for (let i = 0; i < 5; i++) expect(rl.fail("1.2.3.4")).toBe(0);
    expect(rl.fail("1.2.3.4")).toBe(1_000);
    expect(rl.fail("1.2.3.4")).toBe(2_000);
    expect(rl.retryInMs("1.2.3.4")).toBeGreaterThan(0);
  });

  it("caps the block at one minute", () => {
    const { rl } = limiter();
    for (let i = 0; i < 30; i++) rl.fail("1.2.3.4");
    expect(rl.retryInMs("1.2.3.4")).toBeLessThanOrEqual(60_000);
  });

  it("unblocks once the delay has elapsed and forgets after inactivity", () => {
    const { rl, advance } = limiter();
    for (let i = 0; i < 6; i++) rl.fail("1.2.3.4");
    expect(rl.retryInMs("1.2.3.4")).toBe(1_000);
    advance(1_500);
    expect(rl.retryInMs("1.2.3.4")).toBe(0);
    advance(11 * 60_000);
    expect(rl.retryInMs("1.2.3.4")).toBe(0);
  });

  it("clears an IP on success and isolates IPs from each other", () => {
    const { rl } = limiter();
    for (let i = 0; i < 6; i++) rl.fail("1.2.3.4");
    expect(rl.fail("5.6.7.8")).toBe(0);
    rl.succeed("1.2.3.4");
    expect(rl.retryInMs("1.2.3.4")).toBe(0);
  });
});
