import dgram from "node:dgram";

export function parseMac(raw: string): Buffer {
  const hex = raw.replace(/[:\-.\s]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) throw new Error(`MAC inválido: ${raw}`);
  return Buffer.from(hex, "hex");
}

/** Magic packet: 6 bytes 0xFF seguidos do MAC de destino repetido 16 vezes. */
function buildMagicPacket(mac: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => mac)]);
}

export interface WakeOnLanResult {
  mac: string;
  targets: string[];
}

/**
 * Wake-on-LAN: envia o magic packet em broadcast (UDP 9). Enviamos para o broadcast da sub-rede
 * e para 255.255.255.255, algumas vezes cada, já que UDP não garante entrega. O PC de destino
 * precisa ter WoL habilitado na BIOS/UEFI e na placa de rede.
 */
export async function wakeOnLan(macRaw: string, broadcast: string, port = 9): Promise<WakeOnLanResult> {
  const mac = parseMac(macRaw);
  const packet = buildMagicPacket(mac);
  const targets = Array.from(new Set([broadcast, "255.255.255.255"]));

  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, () => {
      socket.setBroadcast(true);
      resolve();
    });
  });

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const target of targets) {
        await new Promise<void>((resolve, reject) => socket.send(packet, port, target, (err) => (err ? reject(err) : resolve())));
      }
    }
  } finally {
    socket.close();
  }

  return { mac: mac.toString("hex").toUpperCase().match(/../g)!.join(":"), targets };
}
