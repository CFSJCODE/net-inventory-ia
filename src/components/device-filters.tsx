"use client";

import { SearchIcon } from "@/components/ui/search";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUiStore } from "@/store/ui-store";
import { DEVICE_TYPE_LABELS } from "@/components/device-type-icon";
import type { DeviceType } from "@prisma/client";

const DEVICE_TYPES = Object.keys(DEVICE_TYPE_LABELS) as DeviceType[];

const STATUS_ITEMS = { ALL: "Todos", ONLINE: "Online", OFFLINE: "Offline" };
const TYPE_ITEMS = { ALL: "Todos", ...DEVICE_TYPE_LABELS };

export function DeviceFilters() {
  const { search, statusFilter, typeFilter, setSearch, setStatusFilter, setTypeFilter } = useUiStore();

  return (
    <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <SearchIcon size={16} className="absolute left-3.5 top-2 text-muted-foreground" />
        <Input
          placeholder="Buscar por nome, IP, IPv6 ou MAC..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>
      <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)} items={STATUS_ITEMS}>
        <SelectTrigger className="w-full sm:w-40">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Todos</SelectItem>
          <SelectItem value="ONLINE">Online</SelectItem>
          <SelectItem value="OFFLINE">Offline</SelectItem>
        </SelectContent>
      </Select>
      <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)} items={TYPE_ITEMS}>
        <SelectTrigger className="w-full sm:w-44">
          <SelectValue placeholder="Tipo" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Todos</SelectItem>
          {DEVICE_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {DEVICE_TYPE_LABELS[type]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
