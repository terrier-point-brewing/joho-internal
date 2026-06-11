"use client";

import { useState } from "react";

export default function AccountSettings() {
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setSaving(true);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword }),
    });
    const data = await res.json();
    setSaving(false);

    if (!res.ok) {
      setError(data.error ?? "Failed to update password");
    } else {
      setSuccess(true);
      setNewPassword("");
      setConfirm("");
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-md">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">Change Password</h2>
      <p className="text-sm text-zinc-500 mb-6">Set a new password for your account.</p>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/30 border border-red-900/50 rounded px-3 py-2 mb-4">
          {error}
        </p>
      )}
      {success && (
        <p className="text-sm text-green-400 bg-green-950/30 border border-green-900/50 rounded px-3 py-2 mb-4">
          Password updated successfully.
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-400">New password</label>
          <input
            type="password"
            required
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-400">Confirm new password</label>
          <input
            type="password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
          />
        </div>
        <div>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:bg-amber-500/50 text-zinc-950 text-sm font-semibold rounded transition-colors"
          >
            {saving ? "Saving…" : "Update password"}
          </button>
        </div>
      </form>
    </div>
  );
}
