"use client";

/**
 * Compose: the one screen where a person's intent enters marketing.
 *
 * Three things here are deliberate and worth reading before editing:
 *
 *  1. **The channel list comes from the registry, never from a constant.** This
 *     file does not name a channel anywhere, which is what makes adding one a
 *     folder and a line. `validate()` is called on every keystroke — the
 *     contract requires it to be synchronous for exactly this — and a channel
 *     it refuses is disabled with the plugin's own sentences printed beside it.
 *     Those sentences are rendered as written; there is no layer between them
 *     and the human eye that could translate a code.
 *  2. **When is "now", and Schedule is present and disabled.** The date and
 *     time control is rendered, filled in, and switched off, because a control
 *     that is missing reads as a bug and a control that is absent reads as a
 *     feature nobody thought of. Scheduling is coming; this says so.
 *  3. **A draft keeps its channels.** Saving without posting sends the picked
 *     channels anyway — they become `pending` deliveries, which is the only
 *     record of that choice anywhere. Nothing publishes: the entry stays a
 *     draft until a person presses Post now.
 */
import { useMemo, useState } from "react";

import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import { Field, Modal } from "@/app/components/ui/Modal";
import { listChannels } from "@/lib/marketing/plugins/registry";
import type { Entry, Media, ValidationResult } from "@/lib/marketing/plugins/types";
import { useCreateEntry, useUploadMedia } from "../hooks/useMarketing";
import { ENTRY_KINDS, channelLabel } from "./status";

/** The longest caption we count up to before the number itself becomes noise. */
const CAPTION_SOFT_LIMIT = 2200;

export default function ComposeModal({
  connectedChannels,
  onClose,
}: {
  /** Channel keys with a login the publisher can actually post through. */
  connectedChannels: string[];
  onClose: () => void;
}) {
  const create = useCreateEntry();
  const upload = useUploadMedia();

  const [kind, setKind] = useState<string>("post");
  const [caption, setCaption] = useState("");
  const [media, setMedia] = useState<Media[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const channels = useMemo(() => listChannels(), []);

  /**
   * The entry as it stands right now, in the shape a plugin is handed.
   *
   * It has no id yet and never will inside this modal — `validate` is a
   * question about content, and the id is the one field it has no business
   * reading.
   */
  const candidate: Entry = useMemo(
    () => ({
      id: "",
      kind,
      startsAt: new Date().toISOString(),
      endsAt: null,
      caption: caption.trim() === "" ? null : caption,
      details: {},
      status: "draft",
      origin: "manual",
      tags: [],
    }),
    [kind, caption],
  );

  const verdicts = useMemo(() => {
    const map = new Map<string, ValidationResult>();
    for (const plugin of channels) map.set(plugin.channel, plugin.validate(candidate, media));
    return map;
  }, [channels, candidate, media]);

  function toggleChannel(channel: string) {
    setPicked((prev) => (prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel]));
  }

  function moveMedia(index: number, by: -1 | 1) {
    setMedia((prev) => {
      const next = [...prev];
      const target = index + by;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  /**
   * Upload one file, measuring it first.
   *
   * The dimensions are probed in the browser because nothing on the server
   * looks inside the bytes — `lib/marketing/media.ts` stores what it is told —
   * and a plugin that refuses a portrait crop can only do so if someone
   * measured it. A file we cannot measure still uploads: null means "not
   * known", and a plugin that needs the number says so in a sentence.
   */
  async function probeAndUpload(file: File) {
    setError(null);
    const form = new FormData();
    form.set("file", file);
    try {
      const size = await probeImageSize(file);
      if (size) {
        form.set("width", String(size.width));
        form.set("height", String(size.height));
      }
      const uploaded = await upload.mutateAsync(form);
      setMedia((prev) => [...prev, uploaded]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submit(postNow: boolean) {
    setError(null);
    try {
      await create.mutateAsync({
        kind,
        startsAt: new Date().toISOString(),
        caption: caption.trim() === "" ? null : caption,
        mediaIds: media.map((m) => m.id),
        channels: picked,
        postNow,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const unconnected = picked.filter((c) => !connectedChannels.includes(c));
  const busy = create.isPending || upload.isPending;
  const canPostNow = picked.length > 0 && unconnected.length === 0 && !busy;

  return (
    <Modal title="Compose" onClose={onClose} wide>
      <div className="space-y-4">
        {error && <Banner tone="danger">{error}</Banner>}

        <Field label="Kind">
          <select className="inp" value={kind} onChange={(e) => setKind(e.target.value)}>
            {ENTRY_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Caption">
          <textarea
            className="inp"
            rows={4}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="What is going out?"
          />
          <p className="text-xs text-muted mt-1">
            {caption.length} / {CAPTION_SOFT_LIMIT} characters
          </p>
        </Field>

        <Field label="Media" hint="in the order they will appear">
          <input
            type="file"
            className="inp"
            accept="image/*"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void probeAndUpload(file);
            }}
          />
          {upload.isPending && <p className="text-xs text-muted mt-1">Uploading…</p>}

          {media.length === 0 ? (
            <p className="text-sm text-muted mt-2">
              Nothing attached yet. An entry can go out as text alone, or with images in the order you add them.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {media.map((item, index) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface-mid px-3 py-2"
                >
                  <span className="text-xs text-muted w-4 tabular-nums">{index + 1}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a Supabase storage URL is not a configured next/image loader host */}
                  <img src={item.url} alt="" className="h-12 w-12 rounded object-cover border border-line" />
                  <span className="text-xs text-muted flex-1 truncate">
                    {item.width && item.height ? `${item.width} × ${item.height}` : "size not measured"}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="btn-secondary btn-xxs"
                      disabled={index === 0}
                      onClick={() => moveMedia(index, -1)}
                      aria-label="Move earlier"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-xxs"
                      disabled={index === media.length - 1}
                      onClick={() => moveMedia(index, 1)}
                      aria-label="Move later"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn-danger btn-xxs"
                      onClick={() => setMedia((prev) => prev.filter((m) => m.id !== item.id))}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Field>

        <Field label="Channels">
          {channels.length === 0 ? (
            <p className="text-sm text-muted">
              No channel is set up in this app yet, so there is nowhere to post. An entry saved now sits on the
              calendar as a draft until one is added.
            </p>
          ) : (
            <ul className="space-y-2">
              {channels.map((plugin) => {
                const verdict = verdicts.get(plugin.channel);
                const refused = verdict && !verdict.ok;
                const connected = connectedChannels.includes(plugin.channel);
                return (
                  <li
                    key={plugin.channel}
                    className="rounded-lg border border-line bg-surface-mid px-3 py-2"
                  >
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-[var(--color-accent-emphasis)]"
                        checked={picked.includes(plugin.channel)}
                        disabled={refused}
                        onChange={() => toggleChannel(plugin.channel)}
                      />
                      <span className={`text-sm ${refused ? "text-faint" : "text-body"}`}>
                        {channelLabel(plugin.channel)}
                      </span>
                      <Badge tone={connected ? "success" : "neutral"}>
                        {connected ? "Connected" : "Not connected"}
                      </Badge>
                    </label>
                    {refused && (
                      <ul className="mt-1 pl-6 space-y-0.5">
                        {verdict.reasons.map((reason) => (
                          <li key={reason} className="text-xs text-muted">
                            {reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {unconnected.length > 0 && (
            <div className="mt-2 rounded-lg border border-accent-border/40 bg-accent-muted/20 px-3 py-2">
              <p className="text-xs text-accent-soft">
                {unconnected.map(channelLabel).join(" and ")} has no login yet, so there is nothing to post
                through. Save this as a draft — it keeps the channels — and connect it in Settings → Marketing.
              </p>
            </div>
          )}
        </Field>

        <Field label="When" hint="scheduling is not available yet">
          <input type="datetime-local" className="inp" disabled value={localNow()} readOnly />
          <p className="text-xs text-muted mt-1">
            An entry goes out now, or waits as a draft. Picking a date and time arrives with scheduling.
          </p>
        </Field>

        <div className="flex justify-end gap-2 pt-2 border-t border-line mt-4">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void submit(false)}>
            {create.isPending ? "Saving…" : "Save as draft"}
          </button>
          <button type="button" className="btn-secondary" disabled title="Scheduling is not available yet.">
            Schedule
          </button>
          <button type="button" className="btn-primary" disabled={!canPostNow} onClick={() => void submit(true)}>
            Post now
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** `datetime-local` wants a local `YYYY-MM-DDTHH:mm`, which no Date method gives directly. */
function localNow(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Width and height from the file itself, before it is uploaded.
 *
 * Resolves null rather than rejecting for anything it cannot decode — a
 * measurement is a nicety, and refusing the upload over it would be the tail
 * wagging the dog.
 */
function probeImageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith("image/")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}
