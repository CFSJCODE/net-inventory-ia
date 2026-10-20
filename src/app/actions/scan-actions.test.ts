import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), scan: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUser: mocks.user, requirePermission: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/scan-service", () => ({
  runConfiguredScan: mocks.scan,
  ScanInProgressError: class extends Error {
    constructor() { super("Já existe um scan em andamento. Aguarde ele terminar."); }
  },
}));

import { ScanInProgressError } from "@/lib/scan-service";
import { triggerScan } from "./scan-actions";

describe("triggerScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "test", role: "ADMIN" });
  });

  it("devolve contagens quando o scan termina", async () => {
    mocks.scan.mockResolvedValue({ devicesFound: 12, newDevices: 1 });
    expect(await triggerScan()).toEqual({ ok: true, data: { devicesFound: 12, newDevices: 1 } });
    expect(mocks.revalidate).toHaveBeenCalledWith("/");
  });

  it("devolve o aviso de concorrência como dado, sem erro de renderização", async () => {
    mocks.scan.mockRejectedValue(new ScanInProgressError());
    expect(await triggerScan()).toEqual({ ok: false, code: "SCAN_IN_PROGRESS", error: "Já existe um scan em andamento. Aguarde ele terminar." });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("não inicia scan para uma sessão expirada", async () => {
    mocks.user.mockResolvedValue(null);
    expect(await triggerScan()).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(mocks.scan).not.toHaveBeenCalled();
  });

  it("não inicia scan para um perfil sem permissão", async () => {
    mocks.user.mockResolvedValue({ id: "test", role: "VIEWER" });
    expect(await triggerScan()).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(mocks.scan).not.toHaveBeenCalled();
  });

  it("não expõe detalhes internos de uma falha inesperada", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.scan.mockRejectedValue(new Error("internal-database-path"));
    const result = await triggerScan();
    expect(result).toMatchObject({ ok: false, code: "SCAN_FAILED" });
    expect(JSON.stringify(result)).not.toContain("internal-database-path");
    log.mockRestore();
  });
});
