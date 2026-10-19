"use client";

import type { ReactNode } from "react";
import { Modal } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";

/** A button's name, drawn like the button so it can be matched to the screen by eye. */
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
 * How-to for the Events tab. Written for whoever is running the event, so it
 * names what to set up in Square, what to ring, and what the tab then shows.
 * The matching rules it states are the ones the pours route actually applies:
 * a catalog item whose name contains "Event Pour", and an order closed inside
 * the event's start–end window.
 */
export default function EventsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="How to use Events" onClose={onClose} wide>
      <div className="space-y-3">
        <Banner tone="info">
          <p className="font-semibold">An event only counts pours that were rung on the Square &ldquo;Event Pour&rdquo; item and closed inside its time window.</p>
          <p className="mt-1">
            A pour rung on the regular draft item, or outside the event&rsquo;s start and end times, is counted in the
            everyday taproom numbers instead. Nothing on this tab can move a sale between the two afterwards.
          </p>
        </Banner>

        {/* The mechanism, in one place — the tab itself only shows the result. */}
        <details className="rounded-lg border border-line bg-surface/40 px-4 py-3 text-sm text-body">
          <summary className="cursor-pointer font-medium text-strong select-none">How a pour is counted</summary>
          <ul className="mt-2 ml-5 list-disc space-y-1.5 leading-relaxed marker:text-faint">
            <li>Any Square item whose name contains <span className="font-medium">Event Pour</span> is treated as an event pour. Each of its variations becomes a row in the event&rsquo;s table.</li>
            <li>A sale is counted when its order was <span className="font-medium">closed</span> between the event&rsquo;s start and end times. The time the ticket was paid is what matters, not the time it was opened.</li>
            <li>Tips are calculated automatically. Every ticket that includes at least one Event Pour contributes its whole tip, split into card and cash according to how the customer paid. This gives you the event&rsquo;s card tips without any adding up by hand.</li>
            <li>Cash tips are usually not recorded at events, so the Cash Tips tile normally shows zero. If cash tips need to reach the tip pool, count the jar separately.</li>
            <li>Invoiced sales are never counted, even when they fall inside the window.</li>
            <li>Event Pour sales appear in Finance under Events rather than Taproom.</li>
          </ul>
        </details>

        <section className="rounded-lg border border-dashed border-line-strong p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Btn>Square</Btn>
            <p className="text-sm font-medium text-strong">Set up the pours in Square</p>
          </div>
          <ol className="mt-3 ml-5 list-decimal space-y-1.5 text-sm text-body leading-relaxed marker:text-faint">
            <li>In Square Items, open the existing <span className="font-medium">Event Pour</span> item. It is already set up, so you will almost never need to create a new one.</li>
            <li><span className="font-medium">Rename its variations</span> to match this event&rsquo;s pours, for example the beers being poured, or <span className="font-medium">Pint</span> and <span className="font-medium">Half Pint</span>. The variation name is what appears in the event&rsquo;s table, so name it the way you want to read it.</li>
            <li>Check that each variation&rsquo;s price and sales tax are correct for this event.</li>
            <li>Add a new variation only when the event sells more kinds of pour than the item already has.</li>
          </ol>
          <p className="mt-3 text-xs text-muted leading-relaxed">
            Past events display each variation&rsquo;s current name, so after a rename an older event&rsquo;s table will show the new labels. The quantities and amounts do not change.
            If the item is ever missing, create one whose name contains <span className="font-medium">Event Pour</span>. Anything else in the name is fine.
          </p>
        </section>

        <Action
          button="+ New Event"
          when="Before the event starts"
          steps={[
            <>Press <Btn>+ New Event</Btn>, then enter a name and a host.</>,
            <>Set <span className="font-medium">Start</span> and <span className="font-medium">End</span> to the actual pouring window. Leave a little room at the end so that tabs closed after last call are still counted.</>,
            <>Press <Btn>Save Event</Btn>. The event can be created before or after the day itself. Only the time window matters.</>,
          ]}
          note="Two events whose windows overlap will both count the same pours, so keep their windows apart."
        />

        <Action
          button="Event Pour"
          when="Ringing pours during the event"
          steps={[
            <>Ring every event pour on the <span className="font-medium">Event Pour</span> item and pick the correct variation. Never ring an event pour on the regular tap item.</>,
            "Apply any event discount to the line as you normally would. It appears in the Discounts column.",
            "Close each ticket before the event's end time. A tab left open past the end time is not counted toward the event.",
          ]}
          note="Card tips are collected automatically from every ticket that includes an Event Pour, so keep event pours and regular pours on separate tickets whenever you can. Cash tips are usually not recorded at events, so expect the Cash Tips tile to show zero."
        />

        <Action
          button="Edit"
          when="The window was wrong or pours are missing"
          steps={[
            <>Press <Btn>Edit</Btn> on the event and adjust <span className="font-medium">Start</span> or <span className="font-medium">End</span>.</>,
            <>Press <Btn>Save Event</Btn>, then open the event again to see the updated table.</>,
          ]}
          note="Pours rung on the regular draft item cannot be recovered by editing the window. They remain in the everyday taproom numbers."
        />

        <Action
          button="Delete"
          when="The event did not happen or was created twice"
          steps={[
            <>Press <Btn>Delete</Btn>, then <Btn>Confirm</Btn>.</>,
          ]}
          note="Only the event record is removed. The Square sales are untouched, so if you create a new event with the correct window, they will appear there."
        />

        <div className="flex justify-end pt-1">
          <button type="button" onClick={onClose} className="btn-primary">Got it</button>
        </div>
      </div>
    </Modal>
  );
}
