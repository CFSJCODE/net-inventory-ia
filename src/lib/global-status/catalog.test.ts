import { isIPv4 } from "node:net";
import { describe, expect, it } from "vitest";
import { CATEGORY_LABEL, CATEGORY_ORDER, DEFAULT_INTERVAL_SEC, STATUS_CATALOG, type CatalogEntry } from "./catalog";
import { AUTO_GATEWAY, AUTO_SYSTEM_DNS, DEFAULT_DNS_NAME } from "./types";

const services = STATUS_CATALOG.filter((s) => s.category !== "INTERNET");
const internet = STATUS_CATALOG.filter((s) => s.category === "INTERNET");
const targetsOf = (entry: CatalogEntry, kind: string) => entry.targets.filter((t) => t.kind === kind);

describe("catálogo: identificação", () => {
  it("não repete slug nem nome", () => {
    expect(new Set(STATUS_CATALOG.map((s) => s.slug)).size).toBe(STATUS_CATALOG.length);
    expect(new Set(STATUS_CATALOG.map((s) => s.name)).size).toBe(STATUS_CATALOG.length);
  });

  it("usa slugs que servem de endereço (minúsculas, números e hífen)", () => {
    for (const s of STATUS_CATALOG) expect(s.slug, s.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("só usa categorias que a página sabe ordenar e nomear", () => {
    for (const s of STATUS_CATALOG) {
      expect(CATEGORY_ORDER, s.slug).toContain(s.category);
      expect(CATEGORY_LABEL[s.category], s.slug).toBeTruthy();
    }
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
  });

  it("não repete chave de alvo dentro de um serviço", () => {
    for (const s of STATUS_CATALOG) expect(new Set(s.targets.map((t) => t.key)).size, s.slug).toBe(s.targets.length);
  });

  it("todo serviço tem medição própria", () => {
    for (const s of STATUS_CATALOG) expect(s.targets.length, s.slug).toBeGreaterThan(0);
  });
});

describe("catálogo: fonte oficial", () => {
  it("serviço sem fonte oficial não aponta para fonte nem página de status", () => {
    for (const s of STATUS_CATALOG.filter((x) => x.sourceType === "NONE")) {
      expect(s.sourceUrl, s.slug).toBeNull();
      expect(s.pageUrl, s.slug).toBeNull();
    }
  });

  it("serviço com fonte oficial traz a fonte e a página pública, ambas em https", () => {
    const withSource = STATUS_CATALOG.filter((x) => x.sourceType !== "NONE");
    expect(withSource.length).toBeGreaterThanOrEqual(9);
    for (const s of withSource) {
      expect(new URL(s.sourceUrl!).protocol, s.slug).toBe("https:");
      expect(new URL(s.pageUrl!).protocol, s.slug).toBe("https:");
    }
  });

  it("a conexão do próprio servidor não tem fonte oficial", () => {
    for (const s of internet) expect(s.sourceType, s.slug).toBe("NONE");
  });
});

describe("catálogo: alvos dos serviços", () => {
  it("cobre redes sociais e streaming", () => {
    expect(services.filter((s) => s.category === "SOCIAL").length).toBeGreaterThanOrEqual(6);
    expect(services.filter((s) => s.category === "STREAMING").length).toBeGreaterThanOrEqual(4);
  });

  it("cada serviço tem exatamente um alvo HTTP e um TCP na porta 443, e nada mais", () => {
    for (const s of services) {
      expect(s.targets.map((t) => t.kind).sort(), s.slug).toEqual(["HTTP", "TCP"]);
      const [tcp] = targetsOf(s, "TCP");
      expect(tcp.port, s.slug).toBe(443);
      expect(tcp.url, s.slug).toBeUndefined();
    }
  });

  it("o alvo HTTP é uma URL https e o host do alvo é o host da URL", () => {
    for (const s of services) {
      const [http] = targetsOf(s, "HTTP");
      const url = new URL(http.url!);
      expect(url.protocol, s.slug).toBe("https:");
      expect(http.host, s.slug).toBe(url.hostname);
      // Sem usuário, senha ou porta fora do padrão: o endereço aparece por extenso no detalhe.
      expect(url.username + url.password + url.port, s.slug).toBe("");
    }
  });

  it("os hosts são nomes (o DNS faz parte do que se mede), nunca IP nem host automático", () => {
    for (const s of services) {
      for (const t of s.targets) {
        expect(isIPv4(t.host), `${s.slug}/${t.key}`).toBe(false);
        expect(t.host.startsWith("auto:"), `${s.slug}/${t.key}`).toBe(false);
        expect(t.host, `${s.slug}/${t.key}`).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
      }
    }
  });

  it("não mede site agregador de relatos de queda nem a API do GitHub limitada por hora", () => {
    const banned = /downdetector|isitdownrightnow|downforeveryone|istheservicedown|outage\.report|detector404|api\.github\.com/i;
    for (const s of STATUS_CATALOG) {
      for (const t of s.targets) expect(`${t.host} ${t.url ?? ""}`, `${s.slug}/${t.key}`).not.toMatch(banned);
    }
  });

  it("nenhum alvo mede mais rápido que o intervalo padrão do tipo", () => {
    for (const s of STATUS_CATALOG) {
      for (const t of s.targets) expect(t.intervalSec ?? DEFAULT_INTERVAL_SEC[t.kind], `${s.slug}/${t.key}`).toBeGreaterThanOrEqual(DEFAULT_INTERVAL_SEC[t.kind]);
    }
  });
});

describe("catálogo: conexão do próprio servidor (categoria INTERNET)", () => {
  it("só tem alvos de ping e de DNS", () => {
    expect(internet.length).toBeGreaterThanOrEqual(4);
    for (const s of internet) {
      for (const t of s.targets) expect(["ICMP", "DNS"], `${s.slug}/${t.key}`).toContain(t.kind);
    }
  });

  it("os hosts automáticos (gateway e DNS do sistema) aparecem só em rede-local", () => {
    const auto = STATUS_CATALOG.flatMap((s) => s.targets.filter((t) => t.host.startsWith("auto:")).map((t) => `${s.slug}/${t.key}:${t.host}`));
    expect(auto.sort()).toEqual([`rede-local/dns:${AUTO_SYSTEM_DNS}`, `rede-local/gateway:${AUTO_GATEWAY}`]);
    const local = internet.find((s) => s.slug === "rede-local")!;
    expect(local.targets.find((t) => t.key === "gateway")).toMatchObject({ kind: "ICMP", host: AUTO_GATEWAY });
    expect(local.targets.find((t) => t.key === "dns")).toMatchObject({ kind: "DNS", host: AUTO_SYSTEM_DNS });
  });

  it("fora de rede-local, todo host é um IPv4 literal: a medição não pode depender do DNS que ela vigia", () => {
    for (const s of internet.filter((x) => x.slug !== "rede-local")) {
      for (const t of s.targets) expect(isIPv4(t.host), `${s.slug}/${t.key}`).toBe(true);
    }
  });

  it("todo alvo de DNS consulta um nome, e o nome não é um IP", () => {
    for (const s of STATUS_CATALOG) {
      for (const t of targetsOf(s, "DNS")) {
        expect(t.url, `${s.slug}/${t.key}`).toBe(DEFAULT_DNS_NAME);
        expect(isIPv4(t.url!), `${s.slug}/${t.key}`).toBe(false);
      }
    }
  });

  it("tem pelo menos 3 resolvedores públicos distintos, cada um com ping e DNS (a detecção de queda local precisa de duas testemunhas)", () => {
    const resolvers = internet.filter((s) => {
      const ping = targetsOf(s, "ICMP").filter((t) => isIPv4(t.host));
      const dns = targetsOf(s, "DNS").filter((t) => isIPv4(t.host));
      return ping.length === 1 && dns.length === 1 && ping[0].host === dns[0].host;
    });
    expect(resolvers.length).toBeGreaterThanOrEqual(3);
    expect(new Set(resolvers.map((s) => s.targets[0].host)).size).toBe(resolvers.length);
  });
});
