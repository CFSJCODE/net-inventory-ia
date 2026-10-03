import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Segredo só para os testes de sessão (o real fica no .env, nunca no repositório).
    env: { AUTH_SECRET: "segredo-de-teste-com-mais-de-trinta-e-dois-caracteres" },
  },
});
