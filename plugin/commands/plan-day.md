---
description: Build today's plan in Kelvia from what the board actually holds
---

Turn the board into a realistic plan for today.

1. Check what is already planned: `list_daily_plan_blocks` for today, and
   `list_overdue_daily_plan_blocks` for what slipped from earlier days. Never
   plan over existing blocks without saying so.

2. Read the board with `list_tasks` and pick candidates: what is in progress,
   what is due, what is blocking someone else.

3. Propose the plan as a list of time blocks before creating anything. State how
   long each will take and why that task made the cut. Ask the user to adjust.

4. On confirmation, create the blocks with `create_daily_plan_block`.

Rules for the plan itself:

- Leave gaps. A plan with no slack fails at the first interruption, and then the
  whole plan gets abandoned rather than adjusted.
- Do not schedule more hours than remain in the working day.
- Overdue blocks are a signal, not a backlog to re-add wholesale. Ask before
  carrying them forward — some of them should be dropped instead.

If `$ARGUMENTS` names a date or a focus, plan for that instead of today's default.
