import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type AiStatus, type CreatorUser } from "../api";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

interface UserProfileModalProps {
  user: CreatorUser;
  aiStatus?: AiStatus | null;
  onClose: () => void;
  onUserUpdated: (user: CreatorUser) => void;
  onSwitchAccount: () => void;
  onLogout: () => void;
  onOpenSettings?: () => void;
  onOpenAdminAccounts?: () => void;
  onToast: (message: string, kind?: "success" | "error" | "info") => void;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function formatDate(iso?: string | number | null): string {
  if (!iso) return "Reciente";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Reciente";
  return parsed.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

export function UserProfileModal({
  user,
  aiStatus,
  onClose,
  onUserUpdated,
  onSwitchAccount,
  onLogout,
  onOpenSettings,
  onOpenAdminAccounts,
  onToast,
}: UserProfileModalProps) {
  const [displayName, setDisplayName] = useState(user.displayName || user.name || user.handle);
  const [handle, setHandle] = useState(user.handle);
  const [email, setEmail] = useState(user.email ?? "");
  const [savingProfile, setSavingProfile] = useState(false);

  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(user.displayName || user.name || user.handle);
    setHandle(user.handle);
    setEmail(user.email ?? "");
  }, [user]);

  const cleanHandle = handle.trim().toLowerCase().replace(/^@+/, "");
  const cleanDisplayName = displayName.trim();
  const cleanEmail = email.trim().toLowerCase();
  const initialEmail = (user.email ?? "").trim().toLowerCase();
  const initialDisplayName = (user.displayName || user.name || user.handle).trim();

  const hasProfileChanges =
    cleanHandle !== user.handle ||
    cleanDisplayName !== initialDisplayName ||
    cleanEmail !== initialEmail;

  const initial = (user.displayName || user.name || user.handle || "C").charAt(0).toUpperCase();

  const handleSaveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (savingProfile || !hasProfileChanges) return;
    setError(null);
    setSavingProfile(true);
    try {
      const res = await api.updateMe({
        handle: cleanHandle !== user.handle ? cleanHandle : undefined,
        displayName: cleanDisplayName || cleanHandle,
        email: cleanEmail !== initialEmail ? (cleanEmail ? cleanEmail : null) : undefined,
      });
      onUserUpdated(res.user);
      onToast("Datos de tu cuenta actualizados.", "success");
    } catch (err) {
      setError(errorMessage(err, "No se pudieron actualizar tus datos."));
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSavePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (savingPassword) return;
    setError(null);
    if (newPassword.length < 4) {
      setError("La nueva contraseña debe tener al menos 4 caracteres.");
      return;
    }
    setSavingPassword(true);
    try {
      const res = await api.updateMe({
        currentPassword: currentPassword || undefined,
        newPassword,
      });
      onUserUpdated(res.user);
      setCurrentPassword("");
      setNewPassword("");
      setShowPasswordSection(false);
      onToast("Contraseña actualizada correctamente.", "success");
    } catch (err) {
      setError(errorMessage(err, "No se pudo cambiar la contraseña."));
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <Modal
      wide
      title="Mi Cuenta"
      kicker="Perfil de Creador"
      subtitle="Consulta y edita tus datos personales, contraseña o cambia a otra cuenta."
      onClose={onClose}
    >
      <div className="space-y-3.5" data-profile-modal>
        {/* Cabecera del usuario */}
        <div className="rounded-2xl border-2 border-[var(--line-strong)] bg-[var(--cream)] p-3.5 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className="w-12 h-12 rounded-2xl border-2 border-[var(--ink)] text-lg font-black text-[#0c150d] grid place-items-center shrink-0 shadow-[var(--shadow-hard-sm)]"
              style={{ backgroundColor: user.avatarColor || "var(--learn-green)" }}
            >
              {initial}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-display text-[15px] font-extrabold text-[var(--ink)] truncate max-w-[220px]">
                  {user.displayName || user.name || user.handle}
                </span>
                <span className="text-[12px] font-bold text-[var(--muted)]">@{user.handle}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide border ${
                    user.role === "admin"
                      ? "bg-[#e7f7ec] text-[#175c31] border-[#9fd4b1]"
                      : "bg-[var(--white)] text-[var(--ink-soft)] border-[var(--line-strong)]"
                  }`}
                >
                  {user.role === "admin" ? "Admin" : "Creador"}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-[var(--muted)]">
                <span>{user.email || "Sin correo vinculado"}</span>
                <span>Desde {formatDate(user.createdAt)}</span>
                <span className="inline-flex items-center gap-1">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      aiStatus?.configured ? "bg-[var(--learn-green)]" : "bg-amber-500"
                    }`}
                  />
                  {aiStatus?.configured
                    ? `IA: ${aiStatus.model}${aiStatus.keyHint ? ` (${aiStatus.keyHint})` : ""}`
                    : "IA sin token"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              type="button"
              className="btn btn-soft btn-sm"
              onClick={onSwitchAccount}
              data-switch-account-btn
            >
              <Icon name="refresh" size={12} />
              <span>Cambiar de usuario</span>
            </button>
            {user.role === "admin" && onOpenAdminAccounts && (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={onOpenAdminAccounts}
              >
                <Icon name="user" size={12} />
                <span>Cuentas</span>
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-[#f2c4bc] bg-[#fef3f2] px-3 py-2 text-[12px] font-semibold text-[#b42318] flex items-center gap-2">
            <Icon name="alert" size={14} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Formulario de datos básicos */}
        <form
          onSubmit={(e) => void handleSaveProfile(e)}
          className="rounded-2xl border border-[var(--line-strong)] bg-[var(--white)] p-3.5 space-y-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-display text-[13px] font-bold text-[var(--ink)] flex items-center gap-1.5">
              <Icon name="user" size={13} />
              Datos de tu perfil
            </span>
            {onOpenSettings && (
              <button
                type="button"
                className="text-[11px] font-bold text-[var(--sage-800)] hover:underline inline-flex items-center gap-1"
                onClick={onOpenSettings}
              >
                <Icon name="key" size={11} />
                Token y ajustes IA
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label className="block space-y-1">
              <span className="text-[11px] font-bold text-[var(--ink-soft)]">Nombre visible</span>
              <input
                type="text"
                maxLength={48}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Tu nombre en el estudio"
                className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] px-3 py-1.5 text-[13px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-bold text-[var(--ink-soft)]">Nombre de usuario (@)</span>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[12.5px] font-bold text-[var(--muted)]">
                  @
                </span>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={32}
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder="mi_usuario"
                  className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] pl-7 pr-3 py-1.5 text-[13px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                />
              </div>
            </label>

            <label className="block space-y-1 sm:col-span-2">
              <span className="text-[11px] font-bold text-[var(--ink-soft)]">Correo electrónico (opcional)</span>
              <input
                type="email"
                maxLength={160}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="creador@correo.com"
                className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--paper)] px-3 py-1.5 text-[13px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
              />
            </label>
          </div>

          {cleanHandle !== user.handle && cleanHandle.length >= 2 && (
            <p className="text-[11px] font-medium text-[var(--sage-800)] bg-[#eef8f1] border border-[#c9e6d3] rounded-lg px-2.5 py-1.5">
              Al cambiar tu usuario a <strong>@{cleanHandle}</strong>, tus proyectos y tu token IA se conservan automáticamente.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!hasProfileChanges || savingProfile}
              data-profile-save-btn
            >
              {savingProfile ? <Icon name="loader" size={12} className="spin" /> : <Icon name="check" size={12} />}
              <span>{savingProfile ? "Guardando..." : "Guardar cambios"}</span>
            </button>
          </div>
        </form>

        {/* Sección colapsable de contraseña */}
        <div className="rounded-2xl border border-[var(--line-strong)] bg-[var(--white)] overflow-hidden">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setShowPasswordSection((prev) => !prev);
            }}
            className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-[var(--paper)] transition-colors"
          >
            <span className="font-display text-[12.5px] font-bold text-[var(--ink)] flex items-center gap-1.5">
              <Icon name="lock" size={13} />
              Seguridad · Cambiar contraseña
            </span>
            <span className="text-[11px] font-bold text-[var(--muted)]">
              {showPasswordSection ? "Ocultar" : "Modificar"}
            </span>
          </button>

          {showPasswordSection && (
            <form
              onSubmit={(e) => void handleSavePassword(e)}
              className="border-t border-[var(--line)] p-3.5 space-y-2.5 bg-[var(--paper)]"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {user.hasPassword !== false && (
                  <label className="block space-y-1">
                    <span className="text-[11px] font-bold text-[var(--ink-soft)]">Contraseña actual</span>
                    <input
                      type={showPasswords ? "text" : "password"}
                      required
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="Tu contraseña actual"
                      className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--white)] px-3 py-1.5 text-[13px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                    />
                  </label>
                )}
                <label className="block space-y-1">
                  <span className="text-[11px] font-bold text-[var(--ink-soft)]">Nueva contraseña</span>
                  <input
                    type={showPasswords ? "text" : "password"}
                    required
                    minLength={4}
                    maxLength={128}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Mínimo 4 caracteres"
                    className="w-full rounded-xl border-2 border-[var(--line-strong)] bg-[var(--white)] px-3 py-1.5 text-[13px] font-medium text-[var(--ink)] outline-none focus:border-[var(--ink)]"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  className="text-[11px] font-bold text-[var(--muted)] hover:text-[var(--ink)]"
                  onClick={() => setShowPasswords((v) => !v)}
                >
                  {showPasswords ? "Ocultar contraseñas" : "Mostrar contraseñas"}
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={savingPassword}
                >
                  {savingPassword ? <Icon name="loader" size={12} className="spin" /> : <Icon name="check" size={12} />}
                  <span>{savingPassword ? "Actualizando..." : "Actualizar contraseña"}</span>
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Pie: cerrar sesión / cerrar modal */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            className="btn btn-soft btn-sm text-[var(--danger)]"
            onClick={onLogout}
            data-profile-logout-btn
          >
            Cerrar sesión
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    </Modal>
  );
}
