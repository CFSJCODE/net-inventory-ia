import { PORT_SERVICES } from "@/lib/network/tools/port-scan";

export type Severity = "alta" | "média" | "baixa";

export interface SecurityFinding {
  port: number;
  service: string;
  severity: Severity;
  risk: string;
  recommendation: string;
}

/**
 * Regras determinísticas para portas abertas arriscadas — funcionam sem IA. A IA (opcional) só
 * reescreve a explicação considerando o contexto do dispositivo.
 */
const RULES: Record<number, Omit<SecurityFinding, "port" | "service">> = {
  23: { severity: "alta", risk: "Telnet transmite usuário e senha sem criptografia; qualquer um na rede pode capturá-los.", recommendation: "Desative o Telnet e use SSH (porta 22)." },
  21: { severity: "média", risk: "FTP envia credenciais e arquivos sem criptografia.", recommendation: "Desative o FTP ou troque por SFTP/FTPS." },
  445: { severity: "média", risk: "Compartilhamento de arquivos do Windows (SMB) é alvo frequente de ransomware e worms.", recommendation: "Mantenha o Windows atualizado, desative o SMBv1 e compartilhe só o necessário." },
  139: { severity: "média", risk: "NetBIOS/SMB antigo expõe nomes e compartilhamentos da máquina.", recommendation: "Desative o NetBIOS sobre TCP/IP se não usar compartilhamentos antigos." },
  3389: { severity: "média", risk: "Área de Trabalho Remota (RDP) é muito atacada por força bruta.", recommendation: "Use senha forte, ative NLA e nunca exponha a porta para a internet." },
  5900: { severity: "alta", risk: "VNC costuma ter autenticação fraca e tráfego sem criptografia.", recommendation: "Desative o VNC ou use-o só por túnel SSH/VPN com senha forte." },
  2375: { severity: "alta", risk: "API do Docker sem TLS: quem acessa a porta controla o host inteiro.", recommendation: "Desative a porta 2375 ou exija TLS (2376) com certificado de cliente." },
  5555: { severity: "alta", risk: "ADB (depuração Android) aberto permite instalar apps e controlar o aparelho.", recommendation: "Desative a depuração ADB pela rede nas opções de desenvolvedor." },
  1883: { severity: "média", risk: "MQTT sem autenticação permite ler e enviar comandos para dispositivos de automação.", recommendation: "Exija usuário/senha no broker MQTT e prefira TLS (8883)." },
  7547: { severity: "média", risk: "TR-069 é o gerenciamento remoto da operadora; já teve falhas graves exploradas em massa.", recommendation: "Mantenha o firmware do roteador atualizado; a operadora controla essa porta." },
  6379: { severity: "alta", risk: "Redis geralmente não tem senha por padrão e permite executar comandos no servidor.", recommendation: "Configure senha (requirepass) e limite o acesso à rede local." },
  27017: { severity: "alta", risk: "MongoDB sem autenticação expõe todo o banco de dados.", recommendation: "Ative a autenticação e restrinja o bind_ip." },
  9200: { severity: "alta", risk: "Elasticsearch sem autenticação expõe e permite apagar os dados.", recommendation: "Ative a segurança do Elasticsearch (usuários e TLS)." },
  80: { severity: "baixa", risk: "Painel web sem HTTPS: senhas digitadas trafegam sem criptografia na rede local.", recommendation: "Prefira o acesso por HTTPS e troque a senha padrão do painel." },
  8080: { severity: "baixa", risk: "Serviço web alternativo sem HTTPS.", recommendation: "Confirme o que está rodando e troque senhas padrão." },
  554: { severity: "média", risk: "Stream de câmera (RTSP) costuma ter senha padrão ou nenhuma.", recommendation: "Defina senha forte na câmera e atualize o firmware." },
  37777: { severity: "alta", risk: "Porta de DVR/NVR Dahua com histórico de falhas que permitem acesso sem senha.", recommendation: "Atualize o firmware e não exponha o equipamento à internet." },
  1900: { severity: "baixa", risk: "UPnP pode permitir que dispositivos abram portas no roteador sozinhos.", recommendation: "Desative o UPnP no roteador se não precisar." },
};

const SEVERITY_ORDER: Record<Severity, number> = { alta: 0, média: 1, baixa: 2 };

export function findingsForPorts(ports: number[]): SecurityFinding[] {
  return ports
    .filter((p) => RULES[p])
    .map((port) => ({ port, service: PORT_SERVICES[port] ?? `porta ${port}`, ...RULES[port] }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.port - b.port);
}

export function parsePorts(openPorts: string | null): number[] {
  return (openPorts ?? "").split(",").filter(Boolean).map(Number);
}
