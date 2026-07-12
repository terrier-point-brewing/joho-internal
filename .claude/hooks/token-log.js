#!/usr/bin/env node
// Stop + SubagentStop hook — the measurement lever.
//
// Why it's built this way: subagent token spend does NOT live in the main
// transcript. Each subagent has its own file at
//   <dir>/<session-id>/subagents/agent-<id>.jsonl
// and the SubagentStop hook is handed the MAIN transcript path, not the
// subagent's. A naive hook that sums `transcript_path` therefore never sees the
// fan-out cost — which, measured on the tax-submission run, was ~92% of the bill
// (13.2M cache-write across 49 subagents vs 1.14M output). So on every fire we
// ALSO scan the sibling subagents/ dir and log each subagent file exactly once
// (deduped via a per-session seen-set), giving true per-spawn visibility.
const fs = require("fs");
const os = require("os");
const path = require("path");

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let data = {};
try { data = JSON.parse(raw || "{}"); } catch {}

const transcript = data.transcript_path;
const event = data.hook_event_name || "Stop";
const sessionId = String(data.session_id || "unknown");
if (!transcript) process.exit(0);

// Sum usage for one transcript file. output + cache-write are summed (per-turn,
// additive); cache-read + fresh input are reported as peaks (cumulative-ish).
function summarize(file) {
  let out = 0, cacheW = 0, cacheR = 0, inp = 0, turns = 0;
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const u = obj && obj.message && obj.message.usage;
      if (!u) continue;
      turns++;
      out += u.output_tokens || 0;
      cacheW += u.cache_creation_input_tokens || 0;
      cacheR = Math.max(cacheR, u.cache_read_input_tokens || 0);
      inp = Math.max(inp, u.input_tokens || 0);
    }
  } catch {}
  return { out, cacheW, cacheR, inp, turns };
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const logFile = path.join(projectDir, ".claude", "token-usage.log");
const shortId = sessionId.slice(0, 8);
function append(label, id, s) {
  fs.appendFileSync(
    logFile,
    `${new Date().toISOString()}\t${label}\t${id}\tturns=${s.turns}\tout=${s.out}\tcacheW=${s.cacheW}\tcacheR=${s.cacheR}\tin=${s.inp}\n`
  );
}

// Log any subagent transcripts we haven't logged yet (dedupe by filename).
const subDir = path.join(path.dirname(transcript), path.basename(transcript, ".jsonl"), "subagents");
const seenFile = path.join(os.tmpdir(), `cc-logged-${shortId}.txt`);
let seen = new Set();
try { seen = new Set(fs.readFileSync(seenFile, "utf8").split("\n").filter(Boolean)); } catch {}
let newSubOut = 0, newSubCW = 0, newSubCount = 0;
try {
  for (const f of fs.readdirSync(subDir)) {
    if (!f.endsWith(".jsonl") || seen.has(f)) continue;
    const s = summarize(path.join(subDir, f));
    append("subagent", f.replace(/^agent-|\.jsonl$/g, "").slice(0, 12), s);
    seen.add(f);
    newSubOut += s.out; newSubCW += s.cacheW; newSubCount++;
  }
  fs.writeFileSync(seenFile, [...seen].join("\n") + "\n");
} catch {}

// On a real turn end, log the orchestrator total and surface a one-liner.
if (event !== "SubagentStop") {
  const m = summarize(transcript);
  try { append("session ", shortId, m); } catch {}
  const totalSubCW = newSubCW; // new-this-turn; running total lives in the log
  process.stdout.write(JSON.stringify({
    systemMessage:
      `Token log (.claude/token-usage.log): orchestrator output ~${m.out.toLocaleString()} tok, ` +
      `cache-write ~${m.cacheW.toLocaleString()} tok; ${seen.size} subagent transcript(s) logged` +
      (newSubCount ? ` (+${newSubCount} this turn, ~${totalSubCW.toLocaleString()} cache-write)` : "") +
      `. Cache-write ≈ context ingested — watch it, not output. \`rtk gain\` for cost analytics.`,
  }));
}
process.exit(0);
