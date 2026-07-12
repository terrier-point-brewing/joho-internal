#!/usr/bin/env node
// PreToolUse hook (matcher: Agent|Task). Counts subagent spawns per session and
// injects a warning once the count exceeds the budget. Non-blocking by design:
// the cost driver is spawn_count x fixed per-spawn context tax (~50-80k input
// tokens each), so this nudges consolidation without ever wedging a legit run.
// Cap override: env CLAUDE_SPAWN_CAP (default 12).
const fs = require("fs");
const os = require("os");
const path = require("path");

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let data = {};
try { data = JSON.parse(raw || "{}"); } catch {}

const tool = data.tool_name || "";
if (!/^(Agent|Task)$/.test(tool)) process.exit(0);

const sessionId = String(data.session_id || "unknown").replace(/[^\w.-]/g, "_");
const cap = parseInt(process.env.CLAUDE_SPAWN_CAP || "12", 10);
const counterFile = path.join(os.tmpdir(), `cc-spawn-${sessionId}.count`);

let count = 0;
try { count = parseInt(fs.readFileSync(counterFile, "utf8"), 10) || 0; } catch {}
count += 1;
try { fs.writeFileSync(counterFile, String(count)); } catch {}

if (count > cap) {
  const msg =
    `Token guardrail: this session has now spawned ${count} subagents (budget ${cap}). ` +
    `Each spawn re-ingests the full system context (~50-80k input tokens) — that multiplier, ` +
    `not the code you write, is what makes a feature cost millions of tokens. Before spawning again: ` +
    `consolidate the remaining tasks by file-locality into ONE sequential agent, or finish inline. ` +
    `Only exceed the plan's Execution Budget spawn cap if you state explicitly why more groups are needed.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: msg },
  }));
}
process.exit(0);
