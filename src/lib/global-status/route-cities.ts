/**
 * Cidade de um roteador pelo nome reverso (rDNS) (fase 5). Operadoras e redes de trânsito costumam pôr no nome
 * o código do aeroporto ("gru", "mia"), um código CLLI ("miamfl", "nycmny") ou o nome da cidade
 * ("fortaleza"). A tabela cobre os pontos por onde a rota do Brasil passa: capitais brasileiras, as cidades
 * dos cabos submarinos e os grandes pontos de troca dos EUA, Europa e América do Sul.
 *
 * Só vale um pedaço inteiro do nome (separado por ".", "-" ou "_"), com ou sem números no fim: "gru1",
 * "gru09s12" e "mia03" valem; "group" e "miami-dade" não confundem ("miami" vale, "dade" não está na tabela).
 */

export interface City {
  name: string;
  /** ISO 3166-1 alfa-2. */
  country: string;
  lat: number;
  lon: number;
}

const c = (name: string, country: string, lat: number, lon: number): City => ({ name, country, lat, lon });

const SAO_PAULO = c("São Paulo", "BR", -23.55, -46.63);
const RIO = c("Rio de Janeiro", "BR", -22.91, -43.17);
const FORTALEZA = c("Fortaleza", "BR", -3.72, -38.54);
const BRASILIA = c("Brasília", "BR", -15.79, -47.88);
const BH = c("Belo Horizonte", "BR", -19.92, -43.94);
const PORTO_ALEGRE = c("Porto Alegre", "BR", -30.03, -51.23);
const CURITIBA = c("Curitiba", "BR", -25.43, -49.27);
const SALVADOR = c("Salvador", "BR", -12.97, -38.5);
const RECIFE = c("Recife", "BR", -8.05, -34.9);
const CAMPINAS = c("Campinas", "BR", -22.91, -47.06);
const SANTOS = c("Santos", "BR", -23.96, -46.33);
const FLORIANOPOLIS = c("Florianópolis", "BR", -27.6, -48.55);
const MANAUS = c("Manaus", "BR", -3.12, -60.02);
const BELEM = c("Belém", "BR", -1.46, -48.5);
const GOIANIA = c("Goiânia", "BR", -16.69, -49.26);
const VITORIA = c("Vitória", "BR", -20.32, -40.34);
const NATAL = c("Natal", "BR", -5.79, -35.21);

const MIAMI = c("Miami", "US", 25.76, -80.19);
const NEW_YORK = c("Nova York", "US", 40.71, -74.01);
const NEWARK = c("Newark", "US", 40.74, -74.17);
const ASHBURN = c("Ashburn", "US", 39.04, -77.49);
const WASHINGTON = c("Washington", "US", 38.91, -77.04);
const ATLANTA = c("Atlanta", "US", 33.75, -84.39);
const DALLAS = c("Dallas", "US", 32.78, -96.8);
const CHICAGO = c("Chicago", "US", 41.88, -87.63);
const LOS_ANGELES = c("Los Angeles", "US", 34.05, -118.24);
const SAN_JOSE = c("San Jose", "US", 37.34, -121.89);
const SEATTLE = c("Seattle", "US", 47.61, -122.33);
const BOCA_RATON = c("Boca Raton", "US", 26.37, -80.13);
const JACKSONVILLE = c("Jacksonville", "US", 30.33, -81.66);
const VIRGINIA_BEACH = c("Virginia Beach", "US", 36.85, -75.98);

const LONDON = c("Londres", "GB", 51.51, -0.13);
const FRANKFURT = c("Frankfurt", "DE", 50.11, 8.68);
const AMSTERDAM = c("Amsterdã", "NL", 52.37, 4.9);
const PARIS = c("Paris", "FR", 48.86, 2.35);
const MARSEILLE = c("Marselha", "FR", 43.3, 5.37);
const MADRID = c("Madri", "ES", 40.42, -3.7);
const LISBON = c("Lisboa", "PT", 38.72, -9.14);
const SINES = c("Sines", "PT", 37.96, -8.87);
const MILAN = c("Milão", "IT", 45.46, 9.19);

const BUENOS_AIRES = c("Buenos Aires", "AR", -34.6, -58.38);
const SANTIAGO = c("Santiago", "CL", -33.45, -70.67);
const MONTEVIDEO = c("Montevidéu", "UY", -34.9, -56.16);
const BOGOTA = c("Bogotá", "CO", 4.71, -74.07);
const LIMA = c("Lima", "PE", -12.05, -77.04);
const MEXICO_CITY = c("Cidade do México", "MX", 19.43, -99.13);
const QUERETARO = c("Querétaro", "MX", 20.59, -100.39);
const LUANDA = c("Luanda", "AO", -8.84, 13.23);
const JOHANNESBURG = c("Joanesburgo", "ZA", -26.2, 28.05);
const CAPE_TOWN = c("Cidade do Cabo", "ZA", -33.92, 18.42);

/** Códigos de aeroporto e abreviações de três letras usadas por operadoras. */
const CODES3: Record<string, City> = {
  gru: SAO_PAULO, spo: SAO_PAULO, sao: SAO_PAULO, cgh: SAO_PAULO,
  gig: RIO, rjo: RIO, rio: RIO, sdu: RIO,
  for: FORTALEZA, ftz: FORTALEZA,
  bsb: BRASILIA, cnf: BH, bhz: BH, poa: PORTO_ALEGRE, cwb: CURITIBA, ssa: SALVADOR, rec: RECIFE,
  vcp: CAMPINAS, fln: FLORIANOPOLIS, mao: MANAUS, gyn: GOIANIA, vix: VITORIA,
  mia: MIAMI, nyc: NEW_YORK, jfk: NEW_YORK, lga: NEW_YORK, ewr: NEWARK, iad: ASHBURN, ash: ASHBURN, dca: WASHINGTON, was: WASHINGTON,
  atl: ATLANTA, dfw: DALLAS, dal: DALLAS, ord: CHICAGO, chi: CHICAGO, lax: LOS_ANGELES, sjc: SAN_JOSE, sea: SEATTLE, jax: JACKSONVILLE,
  lhr: LONDON, lon: LONDON, ldn: LONDON, fra: FRANKFURT, ams: AMSTERDAM, cdg: PARIS, par: PARIS, mrs: MARSEILLE, mad: MADRID, lis: LISBON, mxp: MILAN,
  eze: BUENOS_AIRES, bue: BUENOS_AIRES, aep: BUENOS_AIRES, scl: SANTIAGO, mvd: MONTEVIDEO, bog: BOGOTA, lim: LIMA, mex: MEXICO_CITY, qro: QUERETARO,
  lad: LUANDA, jnb: JOHANNESBURG, cpt: CAPE_TOWN,
};

/** Códigos CLLI (quatro letras da cidade e duas do estado ou país), comuns em redes de trânsito dos EUA. */
const CLLI: Record<string, City> = {
  miamfl: MIAMI, nycmny: NEW_YORK, nwrknj: NEWARK, asbnva: ASHBURN, washdc: WASHINGTON, atlnga: ATLANTA, dllstx: DALLAS,
  chcgil: CHICAGO, lsanca: LOS_ANGELES, snjsca: SAN_JOSE, sttlwa: SEATTLE, bcrtfl: BOCA_RATON, jcvlfl: JACKSONVILLE, vrbcva: VIRGINIA_BEACH,
  londen: LONDON, frnkge: FRANKFURT, amstnl: AMSTERDAM, parsfr: PARIS, mdrdsp: MADRID, lsbnpt: LISBON,
  splobr: SAO_PAULO, sapabr: SAO_PAULO, rijnbr: RIO, ftlzbr: FORTALEZA,
};

/** Nomes por extenso (sem acento e sem espaço, como aparecem nos nomes reversos). */
const NAMES: Record<string, City> = {
  saopaulo: SAO_PAULO, riodejaneiro: RIO, fortaleza: FORTALEZA, brasilia: BRASILIA, belohorizonte: BH, portoalegre: PORTO_ALEGRE,
  curitiba: CURITIBA, salvador: SALVADOR, recife: RECIFE, campinas: CAMPINAS, santos: SANTOS, florianopolis: FLORIANOPOLIS,
  manaus: MANAUS, belem: BELEM, goiania: GOIANIA, vitoria: VITORIA, natal: NATAL,
  miami: MIAMI, newyork: NEW_YORK, ashburn: ASHBURN, atlanta: ATLANTA, dallas: DALLAS, chicago: CHICAGO, losangeles: LOS_ANGELES,
  sanjose: SAN_JOSE, seattle: SEATTLE, bocaraton: BOCA_RATON, jacksonville: JACKSONVILLE, virginiabeach: VIRGINIA_BEACH,
  london: LONDON, frankfurt: FRANKFURT, amsterdam: AMSTERDAM, paris: PARIS, marseille: MARSEILLE, madrid: MADRID, lisbon: LISBON,
  lisboa: LISBON, sines: SINES, milan: MILAN,
  buenosaires: BUENOS_AIRES, santiago: SANTIAGO, montevideo: MONTEVIDEO, bogota: BOGOTA, lima: LIMA, luanda: LUANDA,
  johannesburg: JOHANNESBURG, capetown: CAPE_TOWN,
};

/** A cidade que o nome reverso indica, ou null. Vale o primeiro pedaço reconhecido, da esquerda para a direita. */
export function cityFromHostname(hostname: string | null | undefined): City | null {
  if (!hostname) return null;
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  // O domínio da operadora (as duas últimas partes, ".net.br", ".com") não diz a cidade.
  const tokens = labels.slice(0, Math.max(1, labels.length - 2)).flatMap((label) => label.split(/[-_]/));
  for (const token of tokens) {
    const letters = /^([a-z]+)\d*[a-z]?\d*$/.exec(token)?.[1];
    if (!letters) continue;
    const city = NAMES[letters] ?? CLLI[letters] ?? (letters.length === 3 ? CODES3[letters] : undefined);
    if (city) return city;
  }
  return null;
}

/** Distância em km sobre a superfície da Terra (haversine). */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nome do país em português, para as frases da tela. */
export const COUNTRY_NAME: Record<string, string> = {
  BR: "Brasil", US: "Estados Unidos", GB: "Reino Unido", DE: "Alemanha", NL: "Holanda", FR: "França", ES: "Espanha", PT: "Portugal",
  IT: "Itália", AR: "Argentina", CL: "Chile", UY: "Uruguai", CO: "Colômbia", PE: "Peru", MX: "México", AO: "Angola", ZA: "África do Sul",
  CV: "Cabo Verde", MA: "Marrocos", NG: "Nigéria", CM: "Camarões", GF: "Guiana Francesa", SR: "Suriname", PR: "Porto Rico", IE: "Irlanda",
  DO: "República Dominicana", GT: "Guatemala", CR: "Costa Rica", VE: "Venezuela", CA: "Canadá", JP: "Japão", SG: "Singapura",
};

/** Nome do país como o mapa de cabos escreve (inglês) → ISO alfa-2. */
export const CABLE_COUNTRY_ISO: Record<string, string> = {
  Brazil: "BR", "United States": "US", "United Kingdom": "GB", Germany: "DE", Netherlands: "NL", France: "FR", Spain: "ES",
  Portugal: "PT", Italy: "IT", Argentina: "AR", Chile: "CL", Uruguay: "UY", Colombia: "CO", Peru: "PE", Mexico: "MX", Angola: "AO",
  "South Africa": "ZA", "Cape Verde": "CV", Morocco: "MA", Nigeria: "NG", Cameroon: "CM", "French Guiana": "GF", Suriname: "SR",
  "Puerto Rico": "PR", Ireland: "IE", "Dominican Republic": "DO", Guatemala: "GT", "Costa Rica": "CR", Venezuela: "VE",
  Canada: "CA", Japan: "JP", Singapore: "SG", Mauritania: "MR", "Canary Islands (Spain)": "ES", Ecuador: "EC",
};

export const countryName = (iso: string | null | undefined): string | null => (iso ? (COUNTRY_NAME[iso] ?? iso) : null);
