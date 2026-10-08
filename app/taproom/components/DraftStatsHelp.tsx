"use client";

import type { ReactNode } from "react";
import { Modal } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";

function Topic({ title, when, children }: { title: string; when: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-strong">{title}</h3>
      <p className="text-xs text-muted mt-0.5">{when}</p>
      <div className="text-xs text-body leading-relaxed mt-1.5 space-y-1">{children}</div>
    </section>
  );
}

/**
 * How-to for the tap cards. Written for whoever is running the taproom that
 * day, so it names the button, when to press it, and what to do in Square —
 * not how the booking works underneath.
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
      <div className="space-y-5">
        <Banner tone="info">
          Nothing here moves a keg by itself. Every change is <span className="font-medium">queued</span> and
          takes effect the next time <span className="font-medium">Draft Restock</span> is rung for that tap in
          Square. Ring it every time a keg goes on, including the first.
        </Banner>

        <Topic
          title="Mark Retired"
          when="Use when we don't plan to keep brewing this beer or have it on tap for the foreseeable future."
        >
          <p>
            It stops the beer being suggested for brewing. The tap keeps pouring and counting down as normal, and
            only greys out once the keg is nearly empty.
          </p>
          <p>
            Changed your mind? Press <span className="font-medium">Unretire</span>. Putting the beer back on a tap
            un-retires it automatically.
          </p>
        </Topic>

        <Topic
          title="Swap keg — a different beer"
          when="Use to line up the next beer for a tap that is pouring something else."
        >
          <ol className="ml-4 list-decimal space-y-1">
            <li>Press <span className="font-medium">Swap keg</span> on the tap, pick the beer going on and its keg size.</li>
            <li>The card shows it as queued. The tap keeps showing the current beer until the keg is changed.</li>
            <li>When the new keg goes on, ring <span className="font-medium">Draft Restock</span> for that tap in Square.</li>
            <li>
              <span className="font-medium">Rename that tap&rsquo;s Draft Restock line in Square</span> so it shows
              the new beer.
            </li>
          </ol>
          <p>
            Whatever is left in the old keg is written off as shrinkage when the restock is rung. You can retire the
            old beer in the same step.
          </p>
        </Topic>

        <Topic
          title="Swap keg — same beer, different keg size"
          when="Use when the next keg of the same beer is a different size, e.g. a 1/2 barrel after a 1/6."
        >
          <p>
            Press <span className="font-medium">Swap keg</span>, pick the <span className="font-medium">same beer</span>,
            then the new keg size. The next Draft Restock ring pulls that size from cold storage and refills the tap
            to it. Each card shows the keg size it is currently set to.
          </p>
        </Topic>

        <Topic
          title="Set beer — an empty tap"
          when="Use to put a beer on a tap that has nothing on it."
        >
          <p>
            Press <span className="font-medium">Set beer</span>, pick the beer and keg size, then ring Draft Restock
            for that tap when the keg goes on. The tap stays empty on screen until it is rung.
          </p>
        </Topic>

        <Topic title="Changed your mind?" when="Before the restock is rung.">
          <p>
            Press <span className="font-medium">Cancel</span> next to the queued beer on the card. Nothing has moved
            yet, so there is nothing to undo.
          </p>
        </Topic>

        <Topic
          title="Tap setup"
          when={canSetUpTaps ? "Configure Taps — admin only." : "Needs an admin."}
        >
          <p>
            The number of taps, the Draft Restock item and which Square line belongs to which tap. Getting these
            wrong stops kegs being booked, so they are kept out of day-to-day use.
            {!canSetUpTaps && " If a tap says it needs setup, ask an admin."}
          </p>
        </Topic>

        <div className="flex justify-end pt-2 border-t border-line">
          <button type="button" onClick={onClose} className="btn-primary">Got it</button>
        </div>
      </div>
    </Modal>
  );
}
