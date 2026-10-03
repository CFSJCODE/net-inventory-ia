import { describe, expect, it } from "vitest";
import { can, ROLES, type Permission } from "./permissions";
import { sessionMatchesUser, type Session } from "./session";

const ALL: Permission[] = ["users.manage", "settings.manage", "network.operate", "inventory.edit", "ai.use"];

describe("perfis de acesso", () => {
  it("administrador pode tudo", () => {
    for (const p of ALL) expect(can("ADMIN", p)).toBe(true);
  });

  it("operador opera a rede, edita e usa IA, mas não mexe em usuários nem configurações", () => {
    expect(can("OPERATOR", "network.operate")).toBe(true);
    expect(can("OPERATOR", "inventory.edit")).toBe(true);
    expect(can("OPERATOR", "ai.use")).toBe(true);
    expect(can("OPERATOR", "users.manage")).toBe(false);
    expect(can("OPERATOR", "settings.manage")).toBe(false);
  });

  it("visualizador não tem nenhuma permissão de ação", () => {
    for (const p of ALL) expect(can("VIEWER", p)).toBe(false);
  });

  it("sem usuário, nada é permitido", () => {
    for (const p of ALL) expect(can(null, p)).toBe(false);
  });

  it("todo perfil existente está mapeado", () => {
    expect(ROLES).toEqual(["ADMIN", "OPERATOR", "VIEWER"]);
  });
});

describe("validade da sessão contra o usuário no banco", () => {
  const session: Session = { userId: "u1", username: "ana", sv: 2, exp: 9_999_999_999 };

  it("vale para usuário ativo com a mesma versão de sessão", () => {
    expect(sessionMatchesUser(session, { active: true, sessionVersion: 2 })).toBe(true);
  });

  it("cai quando o usuário foi removido, desativado ou trocou a senha", () => {
    expect(sessionMatchesUser(session, null)).toBe(false);
    expect(sessionMatchesUser(session, { active: false, sessionVersion: 2 })).toBe(false);
    expect(sessionMatchesUser(session, { active: true, sessionVersion: 3 })).toBe(false);
  });

  it("cookies emitidos antes desta versão (sem sv) valem como versão 0", () => {
    const legacy: Session = { userId: "u1", username: "admin", exp: 9_999_999_999 };
    expect(sessionMatchesUser(legacy, { active: true, sessionVersion: 0 })).toBe(true);
    expect(sessionMatchesUser(legacy, { active: true, sessionVersion: 1 })).toBe(false);
  });
});
