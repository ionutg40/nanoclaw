# Callback Routing — grade-review

Keep `callback_data` ≤ **64 bytes**. Telegram's hard cap; Slack accepts up to 255, but using one budget keeps callbacks identical across channels. Submission IDs from LearnWorlds are ~24 chars hex; once you also need an action prefix and want versioning, you're tight on room. Pattern: keep callback_data opaque + short, hold the real state in a session map.

## Encoding scheme

| Pattern | Meaning | Example |
|---|---|---|
| `b:<group>:<token>` | Bulk action on a group | `b:approve:K1` (approve all in K1's submission list) |
| `r:<group>:<token>` | Switch the group to individual review mode | `r:correct:K2` |
| `<a>:<short_id>` | Single-submission action — `a` (approve) / `c` (correct) / `x` (bounce) / `s` (skip) / `d` (details) | `a:7f3a` |
| `back:<short_id>` | Return from details to the per-card view | `back:7f3a` |
| `back:summary` | Return to the grouped summary | `back:summary` |
| `end` | End the session | `end` |

Group names: `approve` / `correct` / `bounce` / `needs_review`. Use these full names so the routing parser doesn't have to map abbreviations.

`short_id`: 4-6 hex chars. Generate by hashing the submission_id (e.g. `submission_id[:6]` if unique within session, else random nonce). Must be unique within the session_state.json map.

## session_state.json shape

Keep at `/workspace/group/session_state.json`. Overwrite at the start of each `/review`. Example:

```json
{
  "started_at": "2026-04-22T16:30:00+03:00",
  "decisions": {
    "7f3a": {
      "submission_id": "66328df4d332b94d8405098f",
      "decision": "approve",
      "reported_score": 87,
      "nha_score": 87,
      "student_first": "Maria",
      "student_last_initial": "R",
      "assessment": "Anatomy"
    },
    "4e2b": { ... }
  },
  "groups": {
    "K1": {
      "decision": "approve",
      "short_ids": ["7f3a", "9d1c", "..."]
    },
    "K2": {
      "decision": "correct",
      "short_ids": ["4e2b", "..."]
    }
  },
  "messages": {
    "summary": { "message_id": "12345" },
    "individuals": { "7f3a": { "message_id": "12350" } }
  },
  "counts": {
    "approved": 0, "corrected": 0, "bounced": 0,
    "skipped": 0, "errors": 0
  }
}
```

## Routing handler (pseudocode the agent should follow)

```
On callback message arrival:
  data = parse callback string
  state = load session_state.json

  match data:
    "end":
       send session-close summary
       delete session_state.json (or archive)

    "b:<group>:<token>":
       group_state = state.groups[token]
       actor = normalize_actor(trigger.sender_name)  # see SKILL.md "Actor attribution"
       for short_id in group_state.short_ids:
         dec = state.decisions[short_id]
         if dec.decision == "needs_review": continue   # never auto
         action = "approve" if dec.decision=="approve" else
                  "correct" if dec.decision=="correct" else
                  "bounce"   if dec.decision=="bounce_back" else None
         if action:
           run bot_cli.py submit --id <dec.submission_id> --action <action> --actor <actor>
                                  [--nha-score <dec.nha_score> if action=="correct"]
           tally success/error in state.counts

       edit_message(state.messages.summary.message_id, status_text, keyboard=null)

    "r:<group>:<token>":
       send first individual card from group_state.short_ids
       (queue the rest internally)

    "<a>:<short_id>":
       dec = state.decisions[short_id]
       actor = normalize_actor(trigger.sender_name)  # vezi SKILL.md
       action_map = {"a":"approve", "c":"correct", "x":"bounce"}
       if a in action_map:
         run bot_cli.py submit --id <dec.submission_id> --action <action_map[a]> --actor <actor>
                                [--nha-score <dec.nha_score> if action_map[a]=="correct"]
         edit_message(state.messages.individuals[short_id], status, keyboard=null)
       elif a == "s":
         # skip — audit row only, no LW call
         run bot_cli.py submit --id <dec.submission_id> --action skip --actor <actor>
         edit_message(state.messages.individuals[short_id], "_Skipped_", keyboard=null)
         state.counts.skipped++
       elif a == "d":
         render details view, edit message, replace keyboard with [Back]

    "back:<short_id>":
       restore the individual card view (previous text + buttons)

    "back:summary":
       restore the grouped summary view
```

## Why short_ids and not the real submission_id?

- A LearnWorlds submission_id is 24 hex chars. With the `a:` prefix it's already 26 chars — fits in 64 bytes, but no room for versioning, group identifiers, etc.
- Stable opaque IDs let us version the encoding later (e.g. `v2|a|7f3a` for next round) without growing payload.
- Easier to render in logs ("a:7f3a" reads cleaner than the full hex).
- Random nonces avoid revealing submission_id patterns to anyone who inspects bot traffic.

## Idempotency

If Monica double-taps the same button before the first call finishes:
1. The first callback triggers `submit` + `edit_message` (which removes the keyboard).
2. The second callback hits a message with no keyboard. Both Telegram and Slack will let the second tap go through; ack is already auto-handled by the channel layer.
3. In the agent, on every callback, FIRST check if `state.decisions[short_id].acted_at` is set. If so, ignore and reply silently — don't re-submit.

Set `state.decisions[short_id].acted_at = now()` AFTER the submit completes (success or error). This guards against duplicate writes.
