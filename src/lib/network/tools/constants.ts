// Constantes compartilhadas com a interface — este módulo não pode importar APIs do Node.

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "SRV", "PTR"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];
