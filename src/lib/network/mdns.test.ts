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

  it("identifica Smart TVs e aparelhos de streaming", () => {
    expect(inferTypeFromServices(["_googlecast"], "Chromecast Sala")).toBe("SMART_TV");
    expect(inferTypeFromServices(["_media-remotetv"], "LG WebOS TV")).toBe("SMART_TV");
    expect(inferTypeFromServices([], "Samsung Tizen Smart TV")).toBe("SMART_TV");
    expect(inferTypeFromServices([], "Roku Express 4K")).toBe("SMART_TV");
    expect(inferTypeFromServices([], "Apple TV 4K")).toBe("SMART_TV");
  });

  it("identifica dispositivos IoT e automação residencial", () => {
    expect(inferTypeFromServices(["_hap"], "Lâmpada Inteligente")).toBe("IOT");
    expect(inferTypeFromServices(["_esphomelib"], "ESP32 Sensor")).toBe("IOT");
    expect(inferTypeFromServices([], "Sonoff Mini R2")).toBe("IOT");
    expect(inferTypeFromServices([], "Shelly Plus 1PM")).toBe("IOT");
    expect(inferTypeFromServices([], "Tuya Smart Plug")).toBe("IOT");
    expect(inferTypeFromServices([], "Amazon Echo Dot 5th Gen")).toBe("IOT");
  });

  it("identifica celulares", () => {
    expect(inferTypeFromServices(["_spotify-connect"], "iPhone 15")).toBe("MOBILE");
  });

  it("retorna undefined para serviços desconhecidos ou vazios", () => {
    expect(inferTypeFromServices([], "")).toBeUndefined();
    expect(inferTypeFromServices(["_custom._tcp"], "Unknown Device")).toBeUndefined();
  });
});
