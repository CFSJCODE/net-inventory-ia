import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { devicesQueryOptions } from "./use-devices";

describe("devicesQueryOptions", () => {
  it("uses server-provided inventory without an initial client request", async () => {
    const queryClient = new QueryClient();
    const queryFn = vi.fn(async () => []);

    const result = await queryClient.fetchQuery({
      ...devicesQueryOptions([]),
      queryFn,
    });

    expect(result).toEqual([]);
    expect(queryFn).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("keeps inventory data fresh until the next polling interval", () => {
    const options = devicesQueryOptions();

    expect(options.staleTime).toBe(15_000);
    expect(options.refetchInterval).toBe(15_000);
  });
});
