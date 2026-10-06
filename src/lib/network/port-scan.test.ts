import { describe, expect, it } from "vitest";
import { CLASSIFICATION_PORTS } from "./port-scan";

describe("CLASSIFICATION_PORTS", () => {
  it("inclui as portas usadas para detectar Smart TV e IoT", () => {
    // Chromecast / Android TV (8008, 8009) e broker MQTT (1883)
    expect(CLASSIFICATION_PORTS).toEqual(expect.arrayContaining([8008, 8009, 1883]));
  });
});
