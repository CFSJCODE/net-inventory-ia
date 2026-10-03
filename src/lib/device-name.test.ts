import { describe, expect, it } from "vitest";
import { displayName, nameWithIp } from "./device-name";

describe("displayName", () => {
  it("apelido > hostname > padrão", () => {
    expect(displayName({ alias: "TV da sala", hostname: "LGwebOS" })).toBe("TV da sala");
    expect(displayName({ alias: "  ", hostname: "LGwebOS" })).toBe("LGwebOS");
    expect(displayName({ alias: null, hostname: null })).toBe("Dispositivo sem nome");
    expect(displayName({}, null)).toBeNull();
  });

  it("nameWithIp", () => {
    expect(nameWithIp({ hostname: "pc", ip: "10.0.0.2" })).toBe("pc (10.0.0.2)");
    expect(nameWithIp({ ip: "10.0.0.2" })).toBe("10.0.0.2");
  });
});
