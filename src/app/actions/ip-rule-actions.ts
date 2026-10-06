"use server";

import { requirePermission, requireSession } from "@/lib/auth/server";
import {
  applyIpRulesToExistingDevices,
  getIpRules,
  saveIpRules,
  type IpClassificationRule,
} from "@/lib/network/ip-rules";
import type { ToolResult } from "./tool-actions";
import { revalidatePath } from "next/cache";

async function run<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getIpRulesAction(): Promise<ToolResult<IpClassificationRule[]>> {
  return run(async () => {
    await requireSession();
    return getIpRules();
  });
}

export async function saveIpRulesAction(
  rules: IpClassificationRule[],
): Promise<ToolResult<IpClassificationRule[]>> {
  return run(async () => {
    await requirePermission("settings.manage");
    await saveIpRules(rules);
    revalidatePath("/settings");
    revalidatePath("/");
    return rules;
  });
}

export async function applyIpRulesAction(): Promise<ToolResult<{ matchedCount: number; updatedCount: number }>> {
  return run(async () => {
    await requirePermission("settings.manage");
    const result = await applyIpRulesToExistingDevices();
    revalidatePath("/");
    revalidatePath("/settings");
    return result;
  });
}
