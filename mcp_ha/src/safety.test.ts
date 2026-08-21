import { describe, expect, it } from "vitest";
import type { AddonConfig } from "./config.js";
import { entityReadVisible, entityWriteAllowed, globToRegex, maskSecret, matchesAny, safeEqual, serviceAllowed } from "./safety.js";

function cfg(partial: Partial<AddonConfig> = {}): AddonConfig {
  return {
    port: 9583,
    apiToken: "t",
    apiTokenGenerated: false,
    allowWrite: true,
    allowCamera: false,
    filterReads: false,
    entityAllowlist: [],
    entityDenylist: [],
    serviceDenylist: [],
    confirmDomains: [],
    apiTokens: [],
    supervisorToken: null,
    devHaUrl: null,
    devHaToken: null,
    ...partial,
  };
}

describe("globToRegex", () => {
  it("matches an exact id", () => {
    expect(globToRegex("lock.front_door").test("lock.front_door")).toBe(true);
    expect(globToRegex("lock.front_door").test("lock.front_door_2")).toBe(false);
  });

  it("matches a whole domain with the star", () => {
    expect(globToRegex("light.*").test("light.kitchen")).toBe(true);
    expect(globToRegex("light.*").test("switch.kitchen")).toBe(false);
  });

  it("escapes regex metacharacters", () => {
    // The dot must not act as a wildcard.
    expect(globToRegex("light.kitchen").test("lightXkitchen")).toBe(false);
    expect(globToRegex("a+b").test("a+b")).toBe(true);
    expect(globToRegex("a+b").test("aab")).toBe(false);
  });

  it("handles a star in the middle", () => {
    expect(globToRegex("recorder.purge*").test("recorder.purge_entities")).toBe(true);
    expect(globToRegex("*.kitchen").test("light.kitchen")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(matchesAny("Light.Kitchen", ["light.*"])).toBe(true);
  });
});

describe("entityWriteAllowed", () => {
  it("allows everything when no list is configured", () => {
    expect(entityWriteAllowed(cfg(), "light.kitchen").allowed).toBe(true);
  });

  it("a non-empty allowlist switches to deny by default", () => {
    const c = cfg({ entityAllowlist: ["light.*"] });
    expect(entityWriteAllowed(c, "light.kitchen").allowed).toBe(true);
    expect(entityWriteAllowed(c, "switch.tv").allowed).toBe(false);
  });

  it("the denylist wins over the allowlist", () => {
    const c = cfg({ entityAllowlist: ["light.*"], entityDenylist: ["light.baby_room"] });
    expect(entityWriteAllowed(c, "light.baby_room").allowed).toBe(false);
    expect(entityWriteAllowed(c, "light.living_room").allowed).toBe(true);
  });

  it("refuses with an actionable reason", () => {
    const c = cfg({ entityDenylist: ["lock.*"] });
    const v = entityWriteAllowed(c, "lock.entrance");
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("lock.entrance");
  });
});

describe("serviceAllowed", () => {
  const c = cfg({
    serviceDenylist: [
      "homeassistant.stop",
      "homeassistant.restart",
      "hassio.*",
      "shell_command.*",
      "recorder.purge*",
    ],
  });

  it("blocks denylisted services, including via globs", () => {
    expect(serviceAllowed(c, "homeassistant", "stop").allowed).toBe(false);
    expect(serviceAllowed(c, "hassio", "addon_start").allowed).toBe(false);
    expect(serviceAllowed(c, "shell_command", "reboot_nas").allowed).toBe(false);
    expect(serviceAllowed(c, "recorder", "purge_entities").allowed).toBe(false);
  });

  it("lets ordinary services through", () => {
    expect(serviceAllowed(c, "light", "turn_on").allowed).toBe(true);
    expect(serviceAllowed(c, "homeassistant", "turn_off").allowed).toBe(true);
  });
});

describe("entityReadVisible", () => {
  it("filters nothing by default", () => {
    const c = cfg({ entityDenylist: ["camera.*"] });
    expect(entityReadVisible(c, "camera.living_room")).toBe(true);
  });

  it("applies the denylist when filter_reads is enabled", () => {
    const c = cfg({ entityDenylist: ["camera.*"], filterReads: true });
    expect(entityReadVisible(c, "camera.living_room")).toBe(false);
    expect(entityReadVisible(c, "light.living_room")).toBe(true);
  });
});

describe("safeEqual", () => {
  it("compares correctly", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("maskSecret", () => {
  it("shows only a short prefix followed by fixed padding", () => {
    const secret = "d370f4f8aabbccddeeff00112233445566778899aabbccddeeff001122334455";
    expect(maskSecret(secret)).toBe("d370f4f8**********");
  });

  it("never contains the full secret and hides the real length", () => {
    const secret = "a".repeat(64);
    const masked = maskSecret(secret);
    expect(masked).not.toContain(secret);
    expect(masked.length).toBe(18); // 8 visible + 10 fixed asterisks
    expect(maskSecret("b".repeat(40)).length).toBe(18);
  });

  it("fully masks short secrets and passes empty ones through", () => {
    expect(maskSecret("shorty")).toBe("**********");
    expect(maskSecret("")).toBe("");
  });
});
