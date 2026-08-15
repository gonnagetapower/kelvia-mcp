---
description: Report what changed on the Kelvia board, and who changed it
---

Give the user a standup they can read in fifteen seconds.

1. Resolve the board. If the session already settled on one, use it; otherwise
   `list_boards` and ask.

2. Read recent activity with `get_board_activity`, and the current state with
   `list_tasks`.

3. Report three things, in this order:

   - **Moved** — what changed state since the last report, and by whom. Name the
     agent when an agent did it; that distinction is the reason the feed exists.
   - **Stuck** — tasks that have not moved but should have: in progress with no
     activity, or past a due date.
   - **Next** — what the board says is next, by column order and priority. Say
     what the board holds; do not invent priorities it does not encode.

4. If something looks wrong — a task in progress for a week, a done task with no
   worklog, work attributed to an agent that the user may not have reviewed —
   say so plainly in one line. Do not soften it into a summary.

Cover the period given in `$ARGUMENTS` if there is one; otherwise since yesterday.
