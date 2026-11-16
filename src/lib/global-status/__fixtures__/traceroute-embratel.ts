/**
 * Saídas de traceroute no formato do `traceroute -n` do Ubuntu, montadas a partir dos rastreios de
 * diagnóstico de 2026-11-16 (VM inventario-lts, operadora Claro/Embratel): ECMP com três IPs no mesmo salto da
 * Embratel, silêncio depois do ingresso no CDN e a rota internacional saindo por Miami. Os IPs públicos são de
 * exemplo; os nomes reversos são os vistos naquele dia.
 */

/** UDP clássico até o Google: três IPs no salto 4 (ECMP) e silêncio depois do peering Embratel ↔ Google. */
export const UDP_GOOGLE_ECMP = [
  "traceroute to 142.250.79.46 (142.250.79.46), 20 hops max, 60 byte packets",
  " 1  192.168.0.1  0.612 ms  0.540 ms",
  " 2  100.64.0.1  6.901 ms  7.002 ms",
  " 3  200.230.10.1  8.110 ms  8.090 ms",
  " 4  200.230.20.5  9.410 ms 200.230.20.9  9.733 ms",
  " 5  200.230.20.13  9.880 ms 200.230.20.5  9.402 ms",
  " 6  200.244.30.2  10.950 ms  11.002 ms",
  " 7  * *",
  " 8  * *",
  " 9  * *",
].join("\n");

/** TCP 443 até o Google: passa o silêncio do UDP e chega ao destino. */
export const TCP_GOOGLE = [
  "traceroute to 142.250.79.46 (142.250.79.46), 20 hops max, 60 byte packets",
  " 1  192.168.0.1  0.602 ms  0.511 ms",
  " 2  100.64.0.1  6.880 ms  6.990 ms",
  " 3  200.230.10.1  8.100 ms  8.120 ms",
  " 4  200.230.20.9  9.700 ms  9.690 ms",
  " 5  200.230.20.13  9.870 ms  9.900 ms",
  " 6  200.244.30.2  10.900 ms  10.980 ms",
  " 7  142.251.65.1  11.400 ms  11.380 ms",
  " 8  142.250.79.46  11.900 ms  11.850 ms",
].join("\n");

/** Rota internacional: a última resposta é a borda internacional da Embratel em Miami. */
export const UDP_MIT_MIAMI = [
  "traceroute to 23.212.110.10 (23.212.110.10), 20 hops max, 60 byte packets",
  " 1  192.168.0.1  0.700 ms  0.650 ms",
  " 2  100.64.0.1  7.100 ms  7.050 ms",
  " 3  200.230.10.1  8.300 ms  8.250 ms",
  " 4  200.230.40.1  12.900 ms  12.880 ms",
  " 5  200.230.250.17  118.300 ms  118.250 ms",
  " 6  * *",
  " 7  * *",
].join("\n");

/** Nomes reversos reais dos saltos da Embratel. */
export const EMBRATEL_PTR = {
  access: "nrjoac01-ae1.embratel.net.br",
  intlMiami: "ebt-B101-intl02.mianap.embratel.net.br",
  peeringGoogle: "peer-B54-agg03.rjo.embratel.net.br",
};

/** O que o traceroute TCP escreve sem CAP_NET_RAW. */
export const TCP_NO_PRIVILEGE = "You do not have enough privileges to use this traceroute method.\nsocket: Operation not permitted";
