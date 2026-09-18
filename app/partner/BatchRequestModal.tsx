"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import Banner from "@/app/components/ui/Banner";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import { longDate, monthLabel, shortDate, type BrewWindow, type Overview } from "./types";

const NEW = "__new__";
const MAX_FILES = 5;

export default function BatchRequestModal({ overview, month, previewAs, onClose, onSubmitted }: {
  overview: Overview;
  /** Month the partner clicked on the capacity strip, if any — preselects the first window in it. */
  month: string | null;
  /** Staff preview only: the company being previewed. Ignored by the API for real partners. */
  previewAs: string | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [beer, setBeer] = useState(overview.recipes[0]?.id ?? NEW);
  const [turns, setTurns] = useState(1);
  const [week, setWeek] = useState<string | null>(null); // null = not chosen yet; "" = flexible
  const [notes, setNotes] = useState("");
  const [newBeer, setNewBeer] = useState({ name: "", style: "", abv: "", ingredients: "", instructions: "", ingredient_supply: "brewery" });
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isNew = beer === NEW;
  const windows = useQuery({
    queryKey: ["partner", "windows", beer, turns, previewAs],
    queryFn: () => fetchJson<{ windows: BrewWindow[] }>(`/api/partner/windows?turns=${turns}${isNew ? "" : `&recipe_id=${beer}`}${previewAs ? `&as=${encodeURIComponent(previewAs)}` : ""}`),
  });
  const options = windows.data?.windows ?? [];
  // Until the partner picks, lean toward the month they clicked.
  const chosen = week ?? options.find((w) => month && w.week_of.startsWith(month))?.week_of ?? options[0]?.week_of ?? "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const form = new FormData();
    form.set("payload", JSON.stringify({
      kind: "batch", turns, notes, desired_date: chosen || null,
      ...(isNew ? { new_beer: newBeer } : { recipe_id: beer }),
    }));
    for (const f of files) form.append("files", f);
    const res = await fetch("/api/partner/requests", { method: "POST", body: form });
    setSaving(false);
    if (res.ok) return onSubmitted();
    setError((await res.json().catch(() => ({}))).error ?? "Could not send the request.");
  }

  const setNB = (k: keyof typeof newBeer) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setNewBeer((b) => ({ ...b, [k]: e.target.value }));

  return (
    <Modal title="Request a batch" onClose={onClose} wide>
      {error && <Banner className="mb-4">{error}</Banner>}
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Beer" required>
          <select value={beer} onChange={(e) => { setBeer(e.target.value); setWeek(null); }} className="inp w-full">
            {overview.recipes.length > 0 && (
              <optgroup label="Your beers">
                {overview.recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}{r.style ? ` — ${r.style}` : ""}</option>)}
              </optgroup>
            )}
            <option value={NEW}>Something new…</option>
          </select>
        </Field>

        {isNew && (
          <div className="flex flex-col gap-3 rounded-md border border-line p-3">
            <p className="text-xs text-muted">
              Give us the full recipe and brew instructions so our brewers can build it. Attach a recipe sheet or BeerXML if you have one.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Beer name" required><input required value={newBeer.name} onChange={setNB("name")} className="inp w-full" /></Field>
              <Field label="Style"><input value={newBeer.style} onChange={setNB("style")} className="inp w-full" /></Field>
              <Field label="Target ABV" hint="%"><input type="number" inputMode="decimal" min={0} max={30} step={0.1} value={newBeer.abv} onChange={setNB("abv")} className="inp w-full" /></Field>
            </div>
            <Field label="Ingredients" required hint="grain, hops, yeast, adjuncts — quantities per turn">
              <textarea required rows={5} value={newBeer.ingredients} onChange={setNB("ingredients")} className="inp w-full" />
            </Field>
            <Field label="Brew instructions" required hint="mash, boil, fermentation temps, dry hop schedule, days in tank">
              <textarea required rows={5} value={newBeer.instructions} onChange={setNB("instructions")} className="inp w-full" />
            </Field>
            <Field label="Who supplies the ingredients?">
              <select value={newBeer.ingredient_supply} onChange={setNB("ingredient_supply")} className="inp w-full">
                <option value="brewery">The brewery sources them</option>
                <option value="partner">We supply them</option>
              </select>
            </Field>
            <Field label="Attach files" hint={`up to ${MAX_FILES}, 10 MB each`}>
              <input
                type="file" multiple accept=".pdf,.xml,.beerxml,.xlsx,.xls,.csv,.doc,.docx,.txt,image/*"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, MAX_FILES))}
                className="inp w-full"
              />
            </Field>
          </div>
        )}

        <Field label="Size" required>
          <select value={turns} onChange={(e) => { setTurns(Number(e.target.value)); setWeek(null); }} className="inp w-full">
            {Array.from({ length: overview.max_turns }, (_, i) => i + 1).map((t) => (
              <option key={t} value={t}>{t} turn{t === 1 ? "" : "s"} — about {t * overview.turn_bbl} bbl</option>
            ))}
          </select>
          <p className="text-xs text-muted mt-1">
            One turn is a {overview.turn_bbl} bbl brew. Expect less after shrinkage in fermentation and packaging.
          </p>
        </Field>

        <Field label="When" required>
          <select value={chosen} onChange={(e) => setWeek(e.target.value)} className="inp w-full" disabled={windows.isLoading}>
            {options.map((w) => (
              <option key={w.week_of} value={w.week_of}>
                Brew week of {longDate(w.week_of)} — ready around {shortDate(w.ready_around)}
              </option>
            ))}
            <option value="">Flexible — whenever you can fit it in</option>
          </select>
          <p className="text-xs text-muted mt-1">
            {windows.isLoading ? "Checking the schedule…"
              : windows.error ? "Could not read the schedule. Send it as flexible and we will reply with dates."
              : options.length === 0 ? "No open weeks for a brew this size in the next six months. Send it as flexible and we will see what we can do."
              : isNew ? "Estimated for a standard two-week fermentation; we confirm once the recipe is built."
              : month && !options.some((w) => w.week_of.startsWith(month)) ? `Nothing this size fits in ${monthLabel(month)} for this beer — showing the nearest open weeks.`
              : "Open weeks for this beer at this size."}
          </p>
        </Field>

        <Field label="Notes" hint="packaging, label, anything we should know">
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className="inp w-full" />
        </Field>
        <ModalActions submitting={saving} onCancel={onClose} label="Send request" />
      </form>
    </Modal>
  );
}
