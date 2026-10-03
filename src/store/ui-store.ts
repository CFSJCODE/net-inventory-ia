import { create } from "zustand";
import type { DeviceStatus, DeviceType } from "@prisma/client";

type StatusFilter = DeviceStatus | "ALL";
type TypeFilter = DeviceType | "ALL";
export type DeviceSortKey = "hostname" | "ip" | "type" | "vendor" | "status" | "lastSeenAt";
export type SortDirection = "asc" | "desc";

export const DEVICES_PAGE_SIZE = 10;

interface UiState {
  search: string;
  statusFilter: StatusFilter;
  typeFilter: TypeFilter;
  sortKey: DeviceSortKey;
  sortDirection: SortDirection;
  page: number;
  /** Oculta dispositivos offline com MAC aleatório (celulares que já trocaram de MAC). */
  hideEphemeral: boolean;
  setSearch: (value: string) => void;
  setStatusFilter: (value: StatusFilter) => void;
  setTypeFilter: (value: TypeFilter) => void;
  toggleSort: (key: DeviceSortKey) => void;
  setPage: (page: number) => void;
  setHideEphemeral: (value: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  search: "",
  statusFilter: "ALL",
  typeFilter: "ALL",
  sortKey: "lastSeenAt",
  sortDirection: "desc",
  page: 1,
  hideEphemeral: true,
  setSearch: (search) => set({ search, page: 1 }),
  setStatusFilter: (statusFilter) => set({ statusFilter, page: 1 }),
  setTypeFilter: (typeFilter) => set({ typeFilter, page: 1 }),
  toggleSort: (key) =>
    set((state) => ({
      sortKey: key,
      sortDirection: state.sortKey === key && state.sortDirection === "asc" ? "desc" : "asc",
      page: 1,
    })),
  setPage: (page) => set({ page }),
  setHideEphemeral: (hideEphemeral) => set({ hideEphemeral, page: 1 }),
}));
