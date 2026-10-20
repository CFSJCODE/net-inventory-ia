import { redirect } from "next/navigation";
import { EmailAlertsCard } from "@/components/email-alerts-card";
import { NoPermission } from "@/components/no-permission";
import { can } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/server";

export default async function AlertsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-3 py-8">
      <p className="text-sm text-muted-foreground">Configure o Resend, os equipamentos vigiados e os limites dos alertas enviados por e-mail.</p>
      {can(user.role, "settings.manage") ? <EmailAlertsCard /> : <NoPermission role={user.role} what="configurar alertas por e-mail" />}
    </div>
  );
}
