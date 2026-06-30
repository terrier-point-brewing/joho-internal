"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import PageHeader from "@/app/components/PageHeader";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";

type UserRole = "viewer" | "brewer" | "manager" | "admin";

interface Profile {
  id: string;
  email: string;
  role: UserRole;
  created_at: string;
  email_confirmed: boolean;
}

const ROLES: UserRole[] = ["viewer", "brewer", "manager", "admin"];

const ROLE_COLORS: Record<UserRole, string> = {
  viewer:  "text-secondary bg-surface-mid",
  brewer:  "text-info bg-info-surface/40",
  manager: "text-accent bg-accent-muted/30",
  admin:   "text-danger bg-danger-surface/40",
};

const QUERY_KEY = ["admin", "users"] as const;

export default function UserManagement() {
  const qc = useQueryClient();

  const { data: users = [], isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<Profile[]>("/api/admin/users"),
  });

  const [apiError, setApiError] = useState<string | null>(null);

  // Set password modal state
  const [pwUserId, setPwUserId] = useState<string | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  // Create user modal state
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ email: "", password: "", role: "viewer" as UserRole });
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    if (pwValue.length < 8) { setPwError("Password must be at least 8 characters"); return; }
    setPwSaving(true);
    const res = await fetch(`/api/admin/users/${pwUserId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwValue }),
    });
    setPwSaving(false);
    if (res.ok) {
      setPwUserId(null);
      setPwValue("");
    } else {
      const data = await res.json().catch(() => ({}));
      setPwError(data.error ?? "Failed to set password");
    }
  }

  async function handleRoleChange(userId: string, role: UserRole) {
    // Optimistic update
    qc.setQueryData<Profile[]>(QUERY_KEY, (prev) =>
      prev?.map((u) => (u.id === userId ? { ...u, role } : u))
    );
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) qc.invalidateQueries({ queryKey: QUERY_KEY });
  }

  async function handleConfirmEmail(userId: string) {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email_confirm: true }),
    });
    if (res.ok) {
      qc.setQueryData<Profile[]>(QUERY_KEY, (prev) =>
        prev?.map((u) => (u.id === userId ? { ...u, email_confirmed: true } : u))
      );
    }
  }

  async function handleDeleteUser(userId: string) {
    if (!confirm("Delete this user? This cannot be undone.")) return;
    const res = await fetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    if (res.ok) {
      qc.setQueryData<Profile[]>(QUERY_KEY, (prev) => prev?.filter((u) => u.id !== userId));
    }
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createForm),
    });
    const data = await res.json();
    if (!res.ok) {
      setCreateError(data.error ?? "Failed to create user");
      setCreating(false);
      return;
    }
    setShowCreate(false);
    setCreateForm({ email: "", password: "", role: "viewer" });
    setCreating(false);
    qc.invalidateQueries({ queryKey: QUERY_KEY });
  }

  const displayError = apiError ?? (error as Error)?.message ?? null;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <PageHeader title="Users" />

      {isLoading && <p className="text-sm text-muted">Loading…</p>}
      {displayError && (
        <Banner tone="danger" className="mb-4">{displayError}</Banner>
      )}

      {!isLoading && (
        <>
          <div className="flex justify-end mb-4 mt-4">
            <button
              onClick={() => setShowCreate(true)}
              className="btn-amber flex items-center gap-1.5"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              New user
            </button>
          </div>

          <Card padding="" className="overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-muted text-xs uppercase tracking-wide">
                  <th className="text-left px-4 py-3 font-medium">Email</th>
                  <th className="text-left px-4 py-3 font-medium">Role</th>
                  <th className="text-left px-4 py-3 font-medium">Confirmed</th>
                  <th className="text-left px-4 py-3 font-medium">Joined</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-line/50 last:border-0">
                    <td className="px-4 py-3 text-strong">{u.email}</td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.id, e.target.value as UserRole)}
                        className={`text-xs font-medium rounded px-2 py-1 border-0 outline-none cursor-pointer ${ROLE_COLORS[u.role]} bg-opacity-100`}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r} className="bg-surface text-primary">
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      {u.email_confirmed ? (
                        <span className="text-xs font-medium text-success bg-success-surface/40 px-2 py-0.5 rounded">
                          Confirmed
                        </span>
                      ) : (
                        <button
                          onClick={() => handleConfirmEmail(u.id)}
                          className="text-xs font-medium text-accent bg-accent-muted/30 hover:bg-accent-muted/50 px-2 py-0.5 rounded transition-colors"
                        >
                          Confirm
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex gap-2 justify-end items-center">
                        <button
                          onClick={() => { setPwUserId(u.id); setPwValue(""); setPwError(null); setApiError(null); }}
                          className="text-xs text-muted hover:text-strong transition-colors"
                          title="Set password"
                        >
                          Set pwd
                        </button>
                        <button
                          onClick={() => handleDeleteUser(u.id)}
                          className="text-faint hover:text-danger transition-colors"
                          title="Delete user"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M2 4h10M5 4V2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V4M11 4l-.7 7.5a1 1 0 0 1-1 .9H4.7a1 1 0 0 1-1-.9L3 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-faint text-sm">
                      No users yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {/* Set password modal */}
      {pwUserId && (
        <Modal title="Set password" onClose={() => { setPwUserId(null); setPwValue(""); setPwError(null); }}>
          <p className="text-sm text-muted mb-4">
            Set a new password for{" "}
            <span className="text-body">{users.find((u) => u.id === pwUserId)?.email}</span>.
          </p>

          {pwError && <Banner tone="danger" className="mb-4">{pwError}</Banner>}

          <form onSubmit={handleSetPassword} className="flex flex-col gap-3">
            <Field label="New password" required>
              <input
                type="password"
                required
                minLength={8}
                value={pwValue}
                onChange={(e) => setPwValue(e.target.value)}
                autoFocus
                className="inp w-full"
              />
            </Field>
            <ModalActions
              submitting={pwSaving}
              onCancel={() => { setPwUserId(null); setPwValue(""); setPwError(null); }}
              label="Set password"
            />
          </form>
        </Modal>
      )}

      {/* Create user modal */}
      {showCreate && (
        <Modal title="Create user" onClose={() => { setShowCreate(false); setCreateError(null); }}>
          {createError && <Banner tone="danger" className="mb-4">{createError}</Banner>}

          <form onSubmit={handleCreateUser} className="flex flex-col gap-3">
            <Field label="Email" required>
              <input
                type="email"
                required
                value={createForm.email}
                onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                className="inp w-full"
              />
            </Field>
            <Field label="Password" required>
              <input
                type="password"
                required
                minLength={8}
                value={createForm.password}
                onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                className="inp w-full"
              />
            </Field>
            <Field label="Role" required>
              <select
                value={createForm.role}
                onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                className="inp w-full"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </Field>
            <ModalActions
              submitting={creating}
              onCancel={() => { setShowCreate(false); setCreateError(null); }}
              label="Create"
            />
          </form>
        </Modal>
      )}
    </div>
  );
}
