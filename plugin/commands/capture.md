---
description: Turn the work discussed in this session into tasks on the Kelvia board
---

Take what this session actually produced and put it on the board, so it survives
the session ending.

1. Re-read the conversation and list, for yourself, the work that came out of it:
   things done, things deliberately left undone, follow-ups discovered along the
   way, and problems found but not fixed.

2. Drop anything already on the board. Check with `list_tasks` before filing —
   duplicates are the fastest way to make a board useless.

3. Show the user the proposed tasks as a short list, with the column each would
   land in, and ask them to confirm or cut. Do not file first and apologise after.

4. On confirmation, create them with `create_task`. Titles state the outcome;
   descriptions carry the reasoning and any reproduction steps from this session.

5. For work that was finished during the session, file it in the done column and
   log the time with `add_task_worklog` if the session makes the duration clear.
   If it does not, leave the time off rather than guessing.

Argument, if the user supplied one, narrows the scope: `$ARGUMENTS`
