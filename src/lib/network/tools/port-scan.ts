import net from "node:net";
import { mapWithConcurrency } from "../concurrency";

export const PORT_SERVICES: Record<number, string> = {
  20: "FTP-data", 21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS", 67: "DHCP", 69: "TFTP",
  80: "HTTP", 88: "Kerberos", 110: "POP3", 111: "RPC", 123: "NTP", 135: "MS-RPC", 137: "NetBIOS-NS",
  139: "NetBIOS-SSN", 143: "IMAP", 161: "SNMP", 389: "LDAP", 443: "HTTPS", 445: "SMB", 465: "SMTPS",
  502: "Modbus", 515: "LPD", 554: "RTSP", 587: "SMTP-sub", 631: "IPP", 636: "LDAPS", 873: "rsync",
  993: "IMAPS", 995: "POP3S", 1433: "MSSQL", 1521: "Oracle", 1723: "PPTP", 1883: "MQTT", 1900: "UPnP",
  2049: "NFS", 2375: "Docker", 3000: "HTTP-dev", 3306: "MySQL", 3389: "RDP", 5000: "UPnP/HTTP",
  5060: "SIP", 5432: "PostgreSQL", 5555: "ADB", 5900: "VNC", 5985: "WinRM", 6379: "Redis",
  7547: "TR-069", 8000: "HTTP-alt/DVR", 8008: "HTTP-alt", 8080: "HTTP-proxy", 8081: "HTTP-alt",
  8443: "HTTPS-alt", 8554: "RTSP-alt", 8888: "HTTP-alt", 9000: "HTTP-alt", 9100: "JetDirect",
  9200: "Elasticsearch", 10000: "Webmin", 27017: "MongoDB", 37777: "Dahua", 49152: "UPnP",
};

export const PORT_PRESETS = {
  common: Object.keys(PORT_SERVICES).join(","),
  wellKnown: "1-1024",
  all: "1-65535",
} as const;

export interface PortScanResult {
  target: string;
  open: { port: number; service: string | null; latencyMs: number }[];
  closed: number;
  filtered: number;
  scanned: number;
  durationMs: number;
}

/** Converte "22,80,8000-8100" em lista de portas únicas e ordenadas. */
export function parsePortSpec(spec: string): number[] {
  const ports = new Set<number>();
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    const [start, end] = range ? [Number(range[1]), Number(range[2])] : [Number(part), Number(part)];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
      throw new Error(`Porta ou faixa inválida: "${part}"`);
    }
    for (let p = start; p <= end; p++) ports.add(p);
  }
  if (!ports.size) throw new Error("Informe ao menos uma porta.");
  return Array.from(ports).sort((a, b) => a - b);
}

type ProbeState = "open" | "closed" | "filtered";

function probePort(host: string, port: number, timeoutMs: number): Promise<{ state: ProbeState; latencyMs: number }> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = new net.Socket();
    let done = false;

    const finish = (state: ProbeState) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ state, latencyMs: Math.round(performance.now() - started) });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("filtered"));
    // RST (ECONNREFUSED) = host respondeu que a porta está fechada; outros erros/sem resposta = filtrada.
    socket.once("error", (err: NodeJS.ErrnoException) => finish(err.code === "ECONNREFUSED" ? "closed" : "filtered"));
    socket.connect(port, host);
  });
}

/** Port Scan (TCP connect, estilo `nmap -sT`): classifica cada porta como aberta, fechada ou filtrada. */
export async function portScan(target: string, portSpec: string, timeoutMs = 500): Promise<PortScanResult> {
  const ports = parsePortSpec(portSpec);
  const started = performance.now();

  const results = await mapWithConcurrency(ports, 256, async (port) => ({ port, ...(await probePort(target, port, timeoutMs)) }));

  return {
    target,
    open: results
      .filter((r) => r.state === "open")
      .map((r) => ({ port: r.port, service: PORT_SERVICES[r.port] ?? null, latencyMs: r.latencyMs })),
    closed: results.filter((r) => r.state === "closed").length,
    filtered: results.filter((r) => r.state === "filtered").length,
    scanned: ports.length,
    durationMs: Math.round(performance.now() - started),
  };
}
