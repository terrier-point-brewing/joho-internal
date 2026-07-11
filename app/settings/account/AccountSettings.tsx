"use client";

import { useState } from "react";
import PageHeader from "@/app/components/PageHeader";
import Banner from "@/app/components/ui/Banner";

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
      <PageHeader title="Change Password" description="Set a new password for your account." />

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
    </div>
  );
}
