/**
 * Leitura do nome de uma interface de switch (ex: "GigabitEthernet1/0/5") em partes que um humano
 * entende: tipo/velocidade nominal e a posição física no chassi. Puro, sem rede — usado no popover
 * das portas na página Equipamentos.
 */

export interface PortNameInfo {
  /** Nome completo do tipo (ex: "GigabitEthernet"). */
  type: string;
  /** Abreviação usada na CLI (ex: "GE"). */
  abbr: string;
  /** Explicação do tipo (ex: "Ethernet de 1 Gbps"). */
  typeLabel: string;
  /** Números da posição na ordem do nome (ex: [1, 0, 5]). */
  numbers: number[];
  /** Cada número explicado (ex: "Membro da pilha 1"), na mesma ordem. */
  parts: string[];
  /** Subinterface (ex: o ".100" de "GE1/0/1.100"). */
  subinterface: number | null;
}

interface TypeInfo {
  abbr: string;
  label: string;
}

// Ordem importa: os nomes mais longos primeiro ("Ten-GigabitEthernet" antes de "GigabitEthernet").
const TYPES: [RegExp, string, TypeInfo][] = [
  [/^(Hundred-?GigE|HundredGigE|HundredGigabitEthernet)$/i, "HundredGigE", { abbr: "HGE", label: "Ethernet de 100 Gbps" }],
  [/^(Forty-?GigE|FortyGigE|FortyGigabitEthernet)$/i, "FortyGigE", { abbr: "FGE", label: "Ethernet de 40 Gbps" }],
  [/^(Twenty-?FiveGigE|TwentyFiveGigE)$/i, "Twenty-FiveGigE", { abbr: "WGE", label: "Ethernet de 25 Gbps" }],
  [/^(Ten-?GigabitEthernet|TenGigE|XGE|Te)$/i, "Ten-GigabitEthernet", { abbr: "XGE", label: "Ethernet de 10 Gbps" }],
  [/^(M-?GigabitEthernet|MGE)$/i, "M-GigabitEthernet", { abbr: "MGE", label: "Porta de gerência de 1 Gbps (fora da comutação)" }],
  [/^(GigabitEthernet|GE|Gi)$/i, "GigabitEthernet", { abbr: "GE", label: "Ethernet de 1 Gbps" }],
  [/^(FastEthernet|FE|Fa)$/i, "FastEthernet", { abbr: "FE", label: "Ethernet de 100 Mbps" }],
  [/^(Ethernet|Eth|Et)$/i, "Ethernet", { abbr: "Eth", label: "Ethernet (10/100 Mbps)" }],
  [/^(Bridge-?Aggregation|BAGG|Port-?channel|Po)$/i, "Bridge-Aggregation", { abbr: "BAGG", label: "Agregação de links (LACP/estática), várias portas físicas como uma" }],
  [/^(Vlan-?interface|Vlanif|Vlan)$/i, "Vlan-interface", { abbr: "Vlan", label: "Interface virtual de VLAN (endereço IP do switch naquela VLAN)" }],
  [/^(InLoopBack|LoopBack|Lo)$/i, "LoopBack", { abbr: "Loop", label: "Interface de loopback (virtual)" }],
  [/^NULL$/i, "NULL", { abbr: "NULL", label: "Interface nula (descarta o tráfego)" }],
];

/** Tipos cuja posição segue o padrão membro/slot/porta do Comware (HP/H3C). */
const PHYSICAL = new Set(["HundredGigE", "FortyGigE", "Twenty-FiveGigE", "Ten-GigabitEthernet", "M-GigabitEthernet", "GigabitEthernet", "FastEthernet", "Ethernet"]);

function explainNumbers(type: string, numbers: number[]): string[] {
  if (!PHYSICAL.has(type)) return numbers.map((n) => `Número ${n}`);
  if (numbers.length === 3) {
    // Comware: membro da pilha IRF / slot (0 = placa principal do próprio switch) / porta.
    return [
      `Membro ${numbers[0]} da pilha IRF (num switch sozinho é sempre 1)`,
      numbers[1] === 0 ? "Slot 0: portas fixas do próprio switch" : `Slot/módulo ${numbers[1]}`,
      `Porta ${numbers[2]}`,
    ];
  }
  if (numbers.length === 2) return [`Slot/módulo ${numbers[0]}`, `Porta ${numbers[1]}`];
  if (numbers.length === 1) return [`Porta ${numbers[0]}`];
  return numbers.map((n) => `Número ${n}`);
}

export function parsePortName(name: string): PortNameInfo | null {
  const m = /^([A-Za-z][A-Za-z-]*?)\s*(\d+(?:\/\d+)*)(?:\.(\d+))?$/.exec(name.trim());
  if (!m) return null;
  const [, rawType, position, sub] = m;
  const match = TYPES.find(([re]) => re.test(rawType));
  if (!match) return null;
  const [, type, info] = match;
  const numbers = position.split("/").map(Number);
  return {
    type,
    abbr: info.abbr,
    typeLabel: info.label,
    numbers,
    parts: explainNumbers(type, numbers),
    subinterface: sub !== undefined ? Number(sub) : null,
  };
}
