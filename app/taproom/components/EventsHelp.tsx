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
          <p className="font-semibold">An event only sees pours rung as a Square &ldquo;Event Pour&rdquo; item inside its time window.</p>
          <p className="mt-1">
            Ring a pour on the regular draft item, or outside the event&rsquo;s start and end, and it lands in the
            everyday taproom numbers instead. Nothing here moves sales between the two afterwards.
          </p>
        </Banner>

        {/* The mechanism, in one place — the tab itself only shows the result. */}
        <details className="rounded-lg border border-line bg-surface/40 px-4 py-3 text-sm text-body">
          <summary className="cursor-pointer font-medium text-strong select-none">How a pour gets counted</summary>
          <ul className="mt-2 ml-5 list-disc space-y-1.5 leading-relaxed marker:text-faint">
            <li>Any Square item whose name contains <span className="font-medium">Event Pour</span> counts. Each of its variations becomes a row in the event&rsquo;s table.</li>
            <li>A sale counts when the order was <span className="font-medium">closed</span> between the event&rsquo;s start and end. The time the ticket is paid is what matters, not when it was opened.</li>
            <li>Tips are taken from the whole order when it has at least one Event Pour on it, split into card and cash by how the customer paid.</li>
            <li>Invoiced sales never count, even inside the window.</li>
            <li>Event Pour sales show up in Finance under Events, not Taproom.</li>
          </ul>
        </details>

        <section className="rounded-lg border border-dashed border-line-strong p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Btn>Square</Btn>
            <p className="text-sm font-medium text-strong">One-time setup in Square</p>
          </div>
          <ol className="mt-3 ml-5 list-decimal space-y-1.5 text-sm text-body leading-relaxed marker:text-faint">
            <li>In Square Items, create an item named <span className="font-medium">Event Pour</span>. The name has to include those two words; anything else in the name is fine.</li>
            <li>Add one variation per thing you sell at events, for example <span className="font-medium">Pint</span>, <span className="font-medium">Half Pint</span>, <span className="font-medium">Flight</span>. The variation name is what the table shows, so name it the way you want to read it.</li>
            <li>Set each variation&rsquo;s price and sales tax the same way as the regular draft items.</li>
            <li>Put the item on the register&rsquo;s home screen so staff can find it during the rush.</li>
          </ol>
          <p className="mt-3 text-xs text-muted leading-relaxed">
            Do this once. Later events reuse the same item. Add a variation when a new pour size or special is needed, and it appears in the next event&rsquo;s table on its own.
          </p>
        </section>

        <Action
          button="+ New Event"
          when="Before the event starts"
          steps={[
            <>Press <Btn>+ New Event</Btn> and give it a name and a host.</>,
            <>Set <span className="font-medium">Start</span> and <span className="font-medium">End</span> to the real pouring window. Leave a little room at the end so the last tabs closed after last call still count.</>,
            <>Press <Btn>Save Event</Btn>. The event can be made before or after the day; only the window matters.</>,
          ]}
          note="Two events that overlap in time both see the same pours. Keep windows apart."
        />

        <Action
          button="Event Pour"
          when="Ringing pours during the event"
          steps={[
            <>Ring every event pour on the <span className="font-medium">Event Pour</span> item, picking the right variation. Never on the regular tap item.</>,
            "Apply any event discount on the line like normal. It shows in the Discounts column.",
            "Close each ticket before the event's end time. A tab left open past the end falls out of the event.",
          ]}
          note="Tips on a ticket count toward the event when any Event Pour is on it, so keep event pours and regular pours on separate tickets where you can."
        />

        <Action
          button="Edit"
          when="The window was wrong, or pours are missing"
          steps={[
            <>Press <Btn>Edit</Btn> on the event and widen <span className="font-medium">Start</span> or <span className="font-medium">End</span>.</>,
            <>Press <Btn>Save Event</Btn>, then open the event again to see the refreshed table.</>,
          ]}
          note="Pours rung on the regular draft item can't be recovered by editing the window. They stay in the everyday taproom numbers."
        />

        <Action
          button="Delete"
          when="The event didn't happen or was made twice"
          steps={[
            <>Press <Btn>Delete</Btn>, then <Btn>Confirm</Btn>.</>,
          ]}
          note="Only the event record goes. The Square sales are untouched; make a new event with the right window and they show there."
        />

        <div className="flex justify-end pt-1">
          <button type="button" onClick={onClose} className="btn-primary">Got it</button>
        </div>
      </div>
    </Modal>
  );
}
