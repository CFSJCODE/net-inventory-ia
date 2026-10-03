import { describe, expect, it } from "vitest";
import { buildRequest, parseResponse } from "./snmp";

/** Monta TLV BER à mão (independente do código testado). Só tamanhos curtos (< 128 bytes). */
const tlv = (tag: string, valueHex: string) => tag + (valueHex.length / 2).toString(16).padStart(2, "0") + valueHex;

describe("SNMP BER", () => {
  it("GET sysDescr v2c 'public' gera os bytes canônicos", () => {
    const hex = buildRequest("2c", "public", 0xa0, 1, ["1.3.6.1.2.1.1.1.0"]).toString("hex");
    expect(hex).toBe("302602010104067075626c6963a019020101020100020100300e300c06082b060102010101000500");
  });

  it("decodifica string, TimeTicks e a exceção noSuchInstance", () => {
    const binds =
      tlv("30", tlv("06", "2b06010201010500") + tlv("04", "5231")) + // sysName = "R1"
      tlv("30", tlv("06", "2b06010201010300") + tlv("43", "008403e0")) + // sysUpTime = 8651744 centésimos
      tlv("30", tlv("06", "2b06010201010600") + "8100"); // sysLocation = noSuchInstance
    const pdu = tlv("a2", "020107" + "020100" + "020100" + tlv("30", binds));
    const packet = Buffer.from(tlv("30", "020101" + tlv("04", "7075626c6963") + pdu), "hex");

    expect(parseResponse(packet, 7)).toEqual([
      { oid: "1.3.6.1.2.1.1.5.0", value: "R1" },
      { oid: "1.3.6.1.2.1.1.3.0", value: "1d 0h 1m" },
      { oid: "1.3.6.1.2.1.1.6.0", value: "", exception: "noSuchInstance" },
    ]);
  });

  it("ignora resposta de outra requisição e pacote malformado", () => {
    const packet = Buffer.from(tlv("30", "020101" + tlv("04", "7075626c6963") + tlv("a2", "020107020100020100" + tlv("30", ""))), "hex");
    expect(parseResponse(packet, 8)).toBeNull();
    expect(parseResponse(Buffer.from("3005ff", "hex"), 7)).toBeNull();
  });
});
