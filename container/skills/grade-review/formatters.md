# Message Templates — grade-review

These are the exact shapes the agent should produce. The format works on
both channels (Telegram parse_mode='Markdown' V1 + Slack mrkdwn share most
of their syntax):

- `*bold*` (single asterisks) — bold on both channels
- `_italic_` (single underscores) — italic on both channels
- `` `code` `` and ``` ``` `` triple-backtick fences ``` `` ``` — verbatim on both
- `•` for bullets (Unicode, both render)
- `[text](url)` — Telegram-only; the Slack channel auto-translates to `<url|text>`
- AVOID `##` heading markers — show literally on both
- AVOID `**bold**` (double asterisks) — Telegram V1 shows literal asterisks;
  defensive translation in the Slack channel converts to `*bold*`, but emit
  single-star directly to be safe

PII rule: **first name + last initial + assessment shortcode** in summary lines. NEVER full email or full student ID. Reserve full PII for `[Details]` and delete on Back.

## Grouped summary (response to `/review`)

When `bot_cli.py fetch-pending` returns N decisions, render this:

```
*Pending Review — N submissions*

✓ Approve (X) — scores match
• Maria R. · 87 · Anatomy
• Juan S. · 92 · Pharm
• ... and (X-2) more

✎ Correct (Y) — small discrepancy
• Priya K. · 85→87 · Phlebotomy
• ...

✗ Bounce (Z) — not completed / no NHA record
• Tom B. · 0 · CCMA Final
• ...

? Needs Review (W)
• Anna L. · ? · Anatomy (no NHA match)
• ...
```

Then send buttons in this layout (one keyboard, per `mcp__nanoclaw__send_message_with_keyboard`):

```
[ ✓ Confirm all X ]   [ Review individually ]
[ ✎ Confirm all Y ]   [ Review individually ]
[ ✗ Confirm all Z ]   [ Review individually ]
[ Review needs_review individually (W) ]
[ End session ]
```

Map button → `callback_data`:
- `b:approve:K1`  / `r:approve:K1`
- `b:correct:K2`  / `r:correct:K2`
- `b:bounce:K3`   / `r:bounce:K3`
- `r:needs_review:K4`  (no bulk for needs_review)
- `end`

Where `K1..K4` are session-scoped tokens you generate (e.g. `K1`, `K2`...) and map to the list of submission_ids in that group inside `session_state.json`.

### Length / button limits

- Message body ≤ 4000 chars (Slack section blocks are 3000 — channel layer auto-truncates with a `_…[N chars truncated]_` suffix). If summary > 2900 chars, drop the per-student bullets after first 3 per group, replace with `... and (N) more`.
- Inline keyboard ≤ 100 buttons (Telegram cap; Slack's actions block holds 25 per row — use multiple rows). Above 100 total, split into multi-message: one message per group, each with its own `[Confirm all] [Review individually]` pair.

## Individual review card

When operator chooses `[Review individually]` OR opens a single-submission flow, render one card per submission:

```
*Review — Maria R.*
Assessment: Anatomy & Physiology
Reported: 85  ·  NHA: 87  ·  Diff: 2

_Suggested: Correct (small discrepancy)_

Reason: Discrepanta mica (85 → 87, diff=2.0)
```

Buttons (per `mcp__nanoclaw__send_message_with_keyboard`):

```
[ ✓ Approve ]  [ ✎ Correct ]  [ ✗ Bounce ]
[ ⏭ Skip ]     [ ℹ Details ]
[ ← Back to summary ]
```

Map button → `callback_data`:
- `a:<short_id>` / `c:<short_id>` / `x:<short_id>` / `s:<short_id>` / `d:<short_id>` / `back:summary`

The skip action does NOT call `bot_cli.py submit` — just removes from current queue, leaves it pending for next /review. Edit the message to `_Skipped — will return next /review_`.

## Details view (after `[ℹ Details]`)

Replace the individual card text with full PII (only here):

```
*Maria R. — full details*
Email: maria.r@student.edu
Student ID: 689e...
Course: healthcare-fundamentals
Assessment ID: 67ab...
Assessment Name: Anatomy and Physiology
Submitted at: 2026-04-22 14:30 EEST
Reported score: 85
NHA score: 87 (attempt #2)
Match confidence: 0.92
Decision reason: Discrepanta mica
```

Buttons:
```
[ ← Back ]
```
On `[← Back]`, edit message back to the compact card above. **Then `mcp__nanoclaw__send_message` with `text=""` is NOT how you delete** — instead, edit the message to remove PII content via `edit_message`. (Both channels support `delete_message` for stricter PII hygiene if needed: Telegram has a 48h window, Slack accepts any age for bot-owned messages.)

## After action — status edit + PII cleanup

Two steps, in this order:

**1. Edit** the original message to a compact status line (counts only, no PII) and `keyboard: null` so buttons disappear. Example status texts below.

**2. Delete** the original decision prompt by calling `mcp__nanoclaw__delete_message(messageId=<original_msg_id>)`. This removes the PII-bearing content from the chat. If the delete fails (>48h / already gone), the edit from step 1 is our fallback — the chat stays tidy.

The session-close summary and error/status messages have no PII, so they stay.

### Example status texts

Bulk:
```
✓ Approved 12/14 — 2 errors

Errors:
• 7f3a — LW_SUBMIT_TIMEOUT (retry available)
• 9d1c — LW_DOM_CHANGED (fasty must re-probe)
```
Pass `keyboard: null` to remove buttons.

Individual:
```
✓ Approved Maria R. — score 85
```
Pass `keyboard: null`.

## Progress message during long ops

If a bulk submit will take more than ~5 seconds, edit the message in-flight:

```
⏳ Processing 3/14...
```

Then on completion replace with the final status edit.

## Session-close summary

Trigger when: `/end` from Monica, `[End session]` tap, no more pending after a bulk, or 5 min idle.

```
*Session complete*
✓ Approved: 32
✎ Corrected: 11
✗ Bounced: 3
⏭ Skipped: 1
⚠ Errors: 0
Duration: 4m 12s
```

If errors > 0:

```
*Session complete*
✓ Approved: 32
✎ Corrected: 10
✗ Bounced: 3
⏭ Skipped: 1
⚠ Errors: 1

Errors:
• 9d1c — LW_DOM_CHANGED
```

Send via `mcp__nanoclaw__send_message` (plain message, no keyboard needed).

## Empty queue

When `fetch-pending` returns count=0:

```
No pending submissions right now. Try again later.
```

No keyboard.

## Error response (fetch-pending failed)

If fetch-pending returns success=false, format per the SKILL.md error mapping:

```
⚠ Couldn't fetch pending submissions.

Reason: <plain English from error code map>
Detail: <error_detail truncated to 200 chars>

Run /review again once the issue is fixed.
```
