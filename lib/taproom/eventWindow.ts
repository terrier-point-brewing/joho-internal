/**
 * The window an event counts pours in. Managers enter the pouring hours;
 * tabs get opened a little before and closed a little after, so every reader
 * of `event_start`/`event_end` pads both ends by one hour. One constant, one
 * function, so the pour table and the unallocated-pours check cannot
 * disagree about whether a ticket belongs to an event.
 */
export const EVENT_WINDOW_BUFFER_MS = 60 * 60 * 1000;

export function bufferedEventWindow(ev: { event_start: string; event_end: string }): { startMs: number; endMs: number } {
  return {
    startMs: new Date(ev.event_start).getTime() - EVENT_WINDOW_BUFFER_MS,
    endMs:   new Date(ev.event_end).getTime()   + EVENT_WINDOW_BUFFER_MS,
  };
}
