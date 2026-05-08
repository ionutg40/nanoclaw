---
name: grade-review
description: Process Monica's CapYear grade verification queue. Use whenever the user asks to "check grades", "process pending", "verify scores", "what's pending", or anything similar in the CapYear Grades group, OR sends a `[callback] data=...` message (which is how inline-button taps arrive — load session_state.json and act on the encoded action), OR sends a `[Document: ...csv]` message (NHA CSV attachment — acknowledge and update the active CSV pointer). There is no slash command — natural-language phrasing only. Calls bot_cli.py to fetch pending decisions and presents them with inline keyboards (Telegram Bot API or Slack Block Kit).
allowed-tools: Bash, Read, Write, Glob, mcp__nanoclaw__send_message, mcp__nanoclaw__send_message_with_keyboard, mcp__nanoclaw__edit_message, mcp__nanoclaw__delete_message
---

# Grade Review (CapYear)

Trigger: "check grades", "process pending", "verify scores", "what's pending", or any similar natural-language phrasing. There is no slash command. For ambiguous chat, do NOT invoke — reply naturally.

## Receiving a fresh NHA CSV (chat attachment)

When the user (Monica) sends a CSV file in the chat, the channel stores it
at `/workspace/group/attachments/<filename>.csv` and you receive a message
that looks like `[Document: <name>.csv] (/workspace/group/attachments/<name>.csv)`.

Action:
1. Acknowledge: "Got the new NHA CSV. I'll use it the next time you ask for grades."
2. Save the path to `/workspace/group/active_nha_csv.txt` (one-line file with
   the absolute path). Use Write tool.
3. On every subsequent grade-check request, read that file first; if present
   and the path still exists, pass `--nha <path>` to `bot_cli.py fetch-pending`
   (with `--force` to skip cache).
4. If user sends a NEW CSV later, overwrite the file with the new path.

If `/workspace/group/active_nha_csv.txt` is missing or points to a deleted
file, fall back to the default CSV (no `--nha` flag).

## Three-step flow when asked to check grades

1. **Acknowledge** with `mcp__nanoclaw__send_message` text=`"Fetching pending submissions..."` (LW scrape can take 30-90s on the first cold call).

2. **Run** the CLI and parse JSON. If `/workspace/group/active_nha_csv.txt` exists, append `--nha <its-content>`:
   ```bash
   /opt/grade-verifier-venv/bin/python \
     /workspace/extra/grade-verifier/src/bot_cli.py fetch-pending [--nha /workspace/group/attachments/<file>.csv] [--force]
   ```
   The output ALREADY includes a `render` block with `summary_md`, `keyboard`, and `session_state` — pre-formatted by Python so you don't need to format anything yourself. If the render includes `nha_warning`, prepend it to the message before the summary.

3. **Send** with `mcp__nanoclaw__send_message_with_keyboard(text=render.summary_md, keyboard=render.keyboard)` and **save** `render.session_state` to `/workspace/group/session_state.json`.

If `success: false` or `count: 0`, send a one-liner status (use the error-code map below) and STOP.

## On callback (`[callback] data=<code> original_message_id=<id>`)

Load `session_state.json`, then route per `${CLAUDE_SKILL_DIR}/callback_routing.md`:

| Code pattern | Action |
|---|---|
| `b:<group>:<token>` | For each `short_id` in `groups[token].short_ids`: run `bot_cli.py submit --id <full_id> --action <approve\|correct\|bounce> --actor <sender> [--nha-score N]`. Then `edit_message` to status + `keyboard: null`. Show progress edits every 5+ submissions. |
| `r:<group>:<token>` | Render the first individual card from that group (template in `formatters.md`). |
| `a:<sid>` / `c:<sid>` / `x:<sid>` | Single submit (`--actor <sender>`), then `edit_message` to status. |
| `s:<sid>` | Skip — run `bot_cli.py submit --id <full_id> --action skip --actor <sender>` (writes audit row, no LW call). Then `edit_message` to "_Skipped_", `keyboard: null`. |
| `d:<sid>` | Show full details (PII allowed only here). Add `[← Back]` button → `back:<sid>`. |
| `back:<sid>` / `back:summary` | Restore the previous view. |
| `end` | Send session-close summary and clear `session_state.json`. |

For exact message templates and PII-minimization rules, see `${CLAUDE_SKILL_DIR}/formatters.md`.

**Actor attribution** (`--actor <sender>`): the sender of the callback message arrives in the trigger context as `<message sender="...">`. Pass this to every `bot_cli.py submit` invocation as `--actor`. Normalize: lowercase, replace spaces with `_`, strip non-alphanumeric except `_`. Examples: `"Monica Garcia"` → `monica_garcia`, `"rekon"` → `rekon`, `"R.T. Arnold"` → `rt_arnold`. This lets the audit log record who-graded-what across the shared CapYear group (Monica + Alberto + rekon + fasty).

## CLI commands

```bash
# Fast path — uses 5-min cache when available
bot_cli.py fetch-pending          # add --force to skip cache

# Single-submission action
bot_cli.py submit --id <full_id> --action approve|correct|bounce|skip \
                  [--nha-score N]   # required for action=correct
                  [--actor monica]
# `skip` writes an audit row but doesn't touch LW — for "deferred" deciding

# SUPERVISORY — ONLY when Monica explicitly says "process the backlog" or similar
bot_cli.py process-backlog --confidence-min 0.99 [--limit N] [--dry-run]
# Run with --dry-run first, then ask Monica to confirm before live mode.

# Quick health check (no LW login)
bot_cli.py health
```

All CLI output is JSON. Audit rows append to `data/audit/audit.jsonl` inside the mounted grade-verifier directory — no external service involved.

## Error codes (map to user English)

| Code | Tell Monica |
|---|---|
| `LW_UNREACHABLE` | "Can't reach LearnWorlds. Try again in a minute." |
| `LW_AUTH_FAILED` | "LearnWorlds rejected our login — flag fasty." |
| `LW_SESSION_EXPIRED` | (Auto-retry once. If still fails, escalate.) |
| `LW_SUBMIT_TIMEOUT` | "LearnWorlds didn't confirm the submit. Refresh and verify." |
| `LW_DOM_CHANGED` | "LearnWorlds layout changed — fasty needs to re-run the probe." |
| `LW_UNKNOWN_SUBMISSION` | "Submission not found in LearnWorlds." |
| `NHA_CSV_MISSING` | "NHA CSV missing. Drop a fresh export and try again." |
| `AUDIT_WRITE_FAILED` | "Saved in LW but couldn't write the audit log — flag fasty." |
| `NOT_IMPLEMENTED` | "Submit isn't wired up yet (selector probe pending)." |

NEVER hide a partial failure — surface failed submission IDs inline.

## PII handling (mandatory)

Chat platforms (Telegram and Slack alike) are NOT end-to-end encrypted for bot conversations — messages sit on the platform's cloud. Minimize exposure:

- **Summary + individual cards:** first name + last initial + score + short assessment label. NEVER full email, full submission_id, or full student_id.
- **Details view is the ONLY place full PII appears.** Restore the compact card on `[← Back]` (via `edit_message`). On Telegram this is the only in-place option; on Slack `delete_message` is also available for stricter PII hygiene.
- **After every successful submit**, call `mcp__nanoclaw__delete_message(messageId=<the original decision prompt message_id>)` so the PII-bearing prompt disappears from the chat. Status/summary messages (counts only, no PII) stay.
- If `delete_message` fails (message >48h old or already gone), it's non-fatal — the tool is silent on those. Don't retry.
- Don't log PII inside `<internal>` tags either — internal logs persist on the host.

## Don't

- Don't run `fetch-pending` more than once per request (cache handles repeats).
- Don't write to LW without an explicit Monica tap (Interactive invariant).
- Don't include full emails / submission_ids in any message except the on-demand Details view.
- Don't skip the post-submit `delete_message` call — PII hygiene is a policy requirement, not a nice-to-have.
- Don't reply in any language other than English.

## Idempotency on double-tap

Before submitting, check if `session_state.decisions[short_id].acted_at` is set. If yes, ignore silently. Otherwise, set it AFTER the submit completes (success or error) and persist.
