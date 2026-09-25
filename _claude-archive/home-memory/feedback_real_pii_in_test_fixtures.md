---
name: feedback-real-pii-in-test-fixtures
description: "Never hand a subagent real user-provided data (CSVs, exports) as a test fixture without an explicit anonymization instruction"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bf2a7637-ba37-4fac-aad2-bedf002cd197
---

When the user pastes or uploads a real data export (e.g. a payroll CSV, customer list, financial
statement) to ground a design or verify parsing logic, and that data later needs to become a test
fixture, the subagent brief must explicitly instruct anonymization before the data is copied into
any file that will be committed. Do not assume "use this as your fixture" implies "anonymize
first" — it does not.

**Why:** In [[project_payroll_gl_account_split]], the controller kept a real Gusto payroll CSV
(the user's actual employee names, wages, and tax withholding) in a gitignored scratch directory
specifically to avoid committing it, then told an implementer subagent to "copy/adapt its
contents into your test file as needed." The subagent reasonably inlined the data verbatim into a
*committed* test file, and the controller separately hand-wrote real names and dollar breakdowns
into a plan doc while verifying parsing logic. Both went into local git history undetected until
the first `git push` was blocked by the platform's data-exfiltration safety classifier — a real
person's compensation data came within one push of a public GitHub repo, caught by the safety
system rather than by process discipline.

**How to apply:** Any time real user data is handed to a subagent as a fixture basis, the brief
must say explicitly: "anonymize [specific identifying fields] before writing this into any
committed file; preserve the numeric structure exactly so verified test assertions stay valid."
Also remember to check every file that referenced the real data during design/verification work
(plan docs, spec docs, scratch notes that got quoted into something committed) — not just the
obvious test-fixture file. If real PII does end up in local git history before being caught,
remediating it requires rewriting history (not just a follow-up commit, since a plain push still
sends the full history) — get explicit user confirmation of the *specific* remediation plan
before doing that, not a generic "yes, fix it."
