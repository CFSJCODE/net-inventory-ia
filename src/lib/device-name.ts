interface Nameable {
  alias?: string | null;
  hostname?: string | null;
  ip?: string;
}

/**
 * Nome de exibição de um dispositivo, usado em todo o app: o apelido dado pelo usuário tem
 * prioridade sobre o hostname descoberto pelo scan.
 */
export function displayName<F extends string | null = string>(device: Nameable, fallback: F = "Dispositivo sem nome" as F): string | F {
  return device.alias?.trim() || device.hostname || fallback;
}

/** "Nome (IP)" quando há nome; só o IP quando não há — para mensagens de eventos. */
export function nameWithIp(device: Nameable & { ip: string }): string {
  const name = displayName(device, null);
  return name ? `${name} (${device.ip})` : device.ip;
}
