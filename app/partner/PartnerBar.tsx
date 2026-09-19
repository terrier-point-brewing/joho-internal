"use client";

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";

/**
 * The whole of a partner's chrome: a slim bar across the top, and nothing
 * else. There is no sidebar — a partner has one page, so navigation would only
 * be a list of doors that do not open. The bar carries the two account actions
 * a partner needs: replace the password an admin handed them, and sign out.
 */
export default function PartnerBar({ email, onSignOut }: { email: string | null; onSignOut: () => void }) {
  const [changing, setChanging] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  function close() { setChanging(false); setPassword(""); setConfirm(""); setError(null); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError("Use at least 8 characters."); return; }
    if (password !== confirm) { setError("The two passwords do not match."); return; }
    setSaving(true);
    const res = await fetch("/api/auth/change-password", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    setSaving(false);
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? "Could not change the password."); return; }
    close();
    setSaved(true);
    setTimeout(() => setSaved(false), 4000);
  }

  return (
    <>
      <div className="fixed top-0 inset-x-0 z-50 bg-surface border-b border-line flex items-center justify-between gap-3 px-4 sm:px-6 h-11">
        <span className="text-sm font-bold text-primary tracking-wide whitespace-nowrap">
          TPB <span className="font-normal text-muted">Partner portal</span>
        </span>
        <div className="flex items-center gap-2 min-w-0">
          {saved && <span className="hidden sm:inline text-xs text-success">Password changed</span>}
          <span className="hidden md:inline text-xs text-muted truncate max-w-[260px]">{email}</span>
          <button onClick={() => setChanging(true)} className="btn-secondary btn-xxs whitespace-nowrap">Change password</button>
          <button onClick={onSignOut} className="btn-secondary btn-xxs whitespace-nowrap">Sign out</button>
        </div>
      </div>

      {changing && (
        <Modal title="Change password" onClose={close}>
          {error && <Banner className="mb-4">{error}</Banner>}
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="New password" required hint="at least 8 characters">
              <input type="password" required minLength={8} autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="inp w-full" />
            </Field>
            <Field label="Repeat it" required>
              <input type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="inp w-full" />
            </Field>
            <ModalActions submitting={saving} onCancel={close} label="Change password" />
          </form>
        </Modal>
      )}
    </>
  );
}
