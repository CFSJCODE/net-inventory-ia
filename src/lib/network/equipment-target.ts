import type { Equipment } from "@prisma/client";
import { decrypt } from "@/lib/ai/settings";
import type { SnmpTarget } from "./tools/snmp";

/** Community guardada (criptografada); erro claro quando o AUTH_SECRET mudou e ela não abre mais. */
export function openCommunity(stored: string): string {
  const plain = decrypt(stored);
  if (plain === null) throw new Error("Não foi possível ler a community salva (a chave do servidor mudou). Edite o equipamento e informe a community de novo.");
  return plain;
}

/** Alvo SNMP de um equipamento cadastrado, com as credenciais abertas (só no servidor). */
export function snmpTargetOf(eq: Equipment): SnmpTarget {
  const target: SnmpTarget = eq.snmpVersion === "3"
    ? {
        host: eq.ip,
        version: "3",
        username: eq.snmpUsername ? decrypt(eq.snmpUsername) ?? "" : "",
        authPassword: eq.snmpAuthPassword ? decrypt(eq.snmpAuthPassword) ?? "" : "",
        authProtocol: eq.snmpAuthProtocol === "sha" ? "sha" : "md5",
        ...(eq.snmpPrivProtocol && eq.snmpPrivPassword ? { privacyProtocol: eq.snmpPrivProtocol === "aes" ? "aes" as const : "des" as const, privacyPassword: decrypt(eq.snmpPrivPassword) ?? "" } : {}),
      }
    : { host: eq.ip, community: openCommunity(eq.community), version: eq.snmpVersion === "1" ? "1" : "2c" };
  if (target.version === "3" && (!target.username || !target.authPassword)) throw new Error("As credenciais SNMPv3 estão incompletas ou não puderam ser abertas. Edite o equipamento e informe-as novamente.");
  return target;
}
