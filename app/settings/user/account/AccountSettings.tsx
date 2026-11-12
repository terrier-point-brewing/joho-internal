"use client";

import { useState } from "react";
import SettingsHeader from "@/app/settings/SettingsHeader";
import Banner from "@/app/components/ui/Banner";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useUserRole } from "@/lib/hooks/useUserRole";

export default function AccountSettings() {
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const { user } = useUserRole();

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

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
    <div className="pane px-4 sm:px-6">
      <SettingsHeader title="Account" description="Your password and session." />
      <div className="pb-4 sm:pb-8 max-w-md">
      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}
      {success && (
        <Banner tone="success" className="mb-4">Password updated successfully.</Banner>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-secondary">New password</label>
          <input
            type="password"
            required
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="inp"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-secondary">Confirm new password</label>
          <input
            type="password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="inp"
          />
        </div>
        <div>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? "Saving…" : "Update password"}
          </button>
        </div>
      </form>

      {/* Sign out lives here as well as in the phone top bar: in landscape the
          top bar is hidden (NavBar), so this is the one place left to reach it. */}
      <div className="mt-8 pt-6 border-t border-line">
        <div className="text-xs text-muted mb-2">Signed in as {user?.email ?? "…"}</div>
        <button type="button" onClick={() => setSignOutOpen(true)} className="btn-secondary">Sign out</button>
      </div>
      {signOutOpen && (
        <ConfirmDialog
          title="Sign out?"
          message={`You are signed in as ${user?.email ?? "this account"}.`}
          confirmLabel="Sign out"
          tone="primary"
          onConfirm={handleSignOut}
          onCancel={() => setSignOutOpen(false)}
        />
      )}
      </div>
    </div>
  );
}
