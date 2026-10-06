import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./settings";

describe("AI Settings Encryption", () => {
  it("criptografa e descriptografa chaves corretamente (round-trip)", () => {
    const rawKey = "AIzaSyD-123456789abcdefghijklmnopqrstuvwxyz";
    const encrypted = encrypt(rawKey);

    expect(encrypted).not.toBe(rawKey);
    expect(encrypted.split(".").length).toBe(3); // iv.authTag.data

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(rawKey);
  });

  it("retorna null ao tentar descriptografar dados corrompidos ou inválidos", () => {
    expect(decrypt("invalido")).toBeNull();
    expect(decrypt("a.b.c")).toBeNull();
  });
});
