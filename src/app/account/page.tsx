import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/server";
import { ROLE_INFO } from "@/lib/auth/permissions";
import { ChangePasswordCard } from "@/components/account/change-password-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-3 py-8">
      <p className="text-sm text-muted-foreground">Seus dados de acesso ao NetInventory.</p>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{user.username}</CardTitle>
          <CardDescription>
            Perfil: <strong className="text-foreground">{ROLE_INFO[user.role].label}</strong> — {ROLE_INFO[user.role].description}
          </CardDescription>
        </CardHeader>
        {user.role !== "ADMIN" && (
          <CardContent className="text-sm text-muted-foreground">Para mudar o seu perfil de acesso, fale com um administrador.</CardContent>
        )}
      </Card>
      <ChangePasswordCard />
    </div>
  );
}
