import type { DeviceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findingsForPorts, parsePorts, type SecurityFinding, type Severity } from "@/lib/security-rules";
import { Redactor } from "./redact";
import { chatWithTools, structuredResponse, type ToolHandler } from "./client";

const DEVICE_TYPES: DeviceType[] = ["COMPUTER", "NOTEBOOK", "MOBILE", "PRINTER", "CAMERA", "NVR", "SWITCH", "ROUTER", "SERVER", "UNKNOWN"];

const BASE_CONTEXT =
  "Você é um assistente de redes de um app de inventário de rede doméstica/pequena empresa. Responda sempre em português do Brasil, " +
  "de forma curta e prática. Identificadores como 'dispositivo-3', 'ip-5', 'mac-2' são apelidos anônimos de dispositivos, IPs e MACs " +
  "reais: use-os exatamente como estão quando precisar citar algo (o app traduz de volta para o usuário).";

// ---------------------------------------------------------------- 5a. Identificar dispositivo

export interface IdentitySuggestion {
  deviceId: string;
  type: DeviceType;
  suggestedName: string;
  confidence: "alta" | "média" | "baixa";
  reasoning: string;
}

export async function suggestIdentities(deviceIds: string[]): Promise<IdentitySuggestion[]> {
  const devices = await prisma.device.findMany({ where: { id: { in: deviceIds } } });
  if (!devices.length) return [];
  const r = new Redactor();
  const masked = devices.map((d) => r.device(d));

  const result = await structuredResponse<{ sugestoes: { ref: string; type: DeviceType; nome: string; confianca: "alta" | "média" | "baixa"; motivo: string }[] }>({
    feature: "identify",
    instructions:
      `${BASE_CONTEXT} Para cada dispositivo, deduza o tipo e um nome amigável curto (ex: "Smart TV Samsung", "Celular Xiaomi", ` +
      `"Lâmpada inteligente Tuya") a partir do fabricante, portas abertas, MAC aleatório (indica celular/notebook moderno), IPv6 e dicas do nome. ` +
      `Não invente cômodos ou donos. Se não houver evidência suficiente, use confiança baixa e um nome genérico pelo fabricante.`,
    input: { dispositivos: masked },
    schemaName: "sugestoes_identificacao",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["sugestoes"],
      properties: {
        sugestoes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref", "type", "nome", "confianca", "motivo"],
            properties: {
              ref: { type: "string" },
              type: { type: "string", enum: DEVICE_TYPES },
              nome: { type: "string" },
              confianca: { type: "string", enum: ["alta", "média", "baixa"] },
              motivo: { type: "string" },
            },
          },
        },
      },
    },
  });

  const idByRef = new Map(masked.map((m, i) => [m.ref, devices[i].id]));
  return result.sugestoes
    .filter((s) => idByRef.has(s.ref))
    .map((s) => ({
      deviceId: idByRef.get(s.ref)!,
      type: s.type,
      suggestedName: r.unmask(s.nome).slice(0, 80),
      confidence: s.confianca,
      reasoning: r.unmask(s.motivo),
    }));
}

// ---------------------------------------------------------------- 5b. Segurança

export interface SecurityReport {
  findings: SecurityFinding[];
  /** Resumo/explicação da IA; null quando a IA não foi usada. */
  aiSummary: string | null;
}

/** Achados locais de um dispositivo, com explicação contextualizada pela IA. */
export async function explainDeviceSecurity(deviceId: string): Promise<SecurityReport> {
  const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
  const findings = findingsForPorts(parsePorts(device.openPorts));
  if (!findings.length) return { findings, aiSummary: null };

  const r = new Redactor();
  const result = await structuredResponse<{ resumo: string; achados: { port: number; risk: string; recommendation: string }[] }>({
    feature: "security-device",
    instructions:
      `${BASE_CONTEXT} Explique os riscos das portas abertas deste dispositivo considerando o tipo e o fabricante dele, ` +
      `e diga o que o usuário deve fazer. Linguagem simples, sem alarmismo. 'resumo' tem no máximo 3 frases.`,
    input: { dispositivo: r.device(device), achadosLocais: findings },
    schemaName: "analise_seguranca",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["resumo", "achados"],
      properties: {
        resumo: { type: "string" },
        achados: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["port", "risk", "recommendation"],
            properties: { port: { type: "integer" }, risk: { type: "string" }, recommendation: { type: "string" } },
          },
        },
      },
    },
  });

  const byPort = new Map(result.achados.map((a) => [a.port, a]));
  return {
    aiSummary: r.unmask(result.resumo),
    findings: findings.map((f) => {
      const ai = byPort.get(f.port);
      return ai ? { ...f, risk: r.unmask(ai.risk), recommendation: r.unmask(ai.recommendation) } : f;
    }),
  };
}

/** Visão da rede inteira: só regras locais (rápido, sem custo). */
export async function networkFindings(): Promise<{ deviceId: string; findings: SecurityFinding[] }[]> {
  const devices = await prisma.device.findMany({ where: { openPorts: { not: null } } });
  return devices
    .map((d) => ({ deviceId: d.id, findings: findingsForPorts(parsePorts(d.openPorts)) }))
    .filter((d) => d.findings.length);
}

export async function explainNetworkSecurity(): Promise<string> {
  const devices = await prisma.device.findMany();
  const r = new Redactor();
  const withFindings = devices
    .map((d) => ({ dispositivo: r.device(d), achados: findingsForPorts(parsePorts(d.openPorts)).map((f) => ({ porta: f.port, severidade: f.severity, servico: f.service })) }))
    .filter((d) => d.achados.length);
  if (!withFindings.length) return "Nenhuma porta de risco conhecida foi encontrada nos dispositivos do inventário.";

  const result = await structuredResponse<{ texto: string }>({
    feature: "security-network",
    instructions:
      `${BASE_CONTEXT} Faça um diagnóstico de segurança da rede a partir dos achados por dispositivo: comece pelos mais graves, ` +
      `agrupe problemas parecidos e termine com as 3 ações prioritárias. Use listas curtas em Markdown simples.`,
    input: { dispositivos: withFindings },
    schemaName: "diagnostico_rede",
    schema: { type: "object", additionalProperties: false, required: ["texto"], properties: { texto: { type: "string" } } },
  });
  return r.unmask(result.texto);
}

// ---------------------------------------------------------------- 5c. Resumo de eventos

export type SummaryPeriod = "24h" | "7d";

export async function summarizeEvents(period: SummaryPeriod): Promise<string> {
  const since = new Date(Date.now() - (period === "24h" ? 1 : 7) * 24 * 60 * 60 * 1000);
  const [events, devices] = await Promise.all([
    prisma.deviceEvent.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, take: 400 }),
    prisma.device.findMany(),
  ]);

  let text: string;
  if (!events.length) {
    text = `Nenhum evento registrado ${period === "24h" ? "nas últimas 24 horas" : "nos últimos 7 dias"}.`;
  } else {
    const r = new Redactor();
    const masked = new Map(devices.map((d) => [d.id, r.device(d)]));
    const result = await structuredResponse<{ texto: string }>({
      feature: "summary",
      instructions:
        `${BASE_CONTEXT} Resuma os eventos do período para o administrador da rede: dispositivos novos, quedas e retornos de ligações ` +
        `(destaque as que caíram várias vezes — instabilidade), dispositivos que saíram/voltaram e mudanças de IP. ` +
        `No máximo 8 tópicos curtos em Markdown simples. Ignore oscilações irrelevantes de celulares, mas mencione-as em uma linha se forem muitas.`,
      input: {
        periodo: period,
        eventos: events.map((e) => ({ quando: e.createdAt.toISOString(), tipo: e.type, dispositivo: masked.get(e.deviceId)?.ref, texto: r.text(e.message) })),
        dispositivos: Array.from(masked.values()).map((m) => ({ ref: m.ref, tipo: m.tipo, fabricante: m.fabricante, macAleatorio: m.macAleatorio })),
      },
      schemaName: "resumo_eventos",
      schema: { type: "object", additionalProperties: false, required: ["texto"], properties: { texto: { type: "string" } } },
    });
    text = r.unmask(result.texto);
  }

  await prisma.aiSummary.create({ data: { period, text } });
  return text;
}

// ---------------------------------------------------------------- 5d. Assistente

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Assistente com ferramentas somente leitura sobre o inventário. Os resultados das ferramentas são
 * mascarados; as mensagens do usuário também (podem citar IPs/nomes), e a resposta final é desmascarada.
 */
export async function askAssistant(messages: ChatMessage[]): Promise<string> {
  const devices = await prisma.device.findMany({ orderBy: { ip: "asc" } });
  const r = new Redactor();
  const masked = devices.map((d) => r.device(d));
  const idByRef = new Map(masked.map((m, i) => [m.ref, devices[i].id]));
  const severities: Severity[] = ["alta", "média", "baixa"];

  const tools: Record<string, ToolHandler> = {
    listar_dispositivos: {
      definition: {
        type: "function",
        name: "listar_dispositivos",
        description: "Lista os dispositivos do inventário (opcionalmente filtrando por status ou tipo).",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["status", "tipo"],
          properties: {
            status: { type: ["string", "null"], enum: ["ONLINE", "OFFLINE", null] },
            tipo: { type: ["string", "null"], enum: [...DEVICE_TYPES, null] },
          },
        },
      },
      run: async (args) =>
        masked.filter((m) => (!args.status || m.status === args.status) && (!args.tipo || m.tipo === args.tipo)),
    },
    eventos_recentes: {
      definition: {
        type: "function",
        name: "eventos_recentes",
        description: "Eventos do histórico nas últimas N horas (novos dispositivos, quedas de ligação, online/offline, mudanças de IP).",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["horas", "dispositivo"],
          properties: {
            horas: { type: "integer", description: "Janela em horas (1 a 720)." },
            dispositivo: { type: ["string", "null"], description: "Ref de um dispositivo (ex: dispositivo-3) para filtrar, ou null." },
          },
        },
      },
      run: async (args) => {
        const hours = Math.min(Math.max(Number(args.horas) || 24, 1), 720);
        const deviceId = typeof args.dispositivo === "string" ? idByRef.get(args.dispositivo) : undefined;
        const events = await prisma.deviceEvent.findMany({
          where: { createdAt: { gte: new Date(Date.now() - hours * 3600_000) }, ...(deviceId && { deviceId }) },
          orderBy: { createdAt: "desc" },
          take: 150,
        });
        const refById = new Map(Array.from(idByRef, ([ref, id]) => [id, ref]));
        return events.map((e) => ({ quando: e.createdAt.toISOString(), tipo: e.type, dispositivo: refById.get(e.deviceId), texto: r.text(e.message) }));
      },
    },
    ligacoes_monitoradas: {
      definition: {
        type: "function",
        name: "ligacoes_monitoradas",
        description: "Ligações monitoradas entre dispositivos, com status atual (UP/DOWN), desde quando e motivo da queda.",
        strict: true,
        parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
      },
      run: async () => {
        const links = await prisma.topologyLink.findMany();
        const refById = new Map(Array.from(idByRef, ([ref, id]) => [id, ref]));
        return links.map((l) => ({
          de: refById.get(l.fromDeviceId),
          para: refById.get(l.toDeviceId),
          nome: l.label ? r.text(l.label) : null,
          status: l.status,
          desde: l.lastChangeAt?.toISOString() ?? null,
          motivo: l.downReason ? r.text(l.downReason) : null,
          latenciaMs: l.latencyMs,
        }));
      },
    },
    achados_seguranca: {
      definition: {
        type: "function",
        name: "achados_seguranca",
        description: "Portas abertas de risco encontradas nos dispositivos, com severidade e recomendação.",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["severidade_minima"],
          properties: { severidade_minima: { type: "string", enum: severities } },
        },
      },
      run: async (args) => {
        const limit = severities.indexOf(args.severidade_minima as Severity);
        return devices
          .map((d, i) => ({
            dispositivo: masked[i].ref,
            achados: findingsForPorts(parsePorts(d.openPorts)).filter((f) => severities.indexOf(f.severity) <= limit),
          }))
          .filter((d) => d.achados.length);
      },
    },
  };

  const answer = await chatWithTools({
    instructions:
      `${BASE_CONTEXT} Use as ferramentas para consultar dados reais antes de responder; não invente dispositivos nem eventos. ` +
      `Data e hora atuais: ${new Date().toISOString()}. Se a pergunta não for sobre a rede, responda brevemente que você é focado na rede.`,
    messages: messages.slice(-12).map((m) => ({ role: m.role, content: r.text(m.content) })),
    tools,
  });
  return r.unmask(answer);
}
