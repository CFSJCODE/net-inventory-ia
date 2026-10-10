import { describe, expect, it } from "vitest";
import { macFromOidSuffix, placeByFdb, shortPortName } from "./switch-fdb";

const GW = "AA:00:00:00:00:01";
const DVR = "AA:00:00:00:00:21";
const PRINTER = "AA:00:00:00:00:20";
const TV = "AA:00:00:00:00:26";
const AP = "AA:00:00:00:00:02";
const PHONE = "AA:00:00:00:00:75";

describe("placeByFdb", () => {
  it("pendura no switch os MACs das portas de borda e ignora quem só aparece no uplink", () => {
    const placements = placeByFdb(
      [
        {
          swId: "sw",
          entries: [
            { mac: GW, port: "24", portName: "GE1/0/24" },
            { mac: PHONE, port: "24", portName: "GE1/0/24" }, // Wi-Fi do modem: do lado do gateway
            { mac: DVR, port: "3", portName: "GE1/0/3" },
            { mac: PRINTER, port: "5" },
          ],
        },
      ],
      new Map([[GW, "gw"]]),
      GW,
    );
    expect(placements.get(DVR)).toEqual({ parentId: "sw", label: "porta GE1/0/3" });
    expect(placements.get(PRINTER)).toEqual({ parentId: "sw", label: "porta 5" });
    expect(placements.has(PHONE)).toBe(false);
    expect(placements.has(GW)).toBe(false);
  });

  it("prefere a porta com menos MACs quando o mesmo MAC aparece em dois equipamentos", () => {
    const placements = placeByFdb(
      [
        { swId: "gw", entries: [{ mac: DVR, port: "1" }, { mac: PRINTER, port: "1" }, { mac: TV, port: "1" }] },
        { swId: "sw", entries: [{ mac: DVR, port: "7" }] },
      ],
      new Map(),
      null,
    );
    expect(placements.get(DVR)?.parentId).toBe("sw");
    expect(placements.get(TV)?.parentId).toBe("gw");
  });

  it("dispositivo na mesma porta de um roteador/AP fica atrás dele", () => {
    const placements = placeByFdb(
      [{ swId: "sw", entries: [{ mac: AP, port: "2" }, { mac: TV, port: "2" }, { mac: DVR, port: "3" }] }],
      new Map([[AP, "ap"]]),
      null,
    );
    expect(placements.get(TV)).toEqual({ parentId: "ap" });
    expect(placements.get(AP)).toEqual({ parentId: "sw", label: "porta 2" });
  });
});

describe("helpers", () => {
  it("decodifica o MAC do índice do OID (BRIDGE e Q-BRIDGE)", () => {
    expect(macFromOidSuffix("1.3.6.1.2.1.17.4.3.1.2.0.17.34.51.68.85")).toBe("00:11:22:33:44:55");
    expect(macFromOidSuffix("1.3.6.1.2.1.17.7.1.2.2.1.2.1.0.17.34.51.68.85")).toBe("00:11:22:33:44:55");
  });

  it("encurta nomes de interface", () => {
    expect(shortPortName("GigabitEthernet1/0/5")).toBe("GE1/0/5");
    expect(shortPortName("Ten-GigabitEthernet1/0/25")).toBe("XGE1/0/25");
  });
});
