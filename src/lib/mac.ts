/**
 * MAC "localmente administrado" (bit U/L do primeiro octeto ligado): gerado aleatoriamente por
 * celulares e notebooks modernos (iOS, Android, Windows) por privacidade, e trocado de tempos em
 * tempos — por isso o mesmo aparelho pode reaparecer como um "dispositivo novo".
 */
export function isRandomizedMac(mac: string | null | undefined): boolean {
  if (!mac) return false;
  const firstByte = parseInt(mac.slice(0, 2), 16);
  return !Number.isNaN(firstByte) && (firstByte & 0b10) !== 0;
}
