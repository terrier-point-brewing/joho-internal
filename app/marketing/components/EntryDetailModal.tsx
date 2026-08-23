"use client";

/**
 * One entry, and what happened to it on each channel.
 *
 * The deliveries are the substance here. Each one succeeded or failed on its
 * own — that is the whole reason a delivery is a row rather than a column on
 * the entry — so each gets its own line with its status, its error as the
 * plugin wrote it, and the provider-side ids the publish returned.
 *
 * ── About "link out to the post" ────────────────────────────────────────────
 * A published delivery carries `external_ids`, and nothing in the plugin
 * contract turns those ids into a URL: `PublishResult` is a bag of ids, and no
 * plugin declares how its provider addresses a post. So an id that IS a URL is
 * rendered as a link and everything else is rendered as what it is — an
 * identifier a person can paste into the provider's own tooling. Inventing a
 * URL template per channel here would put channel-specific knowledge in the
 * chassis, which is the one thing the registry exists to prevent.
 */
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import { Modal } from "@/app/components/ui/Modal";
import type { EntryDelivery, MarketingEntry } from "@/lib/marketing/entries";
import { useRetryDelivery } from "../hooks/useMarketing";
import {
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUS_TONE,
  ENTRY_STATUS_LABEL,
  ENTRY_STATUS_TONE,
  channelLabel,
} from "./status";

export default function EntryDetailModal({
  entry,
  canPublish,
  onClose,
}: {
  entry: MarketingEntry;
  /** CAP.marketingPublish. Without it there is no Retry button, because pressing it would 403. */
  canPublish: boolean;
  onClose: () => void;
}) {
  const retry = useRetryDelivery();

  return (
    <Modal title={ENTRY_STATUS_LABEL[entry.status]} onClose={onClose} wide>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={ENTRY_STATUS_TONE[entry.status]}>{ENTRY_STATUS_LABEL[entry.status]}</Badge>
          <Badge>{entry.kind}</Badge>
          <span className="text-xs text-muted">
            {new Date(entry.startsAt).toLocaleString()}
            {entry.endsAt ? ` – ${new Date(entry.endsAt).toLocaleString()}` : ""}
          </span>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-strong mb-2">Caption</h3>
          {entry.caption ? (
            <p className="text-sm text-body whitespace-pre-wrap">{entry.caption}</p>
          ) : (
            <p className="text-sm text-muted">No caption — this entry is its media.</p>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold text-strong mb-2">Media</h3>
          {entry.media.length === 0 ? (
            <p className="text-sm text-muted">Nothing attached.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {entry.media.map((item, index) => (
                <figure key={item.id} className="space-y-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a Supabase storage URL is not a configured next/image loader host */}
                  <img
                    src={item.url}
                    alt=""
                    className="h-24 w-24 rounded-lg object-cover border border-line"
                  />
                  <figcaption className="text-2xs text-faint text-center">{index + 1}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold text-strong mb-2">Channels</h3>
          {entry.deliveries.length === 0 ? (
            <p className="text-sm text-muted">
              No channel picked yet. This entry is on the calendar and going nowhere until one is chosen.
            </p>
          ) : (
            <ul className="space-y-2">
              {entry.deliveries.map((delivery) => (
                <DeliveryRow
                  key={delivery.id}
                  delivery={delivery}
                  canPublish={canPublish}
                  retrying={retry.isPending}
                  onRetry={() => retry.mutate(delivery.id)}
                />
              ))}
            </ul>
          )}
          {retry.error && <Banner tone="danger" className="mt-2">{(retry.error as Error).message}</Banner>}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-line">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DeliveryRow({
  delivery,
  canPublish,
  retrying,
  onRetry,
}: {
  delivery: EntryDelivery;
  canPublish: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const ids = Object.entries(delivery.externalIds);
  return (
    <li className="rounded-lg border border-line bg-surface-mid px-3 py-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-body">{channelLabel(delivery.channel)}</span>
        <Badge tone={DELIVERY_STATUS_TONE[delivery.status] ?? "neutral"}>
          {DELIVERY_STATUS_LABEL[delivery.status] ?? delivery.status}
        </Badge>
        {delivery.publishedAt && (
          <span className="text-xs text-muted">{new Date(delivery.publishedAt).toLocaleString()}</span>
        )}
        {delivery.attemptCount > 0 && (
          <span className="text-xs text-muted">
            {delivery.attemptCount} {delivery.attemptCount === 1 ? "attempt" : "attempts"}
          </span>
        )}
        {delivery.status === "failed" && canPublish && (
          <button type="button" className="btn-primary ml-auto" disabled={retrying} onClick={onRetry}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        )}
      </div>

      {delivery.error && <Banner tone="danger">{delivery.error}</Banner>}

      {ids.length > 0 && (
        <ul className="space-y-0.5">
          {ids.map(([key, value]) => (
            <li key={key} className="text-xs text-muted">
              <span className="text-faint">{key}: </span>
              {isHttpUrl(value) ? (
                <a
                  href={value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent hover:text-accent-soft underline"
                >
                  {value}
                </a>
              ) : (
                <span className="font-mono">{value}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
