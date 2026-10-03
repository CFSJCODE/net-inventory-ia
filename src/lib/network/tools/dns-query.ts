import dns from "node:dns/promises";
import net from "node:net";
import type { MxRecord, SoaRecord, SrvRecord } from "node:dns";
import { getSystemDnsServers } from "../system-dns";
import type { DnsRecordType } from "./constants";

export { DNS_RECORD_TYPES, type DnsRecordType } from "./constants";

export interface DnsQueryResult {
  name: string;
  type: DnsRecordType;
  server: string;
  records: string[];
  durationMs: number;
}

function formatRecord(type: DnsRecordType, record: unknown): string {
  if (typeof record === "string") return record;
  switch (type) {
    case "MX": {
      const r = record as MxRecord;
      return `${r.priority} ${r.exchange}`;
    }
    case "TXT":
      return (record as string[]).join("");
    case "SOA": {
      const r = record as SoaRecord;
      return `${r.nsname} ${r.hostmaster} serial=${r.serial} refresh=${r.refresh} retry=${r.retry} expire=${r.expire} ttl=${r.minttl}`;
    }
    case "SRV": {
      const r = record as SrvRecord;
      return `${r.priority} ${r.weight} ${r.port} ${r.name}`;
    }
    default:
      return JSON.stringify(record);
  }
}

const DNS_ERRORS: Record<string, string> = {
  ENOTFOUND: "Nome não encontrado (NXDOMAIN)",
  ENODATA: "O nome existe, mas não tem registros desse tipo",
  ETIMEOUT: "Servidor DNS não respondeu (timeout)",
  ECONNREFUSED: "Servidor DNS recusou a conexão",
  ESERVFAIL: "Servidor DNS retornou falha (SERVFAIL)",
  EREFUSED: "Servidor DNS recusou a consulta",
};

/**
 * Consulta DNS de um tipo de registro. Para PTR, aceita um IP e monta o nome in-addr.arpa.
 * `server` vazio usa os servidores configurados nos adaptadores de rede do sistema.
 */
export async function dnsQuery(name: string, type: DnsRecordType, server?: string): Promise<DnsQueryResult> {
  const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
  if (server) {
    if (!net.isIP(server)) throw new Error("Servidor DNS deve ser um endereço IP.");
    resolver.setServers([server]);
  } else {
    const systemServers = await getSystemDnsServers();
    if (systemServers.length) resolver.setServers(systemServers);
  }

  const started = performance.now();
  try {
    const records =
      type === "PTR" && net.isIP(name)
        ? await resolver.reverse(name)
        : // SOA vem como objeto único; os demais tipos, como array.
          [(await resolver.resolve(name, type)) as unknown].flat().map((r) => formatRecord(type, r));
    return {
      name,
      type,
      server: resolver.getServers().join(", "),
      records,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    throw new Error(DNS_ERRORS[code] ?? `Falha na consulta DNS (${code || String(err)})`);
  }
}
