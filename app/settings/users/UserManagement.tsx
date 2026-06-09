"use client";

import { useState, useEffect, useCallback } from "react";

type UserRole = "viewer" | "brewer" | "manager" | "admin";

interface Profile {
  id: string;
  email: string;
  role: UserRole;
  created_at: string;
}

const ROLES: UserRole[] = ["viewer", "brewer", "manager", "admin"];

const ROLE_COLORS: Record<UserRole, string> = {
  viewer:  "text-zinc-400 bg-zinc-800",
  brewer:  "text-blue-400 bg-blue-900/30",
  manager: "text-amber-400 bg-amber-900/30",
  admin:   "text-red-400 bg-red-900/30",
};

export default function UserManagement() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Set password modal state
  const [pwUserId, setPwUserId] = useState<string | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

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

  // Create user modal state
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ email: "", password: "", role: "viewer" as UserRole });
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error("Failed to load users");
      setUsers(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  async function handleRoleChange(userId: string, role: UserRole) {
    setUsers((u) => u.map((x) => (x.id === userId ? { ...x, role } : x)));
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) fetchUsers();
  }

  async function handleDeleteUser(userId: string) {
    if (!confirm("Delete this user? This cannot be undone.")) return;
    const res = await fetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    if (res.ok) setUsers((u) => u.filter((x) => x.id !== userId));
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
    fetchUsers();
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h2 className="text-base font-semibold text-zinc-100 mb-6">Users</h2>

      {loading && <p className="text-sm text-zinc-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-400 bg-red-950/30 border border-red-900/50 rounded px-3 py-2 mb-4">
          {error}
        </p>
      )}

      {!loading && (
        <>
          <div className="flex justify-end mb-4">
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-zinc-950 text-sm font-semibold rounded transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              New user
            </button>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wide">
                  <th className="text-left px-4 py-3 font-medium">Email</th>
                  <th className="text-left px-4 py-3 font-medium">Role</th>
                  <th className="text-left px-4 py-3 font-medium">Joined</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-zinc-800/50 last:border-0">
                    <td className="px-4 py-3 text-zinc-200">{u.email}</td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.id, e.target.value as UserRole)}
                        className={`text-xs font-medium rounded px-2 py-1 border-0 outline-none cursor-pointer ${ROLE_COLORS[u.role]} bg-opacity-100`}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r} className="bg-zinc-900 text-zinc-100">
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-zinc-500">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex gap-2 justify-end items-center">
                        <button
                          onClick={() => { setPwUserId(u.id); setPwValue(""); setPwError(null); }}
                          className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
                          title="Set password"
                        >
                          Set pwd
                        </button>
                        <button
                          onClick={() => handleDeleteUser(u.id)}
                          className="text-zinc-600 hover:text-red-400 transition-colors"
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
                    <td colSpan={4} className="px-4 py-6 text-center text-zinc-600 text-sm">
                      No users yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Set password modal */}
      {pwUserId && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 w-full max-w-sm mx-4">
            <h2 className="text-base font-semibold text-zinc-100 mb-1">Set password</h2>
            <p className="text-sm text-zinc-500 mb-4">
              Set a new password for{" "}
              <span className="text-zinc-300">{users.find((u) => u.id === pwUserId)?.email}</span>.
            </p>

            {pwError && (
              <p className="text-sm text-red-400 bg-red-950/30 border border-red-900/50 rounded px-3 py-2 mb-4">
                {pwError}
              </p>
            )}

            <form onSubmit={handleSetPassword} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-400">New password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={pwValue}
                  onChange={(e) => setPwValue(e.target.value)}
                  autoFocus
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
                />
              </div>
              <div className="flex gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => { setPwUserId(null); setPwValue(""); setPwError(null); }}
                  className="flex-1 py-2 rounded border border-zinc-700 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pwSaving}
                  className="flex-1 py-2 rounded bg-amber-500 hover:bg-amber-400 disabled:bg-amber-500/50 text-zinc-950 text-sm font-semibold transition-colors"
                >
                  {pwSaving ? "Saving…" : "Set password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create user modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 w-full max-w-sm mx-4">
            <h2 className="text-base font-semibold text-zinc-100 mb-4">Create user</h2>

            {createError && (
              <p className="text-sm text-red-400 bg-red-950/30 border border-red-900/50 rounded px-3 py-2 mb-4">
                {createError}
              </p>
            )}

            <form onSubmit={handleCreateUser} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-400">Email</label>
                <input
                  type="email"
                  required
                  value={createForm.email}
                  onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-400">Password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={createForm.password}
                  onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-400">Role</label>
                <select
                  value={createForm.role}
                  onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => { setShowCreate(false); setCreateError(null); }}
                  className="flex-1 py-2 rounded border border-zinc-700 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 py-2 rounded bg-amber-500 hover:bg-amber-400 disabled:bg-amber-500/50 text-zinc-950 text-sm font-semibold transition-colors"
                >
                  {creating ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
