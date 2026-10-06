import { describe, expect, it } from "vitest";
import { inferTypeFromServices } from "./mdns";

describe("inferTypeFromServices", () => {
  it("identifica impressoras por serviços mDNS e texto", () => {
    expect(inferTypeFromServices(["_ipp"], "")).toBe("PRINTER");
    expect(inferTypeFromServices(["_printer"], "")).toBe("PRINTER");
    expect(inferTypeFromServices(["_pdl-datastream"], "")).toBe("PRINTER");
    expect(inferTypeFromServices(["_scanner"], "")).toBe("PRINTER");
    expect(inferTypeFromServices([], "HP LaserJet Pro MFP M428fdw")).toBe("PRINTER");
    expect(inferTypeFromServices([], "Epson EcoTank L3250")).toBe("PRINTER");
    expect(inferTypeFromServices([], "Brother MFC-L2740DW")).toBe("PRINTER");
  });

  it("identifica câmeras e NVRs por texto e modelo", () => {
    expect(inferTypeFromServices([], "Hikvision IP Camera")).toBe("CAMERA");
    expect(inferTypeFromServices([], "Intelbras NVR 32 Canais")).toBe("NVR");
    expect(inferTypeFromServices([], "Dahua DVR 1080p")).toBe("NVR");
  });

  it("identifica roteadores por serviços mDNS e texto", () => {
    expect(inferTypeFromServices(["_dhnap"], "")).toBe("ROUTER");
    expect(inferTypeFromServices([], "TP-Link Archer AX50 Wireless Router")).toBe("ROUTER");
  });

  it("identifica dispositivos móveis e streaming (Chromecast, Apple TV)", () => {
    expect(inferTypeFromServices(["_googlecast"], "Chromecast Sala")).toBe("COMPUTER");
    expect(inferTypeFromServices(["_airplay"], "Apple TV")).toBe("COMPUTER");
    expect(inferTypeFromServices(["_spotify-connect"], "iPhone 15")).toBe("MOBILE");
  });

  it("retorna undefined para serviços desconhecidos ou vazios", () => {
    expect(inferTypeFromServices([], "")).toBeUndefined();
    expect(inferTypeFromServices(["_custom._tcp"], "Unknown Device")).toBeUndefined();
  });
});
