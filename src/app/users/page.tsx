import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/server";
import { can } from "@/lib/auth/permissions";
import { NoPermission } from "@/components/no-permission";
import { UsersManager } from "@/components/users/users-manager";

export default async function UsersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-3 py-8">
      <p className="text-sm text-muted-foreground">Quem acessa o NetInventory e o que cada pessoa pode fazer.</p>
      {can(user.role, "users.manage") ? <UsersManager /> : <NoPermission role={user.role} what="gerenciar usuários" />}
    </div>
  );
}
