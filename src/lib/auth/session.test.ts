import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, verifySessionToken } from "./session";

describe("sessão assinada", () => {
  afterEach(() => vi.useRealTimers());

  it("aceita o token que ela mesma emitiu", async () => {
    const session = await verifySessionToken(await createSessionToken("u1", "admin", 0));
    expect(session).toMatchObject({ userId: "u1", username: "admin" });
  });

  it("recusa payload trocado com a assinatura original", async () => {
    const [, signature] = (await createSessionToken("u1", "admin", 0)).split(".");
    const forged = Buffer.from(JSON.stringify({ userId: "u1", username: "hacker", exp: 9_999_999_999 })).toString("base64url");
    expect(await verifySessionToken(`${forged}.${signature}`)).toBeNull();
  });

  it("recusa token expirado, malformado ou ausente", async () => {
    const token = await createSessionToken("u1", "admin", 0);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 8 * 24 * 3600 * 1000);
    expect(await verifySessionToken(token)).toBeNull();
    expect(await verifySessionToken("lixo")).toBeNull();
    expect(await verifySessionToken(undefined)).toBeNull();
  });
});
