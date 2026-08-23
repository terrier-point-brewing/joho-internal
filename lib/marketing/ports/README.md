# Ports

Marketing is the first part of this app with an **enforced import boundary**
(`scripts/check-marketing-boundary.mjs`). Nothing outside marketing may import
marketing, and marketing may only reach a narrow list of host modules —
`@/lib/auth`, `@/lib/supabase`, `@/lib/utils`, `@/lib/cron`,
`@/app/components`, and marketing's own files.

That means marketing cannot reach into `lib/production/`, `lib/brand/`,
`lib/finance/` or any other section directly. A port is the sanctioned route
when it eventually needs something one of them knows.

## The pattern

1. **The interface is declared inside marketing.** Marketing states what it
   needs in its own vocabulary — `ActiveTaps`, `BrandVoice` — not in the shape
   whichever section happens to hold the data today.
2. **The host implements and registers it.** The adapter lives outside
   marketing, in host code that is already allowed to import both sides, and is
   handed in. Marketing never constructs one.
3. **A port is read-only.** It answers questions. It has no method that
   creates, updates or deletes anything.
4. **Marketing never writes through a port.** Anything marketing changes, it
   changes in its own tables through its own code. A port that writes is a
   dependency wearing a disguise, and re-couples the two sides the boundary was
   drawn to separate.

## What is here today

Nothing but this file, deliberately.

Later chips are expected to want brand voice, active taps, taproom events,
sales figures and budget caps. The chassis needs none of them, and an interface
with no implementation and no caller is a guess about a shape nobody has
measured yet. The first real port arrives with the first real need.
