import { describe, expect, it } from "vitest";
import type { AddonConfig } from "./config.js";
import { entityReadVisible, entityWriteAllowed, globToRegex, matchesAny, safeEqual, serviceAllowed } from "./safety.js";

function cfg(partial: Partial<AddonConfig> = {}): AddonConfig {
  return {
    port: 9583,
    apiToken: "t",
    allowWrite: true,
    filterReads: false,
    entityAllowlist: [],
    entityDenylist: [],
    serviceDenylist: [],
    supervisorToken: null,
    devHaUrl: null,
    devHaToken: null,
    ...partial,
  };
}

describe("globToRegex", () => {
  it("matche un id exact", () => {
    expect(globToRegex("lock.front_door").test("lock.front_door")).toBe(true);
    expect(globToRegex("lock.front_door").test("lock.front_door_2")).toBe(false);
  });

  it("matche un domaine entier avec l'étoile", () => {
    expect(globToRegex("light.*").test("light.cuisine")).toBe(true);
    expect(globToRegex("light.*").test("switch.cuisine")).toBe(false);
  });

  it("échappe les caractères spéciaux de regex", () => {
    // Le point ne doit pas être un joker : light_cuisine ne matche pas light.cuisine
    expect(globToRegex("light.cuisine").test("lightXcuisine")).toBe(false);
    expect(globToRegex("a+b").test("a+b")).toBe(true);
    expect(globToRegex("a+b").test("aab")).toBe(false);
  });

  it("gère l'étoile en plein milieu", () => {
    expect(globToRegex("recorder.purge*").test("recorder.purge_entities")).toBe(true);
    expect(globToRegex("*.cuisine").test("light.cuisine")).toBe(true);
  });

  it("est insensible à la casse", () => {
    expect(matchesAny("Light.Cuisine", ["light.*"])).toBe(true);
  });
});

describe("entityWriteAllowed", () => {
  it("autorise tout quand aucune liste n'est configurée", () => {
    expect(entityWriteAllowed(cfg(), "light.cuisine").allowed).toBe(true);
  });

  it("une allowlist non vide passe en interdit par défaut", () => {
    const c = cfg({ entityAllowlist: ["light.*"] });
    expect(entityWriteAllowed(c, "light.cuisine").allowed).toBe(true);
    expect(entityWriteAllowed(c, "switch.tv").allowed).toBe(false);
  });

  it("la denylist gagne sur l'allowlist", () => {
    const c = cfg({ entityAllowlist: ["light.*"], entityDenylist: ["light.chambre_bebe"] });
    expect(entityWriteAllowed(c, "light.chambre_bebe").allowed).toBe(false);
    expect(entityWriteAllowed(c, "light.salon").allowed).toBe(true);
  });

  it("refuse avec une raison exploitable", () => {
    const c = cfg({ entityDenylist: ["lock.*"] });
    const v = entityWriteAllowed(c, "lock.entree");
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("lock.entree");
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

  it("bloque les services listés, y compris par glob", () => {
    expect(serviceAllowed(c, "homeassistant", "stop").allowed).toBe(false);
    expect(serviceAllowed(c, "hassio", "addon_start").allowed).toBe(false);
    expect(serviceAllowed(c, "shell_command", "reboot_nas").allowed).toBe(false);
    expect(serviceAllowed(c, "recorder", "purge_entities").allowed).toBe(false);
  });

  it("laisse passer les services ordinaires", () => {
    expect(serviceAllowed(c, "light", "turn_on").allowed).toBe(true);
    expect(serviceAllowed(c, "homeassistant", "turn_off").allowed).toBe(true);
  });
});

describe("entityReadVisible", () => {
  it("ne filtre rien par défaut", () => {
    const c = cfg({ entityDenylist: ["camera.*"] });
    expect(entityReadVisible(c, "camera.salon")).toBe(true);
  });

  it("applique la denylist quand filter_reads est actif", () => {
    const c = cfg({ entityDenylist: ["camera.*"], filterReads: true });
    expect(entityReadVisible(c, "camera.salon")).toBe(false);
    expect(entityReadVisible(c, "light.salon")).toBe(true);
  });
});

describe("safeEqual", () => {
  it("compare correctement", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
