import { describe, expect, it } from "vitest";
import { ConfirmationStore } from "./confirm.js";

function store(startAt = 0) {
  let now = startAt;
  const s = new ConfirmationStore(() => now);
  return { s, advance: (ms: number) => (now += ms) };
}

const CALL = { domain: "lock", service: "unlock", target: { entity_id: "lock.front" } };

describe("ConfirmationStore (v0.2, #15)", () => {
  it("issues a token that confirms the exact same call", () => {
    const { s } = store();
    const hash = ConfirmationStore.fingerprint(CALL);
    const token = s.issue(hash);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(s.consume(token, hash)).toBe("ok");
  });

  it("is single use, whatever the outcome", () => {
    const { s } = store();
    const hash = ConfirmationStore.fingerprint(CALL);
    const token = s.issue(hash);
    expect(s.consume(token, hash)).toBe("ok");
    expect(s.consume(token, hash)).toBe("unknown");
  });

  it("refuses a token bound to a different call", () => {
    const { s } = store();
    const token = s.issue(ConfirmationStore.fingerprint(CALL));
    const other = ConfirmationStore.fingerprint({ ...CALL, target: { entity_id: "lock.garage" } });
    expect(s.consume(token, other)).toBe("mismatch");
    // and the token is burnt even after a mismatch
    expect(s.consume(token, ConfirmationStore.fingerprint(CALL))).toBe("unknown");
  });

  it("expires after the TTL", () => {
    const { s, advance } = store();
    const hash = ConfirmationStore.fingerprint(CALL);
    const token = s.issue(hash);
    advance(6 * 60_000);
    expect(s.consume(token, hash)).toBe("expired");
  });

  it("fingerprints are order-stable and sensitive to every field", () => {
    const a = ConfirmationStore.fingerprint({ domain: "lock", service: "unlock", target: { entity_id: "x" } });
    const b = ConfirmationStore.fingerprint({ domain: "lock", service: "unlock", target: { entity_id: "x" } });
    const c = ConfirmationStore.fingerprint({ domain: "lock", service: "lock", target: { entity_id: "x" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("caps the number of pending confirmations", () => {
    const { s } = store();
    const first = s.issue("h0");
    for (let i = 1; i < 150; i++) s.issue(`h${i}`);
    expect(s.consume(first, "h0")).toBe("unknown");
  });
});
