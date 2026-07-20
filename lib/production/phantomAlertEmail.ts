import type { PhantomAlert } from "./phantomExportAlerts";

/**
 * Renders the daily digest of open phantom-export alerts — taproom keg swaps
 * that booked barrel excise with no cold-storage stock to deduct. The subject
 * reflects the open-alert count; the body lists each swap's beer, tap, date,
 * kegs, volume, and excise so the operator can reconcile once stock exists.
 */
export function renderPhantomAlertEmail(alerts: PhantomAlert[]): { subject: string; html: string } {
  const n = alerts.length;
  const subject = `${n} open phantom export alert${n === 1 ? "" : "s"}`;

  if (n === 0) {
    return { subject, html: `<p>No open phantom export alerts.</p>` };
  }

  const bodyRows = alerts
    .map((a) => {
      const tap = a.tapNumber != null ? `Tap ${a.tapNumber}` : "Tap —";
      return `<tr>
        <td>${a.beerName}</td>
        <td>${tap}</td>
        <td>${a.occurredAt}</td>
        <td>${a.quantityKegs}</td>
        <td>${a.volumeBbl.toFixed(2)} bbl</td>
        <td>$${a.exciseUsd.toFixed(2)}</td>
      </tr>`;
    })
    .join("");

  const html = `<p>${subject}. These taproom keg swaps booked barrel excise with no cold-storage stock to deduct — reconcile them once the missing stock exists.</p>
<table>
  <thead><tr><th>Beer</th><th>Tap</th><th>When</th><th>Kegs</th><th>Volume</th><th>Excise</th></tr></thead>
  <tbody>${bodyRows}</tbody>
</table>`;

  return { subject, html };
}
