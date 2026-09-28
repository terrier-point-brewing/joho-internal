"use client";

import { useState } from "react";
import { fetchJson } from "../hooks/queries";
import { DepositInvoiceModal, type DepositInvoiceAllocationLike, type MarkPaidData } from "./DepositInvoiceModal";
import type { DepositCalculation } from "@/lib/square/square-invoices";

type DepositInvoiceTarget = DepositInvoiceAllocationLike & { id: string };

/**
 * The deposit invoice actions for a contract allocation — preview, generate,
 * mark paid, send, view in Square, delete — and the modal they open. Shared
 * by Intake → Commitments and Batch Log so both raise invoices through the
 * same calls with the same confirmations. The route itself refuses a paid or
 * back-charged deposit, so neither screen can double-bill a partner.
 */
export function useDepositInvoiceActions(onChanged: () => unknown) {
  const [invoiceModalAlloc, setInvoiceModalAlloc] = useState<DepositInvoiceTarget | null>(null);
  const [invoicePreview, setInvoicePreview] = useState<{ calculation: DepositCalculation } | null>(null);
  const [invoicePreviewLoading, setInvoicePreviewLoading] = useState(false);
  const [invoiceActionLoading, setInvoiceActionLoading] = useState<string | null>(null);

  async function openInvoicePreview(a: DepositInvoiceTarget) {
    setInvoiceModalAlloc(a);
    setInvoicePreview(null);
    setInvoicePreviewLoading(true);
    try {
      const data = await fetchJson<{ calculation: DepositCalculation }>(`/api/production/allocations/${a.id}/invoice`);
      setInvoicePreview(data);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to load invoice preview");
      setInvoiceModalAlloc(null);
    } finally {
      setInvoicePreviewLoading(false);
    }
  }

  async function handleGenerateInvoice(allocId: string) {
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setInvoiceModalAlloc(null);
      await onChanged();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to generate invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleMarkPaid(allocId: string, data: MarkPaidData) {
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "mark_paid", ...data }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setInvoiceModalAlloc(null);
      await onChanged();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to mark as paid");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleSendInvoice(allocId: string) {
    if (!confirm("Send this invoice to the partner via email?")) return;
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await onChanged();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to send invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleViewInSquare(allocId: string) {
    setInvoiceActionLoading(allocId);
    try {
      const data = await fetchJson<{ invoiceUrl: string | null }>(`/api/production/allocations/${allocId}/invoice`);
      if (data.invoiceUrl) {
        window.open(data.invoiceUrl, "_blank", "noopener,noreferrer");
      } else {
        alert("No public URL available for this invoice yet.");
      }
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to fetch invoice URL");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleDeleteInvoice(allocId: string, sent: boolean) {
    const msg = sent
      ? "Cancel and delete this sent invoice? The partner may receive a cancellation notice. A new invoice can then be generated."
      : "Delete this draft invoice? A new one can be generated.";
    if (!confirm(msg)) return;
    setInvoiceActionLoading(allocId);
    try {
      const res = await fetch(`/api/production/allocations/${allocId}/invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await onChanged();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to delete invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  const modal = invoiceModalAlloc && (
    <DepositInvoiceModal
      allocation={invoiceModalAlloc}
      preview={invoicePreview}
      loading={invoicePreviewLoading}
      generating={invoiceActionLoading === invoiceModalAlloc.id}
      onGenerate={() => handleGenerateInvoice(invoiceModalAlloc.id)}
      onMarkPaid={(data) => handleMarkPaid(invoiceModalAlloc.id, data)}
      markingPaid={invoiceActionLoading === invoiceModalAlloc.id}
      onClose={() => setInvoiceModalAlloc(null)}
    />
  );

  return {
    actionLoading: invoiceActionLoading,
    openPreview: openInvoicePreview,
    send: handleSendInvoice,
    viewInSquare: handleViewInSquare,
    remove: handleDeleteInvoice,
    modal,
  };
}
