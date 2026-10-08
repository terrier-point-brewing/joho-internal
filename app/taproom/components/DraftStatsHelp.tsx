"use client";

import type { ReactNode } from "react";
import { Modal } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";

/** A button's name, drawn like the button so it can be matched to the card by eye. */
function Btn({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded border border-line-strong bg-surface px-1.5 py-0.5 text-xs font-medium text-strong whitespace-nowrap">
      {children}
    </span>
  );
}

/** One action: the button, when to reach for it, then the steps. */
function Action({
  button,
  when,
  steps,
  note,
}: {
  button: string;
  when: string;
  steps: ReactNode[];
  note?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface/40 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Btn>{button}</Btn>
        <p className="text-sm font-medium text-strong">{when}</p>
      </div>
      <ol className="mt-3 ml-5 list-decimal space-y-1.5 text-sm text-body leading-relaxed marker:text-faint">
        {steps.map((step, i) => <li key={i}>{step}</li>)}
      </ol>
      {note && <p className="mt-3 text-xs text-muted leading-relaxed">{note}</p>}
    </section>
  );
}

/**
 * How-to for the tap cards. Written for whoever is running the taproom that
 * day, so it names the button, when to press it, and what to do in Square —
 * not how the booking works underneath. One card per button, steps only.
 */
export default function DraftStatsHelp({
  onClose,
  canSetUpTaps,
}: {
  onClose: () => void;
  canSetUpTaps: boolean;
}) {
  return (
    <Modal title="How to use Draft Stats" onClose={onClose} wide>
      <div className="space-y-3">
        <Banner tone="info">
          <p className="font-semibold">Nothing changes until Draft Restock is rung.</p>
          <p className="mt-1">
            Every button below only queues a change. It takes effect the next time Draft Restock is rung for that
            tap in Square — so ring it every time a keg goes on.
          </p>
        </Banner>

        <Action
          button="Mark Retired"
          when="We're done brewing this beer for now"
          steps={[
            <>Press <Btn>Mark Retired</Btn> on the tap.</>,
            "The tap keeps pouring. The beer just stops being suggested for brewing.",
          ]}
          note={<>Undo with <Btn>Unretire</Btn>. Putting the beer back on a tap also un-retires it.</>}
        />

        <Action
          button="Swap beer"
          when="A different beer is going on this tap"
          steps={[
            <>Press <Btn>Swap beer</Btn>, then pick the new beer and its keg size.</>,
            "Change the keg.",
            <>Ring <span className="font-medium">Draft Restock</span> for that tap in Square.</>,
            <><span className="font-medium">Rename that tap&rsquo;s Draft Restock line in Square</span> to the new beer.</>,
          ]}
          note="Until the restock is rung the card still shows the old beer. What's left in the old keg is written off then."
        />

        <Action
          button="Change keg size"
          when="Same beer, but the next keg is a different size"
          steps={[
            <>Press <Btn>Change keg size</Btn> and pick the new size.</>,
            "Change the keg.",
            <>Ring <span className="font-medium">Draft Restock</span> for that tap in Square.</>,
          ]}
          note="Each card shows the keg size the tap is set to right now."
        />

        <Action
          button="Set beer"
          when="Putting a beer on an empty tap"
          steps={[
            <>Press <Btn>Set beer</Btn>, then pick the beer and its keg size.</>,
            "Put the keg on.",
            <>Ring <span className="font-medium">Draft Restock</span> for that tap in Square.</>,
          ]}
          note="The tap shows as empty until the restock is rung."
        />

        <Action
          button="Cancel"
          when="Queued the wrong thing"
          steps={[
            <>Press <Btn>Cancel</Btn> next to the queued beer on the card.</>,
          ]}
          note="Only works before the restock is rung. Nothing has moved yet, so there is nothing else to undo."
        />

        <section className="rounded-lg border border-dashed border-line-strong p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Btn>Configure Taps</Btn>
            <p className="text-sm font-medium text-strong">Admin only</p>
          </div>
          <p className="mt-2 text-sm text-body leading-relaxed">
            Number of taps and which Square Draft Restock line belongs to which tap.
            {canSetUpTaps
              ? " A wrong setting here stops kegs being booked."
              : " If a card says it needs tap setup, ask an admin."}
          </p>
        </section>

        <div className="flex justify-end pt-1">
          <button type="button" onClick={onClose} className="btn-primary">Got it</button>
        </div>
      </div>
    </Modal>
  );
}
