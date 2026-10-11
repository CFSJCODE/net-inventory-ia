const PREFIXES: Record<string, string> = {
  GE: "GE = GigabitEthernet: Ethernet de 1 Gbps",
  XGE: "XGE = Ten-GigabitEthernet: Ethernet de 10 Gbps",
  FE: "FE = FastEthernet: Ethernet de 100 Mbps",
  Eth: "Eth = Ethernet",
};

/**
 * Explica um nome de porta como o do HP/Comware ("GE1/0/3") em linhas legíveis, para a dica do mapa.
 * Aceita o rótulo da ligação ("porta GE1/0/3"). Sem o padrão tipo + membro/slot/porta, retorna undefined.
 */
export function explainPortName(label: string): string | undefined {
  const m = /^(?:porta\s+)?(XGE|GE|FE|Eth)(\d+)\/(\d+)\/(\d+)$/i.exec(label.trim());
  if (!m) return undefined;
  const prefix = Object.keys(PREFIXES).find((p) => p.toLowerCase() === m[1].toLowerCase())!;
  const [member, slot, port] = [m[2], m[3], m[4]];
  return [
    PREFIXES[prefix],
    `${member} = Membro ${member} da pilha IRF (num switch sozinho é sempre 1)`,
    slot === "0" ? "0 = Slot 0: portas fixas do próprio switch" : `${slot} = Slot ${slot}: módulo de expansão`,
    `${port} = Porta ${port}`,
  ].join("\n");
}
