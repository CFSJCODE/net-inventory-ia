"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { createUser, deleteUser, listUsers, resetUserPassword, updateUser, type UserRow } from "@/app/actions/user-actions";
import type { ToolResult } from "@/app/actions/tool-actions";
import { useCurrentUser } from "@/components/auth/user-provider";
import { Field, SimpleSelect } from "@/components/tools/tool-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, ROLE_INFO, ROLES, type Permission, type UserRole } from "@/lib/auth/permissions";
import { formatRelativeTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";

const ROLE_OPTIONS = Object.fromEntries(ROLES.map((r) => [r, ROLE_INFO[r].label])) as Record<UserRole, string>;

const ROLE_STYLE: Record<UserRole, string> = {
  ADMIN: "border-primary/40 bg-primary/10 text-primary",
  OPERATOR: "border-sky-500/40 bg-sky-500/10 text-sky-400",
  VIEWER: "border-border text-muted-foreground",
};

/** Executa uma action que devolve ToolResult e transforma { ok: false } em erro para o useMutation. */
async function unwrap<T>(promise: Promise<ToolResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function CreateUserCard() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("OPERATOR");

  const create = useMutation({
    mutationFn: () => unwrap(createUser({ username, password, role })),
    onSuccess: (user) => {
      toast.success(`Usuário ${user.username} criado como ${ROLE_INFO[user.role].label}`);
      setUsername("");
      setPassword("");
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserPlus className="h-4 w-4 text-primary" />
          Novo usuário
        </CardTitle>
        <CardDescription>Crie um acesso para cada pessoa da equipe e passe a senha inicial a ela. Cada um pode trocar a própria senha em Minha conta.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="flex flex-col gap-3 lg:flex-row lg:items-end"
        >
          <Field label="Usuário" htmlFor="new-username" className="lg:w-52">
            <Input id="new-username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="joao.silva" autoComplete="off" required />
          </Field>
          <Field label="Senha inicial (mín. 8)" htmlFor="new-password" className="lg:w-52">
            <Input id="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
          </Field>
          <Field label="Perfil de acesso" htmlFor="new-role">
            <SimpleSelect id="new-role" value={role} onChange={setRole} options={ROLE_OPTIONS} />
          </Field>
          <Button type="submit" disabled={create.isPending} className="w-fit">
            {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Criar usuário
          </Button>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">{ROLE_INFO[role].description}</p>
      </CardContent>
    </Card>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const reset = useMutation({
    mutationFn: () => unwrap(resetUserPassword(user!.id, password)),
    onSuccess: () => {
      toast.success(`Senha de ${user!.username} redefinida. As sessões abertas dele foram encerradas.`);
      setPassword("");
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Dialog open={!!user} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Redefinir senha de {user?.username}</DialogTitle>
          <DialogDescription>Defina uma nova senha e passe a ele. Quem estiver logado com este usuário precisará entrar de novo.</DialogDescription>
        </DialogHeader>
        <form
          id="reset-password-form"
          onSubmit={(e) => {
            e.preventDefault();
            reset.mutate();
          }}
        >
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Nova senha (mín. 8 caracteres)" autoComplete="new-password" minLength={8} required aria-label="Nova senha" />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="reset-password-form" disabled={reset.isPending || password.length < 8}>
            {reset.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Redefinir senha
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteUserDialog({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => unwrap(deleteUser(user!.id)),
    onSuccess: () => {
      toast.success(`Usuário ${user!.username} removido`);
      queryClient.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Dialog open={!!user} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remover {user?.username}?</DialogTitle>
          <DialogDescription>O acesso é excluído de vez. Se a pessoa só vai ficar um tempo sem usar, prefira desativar o usuário.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Remover usuário
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UsersTable() {
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: users, isLoading } = useQuery({ queryKey: ["users"], queryFn: () => listUsers() });
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState<UserRow | null>(null);

  const update = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: { role?: UserRole; active?: boolean } }) => unwrap(updateUser(id, changes)),
    onSuccess: (user, { changes }) => {
      if (changes.role) toast.success(`${user.username} agora é ${ROLE_INFO[user.role].label}`);
      else toast.success(user.active ? `${user.username} reativado` : `${user.username} desativado. As sessões abertas dele foram encerradas.`);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Usuários</CardTitle>
        <CardDescription>Mudanças de perfil valem na hora. Desativar bloqueia o login e encerra as sessões abertas, sem apagar o usuário.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Usuário</TableHead>
                  <TableHead>Perfil</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Último acesso</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users?.map((user) => {
                  const isMe = user.id === me?.id;
                  return (
                    <TableRow key={user.id} className={cn(!user.active && "opacity-60")}>
                      <TableCell className="font-medium">
                        {user.username}
                        {isMe && <span className="ml-2 text-xs text-muted-foreground">(você)</span>}
                      </TableCell>
                      <TableCell>
                        <SimpleSelect
                          value={user.role}
                          onChange={(role) => update.mutate({ id: user.id, changes: { role } })}
                          options={ROLE_OPTIONS}
                          className="sm:w-40"
                        />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("font-normal", user.active ? ROLE_STYLE.ADMIN : "text-muted-foreground")}>
                          {user.active ? "Ativo" : "Desativado"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : "Nunca entrou"}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setResetting(user)}>
                            <KeyRound className="h-3.5 w-3.5" />
                            Senha
                          </Button>
                          {!isMe && (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => update.mutate({ id: user.id, changes: { active: !user.active } })} disabled={update.isPending}>
                                {user.active ? "Desativar" : "Reativar"}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setDeleting(user)} aria-label={`Remover ${user.username}`} className="text-destructive hover:text-destructive">
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
      <DeleteUserDialog user={deleting} onClose={() => setDeleting(null)} />
    </Card>
  );
}

function RolesCard() {
  // Lido da mesma tabela que o servidor usa para barrar as ações: não tem como ficar desatualizado.
  const rows: { label: string; permission: Permission | null }[] = [
    { label: "Ver inventário, mapa, ligações e histórico", permission: null },
    { label: "Rodar scan, ferramentas e testar ligações", permission: "network.operate" },
    { label: "Editar dispositivos, ligações e o mapa", permission: "inventory.edit" },
    { label: "Usar os recursos de IA", permission: "ai.use" },
    { label: "Configurações (scan, chave da IA, limpeza)", permission: "settings.manage" },
    { label: "Gerenciar usuários", permission: "users.manage" },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">O que cada perfil pode fazer</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              {ROLES.map((r) => (
                <TableHead key={r} className="text-center">
                  <Badge variant="outline" className={cn("font-normal", ROLE_STYLE[r])}>
                    {ROLE_INFO[r].label}
                  </Badge>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.label}>
                <TableCell className="text-muted-foreground">{row.label}</TableCell>
                {ROLES.map((r) => (
                  <TableCell key={r} className="text-center">
                    {!row.permission || can(r, row.permission) ? <span className="text-primary">✓</span> : <span className="text-muted-foreground/40">—</span>}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function UsersManager() {
  return (
    <div className="flex flex-col gap-6">
      <CreateUserCard />
      <UsersTable />
      <RolesCard />
    </div>
  );
}
