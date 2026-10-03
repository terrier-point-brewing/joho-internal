---
name: feedback_subagent_content_fabrication
description: "Subagents seeding real-world content from a paraphrased brief will invent plausible-but-wrong data; verify content accuracy against the source, not just code"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7201f924-1fdc-48c8-a9b7-4d961fb68141
  modified: 2026-07-22T22:48:41.032Z
---

When a subagent (or any implementer) is asked to seed **real-world content** (brand copy, mission, config values, domain data) from a brief that only *paraphrases* the source, it will confidently **invent plausible-but-wrong content** to fill the gaps. In the Joho brand system, the Phase 0 seed canon shipped a fabricated mission ("companion at the end of the day" instead of the real "cultural exploration; beer is the medium"), invented voice sliders, invented lean-words, and invented beer names — all of which passed every code review and went live.

**Why:** every review (per-task + final Opus) checked code correctness, not content fidelity. Fabricated content is syntactically valid and tests pass, so nothing flags it.

**How to apply:**
- When a task seeds content from an external source, put the **verbatim source data in the brief** (or attach it), not a paraphrase. If you can't, don't let the subagent seed it — extract the real values yourself first.
- Add a review pass (or a test) that checks content **against the source**, not just that the code compiles. "Does the mission match the guide?" is a different question from "does it parse?"
- Treat any subagent-authored real-world content as unverified until diffed against the authority.

See [[project_brand_design_system]] (PR #243 was the true-up that caught and fixed it).
