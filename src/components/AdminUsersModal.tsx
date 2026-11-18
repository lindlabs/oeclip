import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type AdminUserRecord, type CreatorUser } from "../api";
import { Icon } from "./Icon";
import { ConfirmDialog, Modal } from "./Modal";

interface AdminUsersModalProps {
  currentUser: CreatorUser | null;
  onClose: () => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function formatShortDate(iso?: string | number | null): string {
  if (!iso) return "Sin actividad";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Sin actividad";
  return parsed.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

export function AdminUsersModal({ currentUser, onClose, onToast }: AdminUsersModalProps) {
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newHandle, setNewHandle] = useState("");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");
  const [creating, setCreating] = useState(false);

  const [resetTargetId, setResetTargetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AdminUserRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.adminListUsers();
      setUsers(res.users);
    } catch (error) {
      onToast(errorMessage(error, "No se pudieron cargar las cuentas."), "error");
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      [u.handle, u.displayName, u.email ?? "", u.role].join(" ").toLowerCase().includes(q),
    );
  }, [query, users]);

  const stats = useMemo(
    () => ({
      total: users.length,
      admins: users.filter((u) => u.role === "admin").length,
      suspended: users.filter((u) => u.disabled).length,
      withAi: users.filter((u) => u.hasAiKey).length,
    }),
    [users],
  );

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    try {
      const res = await api.adminCreateUser({
        handle: newHandle.trim(),
        displayName: newName.trim() || undefined,
        email: newEmail.trim() || undefined,
        password: newPassword,
        role: newRole,
      });
      setUsers((prev) => [...prev, res.user]);
      setShowCreate(false);
      setNewHandle("");
      setNewName("");
      setNewEmail("");
      setNewPassword("");
      setNewRole("user");
      onToast(`Cuenta @${res.user.handle} creada correctamente.`, "success");
    } catch (error) {
      onToast(errorMessage(error, "No se pudo crear la cuenta."), "error");
    } finally {
      setCreating(false);
    }
  };

  const applyPatch = async (
    target: AdminUserRecord,
    patch: Parameters<typeof api.adminUpdateUser>[1],
    successMsg: string,
  ) => {
    setBusyId(target.id);
    try {
      const res = await api.adminUpdateUser(target.id, patch);
      setUsers((prev) => prev.map((item) => (item.id === target.id ? res.user : item)));
      onToast(successMsg, "success");
      return true;
    } catch (error) {
      onToast(errorMessage(error, "No se pudo actualizar la cuenta."), "error");
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const submitResetPassword = async (target: AdminUserRecord) => {
    if (resetPassword.length < 4) {
      onToast("La nueva contraseña debe tener al menos 4 caracteres.", "error");
      return;
    }
    const ok = await applyPatch(
      target,
      { password: resetPassword },
      `Contraseña de @${target.handle} actualizada.`,
    );
    if (ok) {
      setResetTargetId(null);
      setResetPassword("");
    }
  };

  const confirmDelete = async (target: AdminUserRecord) => {
    setBusyId(target.id);
    try {
      await api.adminDeleteUser(target.id);
      setUsers((prev) => prev.filter((u) => u.id !== target.id));
      onToast(`Cuenta @${target.handle} eliminada.`, "success");
    } catch (error) {
      onToast(errorMessage(error, "No se pudo eliminar la cuenta."), "error");
    } finally {
      setBusyId(null);
    }
  };

  if (!currentUser || currentUser.role !== "admin") return null;

  return (
    <>
      <Modal
        wide
        title="Gestión de Cuentas"
        kicker="Solo Administrador"
        subtitle="Administra roles, accesos, contraseñas y estado de las cuentas registradas en OECLIP."
        onClose={onClose}
      >
        <div className="space-y-3">
          {/* Resumen KPI compacto */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-xl border border-[var(--line-strong)] bg-[var(--white)] px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">Cuentas</div>
              <div className="font-display text-lg font-extrabold text-[var(--ink)]">{stats.total}</div>
            </div>
            <div className="rounded-xl border border-[var(--line-strong)] bg-[var(--white)] px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">Admins</div>
              <div className="font-display text-lg font-extrabold text-[var(--sage-800)]">{stats.admins}</div>
            </div>
            <div className="rounded-xl border border-[var(--line-strong)] bg-[var(--white)] px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">Con Token IA</div>
              <div className="font-display text-lg font-extrabold text-[var(--ink)]">{stats.withAi}</div>
            </div>
            <div className="rounded-xl border border-[var(--line-strong)] bg-[var(--white)] px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">Suspendidas</div>
              <div className="font-display text-lg font-extrabold text-[var(--danger)]">{stats.suspended}</div>
            </div>
          </div>

          {/* Buscador + Nueva cuenta + Recargar */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Icon
                name="search"
                size={13}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
              />
              <input
                className="w-full rounded-full border-2 border-[var(--line-strong)] bg-[var(--white)] py-1.5 pl-8 pr-3 text-[13px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                placeholder="Buscar por usuario, nombre o correo..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Buscar cuentas"
              />
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                className="btn btn-primary btn-sm flex-1 sm:flex-initial justify-center"
                onClick={() => setShowCreate((v) => !v)}
              >
                <Icon name="plus" size={12} />
                <span>{showCreate ? "Cerrar formulario" : "Nueva cuenta"}</span>
              </button>
              <button
                type="button"
                className="btn btn-soft btn-sm"
                onClick={() => void load()}
                disabled={loading}
                title="Actualizar lista"
                aria-label="Actualizar lista de cuentas"
              >
                <Icon name="refresh" size={12} className={loading ? "spin" : undefined} />
              </button>
            </div>
          </div>

          {/* Formulario crear cuenta */}
          {showCreate && (
            <form
              onSubmit={(e) => void handleCreate(e)}
              className="rounded-2xl border-2 border-[var(--ink)] bg-[var(--cream)] p-3.5 space-y-2.5 shadow-[var(--shadow-hard-sm)]"
            >
              <div className="flex items-center justify-between">
                <span className="font-display text-[13px] font-bold text-[var(--ink)]">
                  Crear nueva cuenta
                </span>
                <span className="text-[10.5px] font-semibold text-[var(--muted)]">Acceso inmediato</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                <input
                  required
                  minLength={2}
                  maxLength={32}
                  placeholder="Usuario (ej. maria_clips)"
                  value={newHandle}
                  onChange={(e) => setNewHandle(e.target.value)}
                  className="rounded-xl border-2 border-[var(--line-strong)] bg-[var(--white)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                />
                <input
                  maxLength={48}
                  placeholder="Nombre visible (opcional)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="rounded-xl border-2 border-[var(--line-strong)] bg-[var(--white)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                />
                <input
                  type="email"
                  maxLength={160}
                  placeholder="Correo electrónico (opcional)"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="rounded-xl border-2 border-[var(--line-strong)] bg-[var(--white)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                />
                <input
                  required
                  minLength={4}
                  maxLength={128}
                  type="password"
                  placeholder="Contraseña (mín. 4)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="rounded-xl border-2 border-[var(--line-strong)] bg-[var(--white)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                />
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value === "admin" ? "admin" : "user")}
                  className="rounded-xl border-2 border-[var(--line-strong)] bg-[var(--white)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                  aria-label="Rol de cuenta"
                >
                  <option value="user">Rol: Creador (Estándar)</option>
                  <option value="admin">Rol: Administrador</option>
                </select>
                <button
                  type="submit"
                  disabled={creating}
                  className="btn btn-primary btn-sm justify-center"
                >
                  {creating ? <Icon name="loader" size={12} className="spin" /> : <Icon name="check" size={12} />}
                  <span>{creating ? "Creando..." : "Crear cuenta"}</span>
                </button>
              </div>
            </form>
          )}

          {/* Lista de cuentas */}
          {loading && users.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] font-semibold text-[var(--muted-strong)]">
              <Icon name="loader" size={15} className="spin" />
              Cargando cuentas...
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-[var(--line-strong)] bg-[var(--white)] p-6 text-center text-[12.5px] font-semibold text-[var(--muted-strong)]">
              No se encontraron cuentas con ese criterio.
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((account) => {
                const isSelf =
                  account.id === currentUser.id ||
                  account.handle.toLowerCase() === currentUser.handle.toLowerCase();
                const isBusy = busyId === account.id;
                const resetting = resetTargetId === account.id;

                return (
                  <div
                    key={account.id}
                    data-admin-user-row={account.handle}
                    className={`rounded-2xl border-[1.5px] p-3 transition-all ${
                      account.disabled
                        ? "border-[var(--danger)]/40 bg-[var(--danger-soft)]/35"
                        : "border-[var(--line-strong)] bg-[var(--white)]"
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border-[1.5px] border-[var(--ink)] text-xs font-black text-[#0c150d]"
                          style={{ backgroundColor: account.avatarColor || "var(--learn-green)" }}
                        >
                          {(account.displayName || account.handle).charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-display text-[13px] font-bold text-[var(--ink)] truncate">
                              @{account.handle}
                            </span>
                            {isSelf && (
                              <span className="rounded-full border border-[var(--ink)] bg-[var(--sage-150)] px-2 py-0.5 text-[9px] font-extrabold uppercase text-[var(--sage-900)]">
                                Tu sesión
                              </span>
                            )}
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[9px] font-extrabold uppercase ${
                                account.role === "admin"
                                  ? "border-[var(--ink)] bg-[var(--ink)] text-learn-green"
                                  : "border-[var(--line-strong)] bg-[var(--paper)] text-[var(--ink-soft)]"
                              }`}
                            >
                              {account.role === "admin" ? "Admin" : "Usuario"}
                            </span>
                            {account.disabled && (
                              <span className="rounded-full border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-2 py-0.5 text-[9px] font-extrabold uppercase text-[var(--danger)]">
                                Suspendida
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] font-medium text-[var(--muted-strong)]">
                            <span className="truncate">{account.displayName}</span>
                            {account.email && <span className="truncate">{account.email}</span>}
                            <span>{account.projectCount} proyectos</span>
                            <span>{account.hasAiKey ? "IA conectada" : "Sin API Key"}</span>
                            <span>Último acceso: {formatShortDate(account.lastSeenAt)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Acciones de cuenta */}
                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        {!isSelf && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              void applyPatch(
                                account,
                                { role: account.role === "admin" ? "user" : "admin" },
                                account.role === "admin"
                                  ? `@${account.handle} pasó a usuario estándar.`
                                  : `@${account.handle} ahora es administrador.`,
                              )
                            }
                            className="btn btn-soft btn-sm !text-[10.5px]"
                          >
                            {account.role === "admin" ? "Quitar Admin" : "Hacer Admin"}
                          </button>
                        )}

                        {!isSelf && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              void applyPatch(
                                account,
                                { disabled: !account.disabled },
                                account.disabled
                                  ? `Cuenta @${account.handle} reactivada.`
                                  : `Cuenta @${account.handle} suspendida.`,
                              )
                            }
                            className={`btn btn-sm !text-[10.5px] ${
                              account.disabled ? "btn-primary" : "btn-soft"
                            }`}
                          >
                            <Icon name={account.disabled ? "unlock" : "lock"} size={11} />
                            <span>{account.disabled ? "Reactivar" : "Suspender"}</span>
                          </button>
                        )}

                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            setResetTargetId(resetting ? null : account.id);
                            setResetPassword("");
                          }}
                          className="btn btn-soft btn-sm !text-[10.5px]"
                        >
                          <Icon name="key" size={11} />
                          <span>Clave</span>
                        </button>

                        {!isSelf && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => setDeleteTarget(account)}
                            className="btn btn-soft btn-sm !text-[10.5px] hover:!text-[var(--danger)]"
                            title={`Eliminar @${account.handle}`}
                            aria-label={`Eliminar @${account.handle}`}
                          >
                            <Icon name="trash" size={11} />
                          </button>
                        )}
                      </div>
                    </div>

                    {resetting && (
                      <div className="mt-2.5 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 border-t border-[var(--line)] pt-2.5">
                        <input
                          type="password"
                          minLength={4}
                          maxLength={128}
                          placeholder={`Nueva contraseña para @${account.handle} (mín. 4 caracteres)`}
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          className="flex-1 rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] px-3 py-1.5 text-[12px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                        />
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void submitResetPassword(account)}
                            className="btn btn-primary btn-sm flex-1 sm:flex-initial justify-center"
                          >
                            Guardar clave
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setResetTargetId(null);
                              setResetPassword("");
                            }}
                            className="btn btn-soft btn-sm"
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      {deleteTarget && (
        <ConfirmDialog
          title="Eliminar cuenta"
          message={`¿Eliminar definitivamente la cuenta @${deleteTarget.handle}? Sus sesiones activas y clave IA se cerrarán de inmediato.`}
          confirmLabel="Eliminar cuenta"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void confirmDelete(target);
          }}
        />
      )}
    </>
  );
}
