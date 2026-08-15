---
description: Connect this project to a Kelvia board and confirm the connection works
---

Connect the user to Kelvia and leave them with a board they can use.

1. Call `get_current_user`. If it fails with an authorization error, the OAuth
   flow has not completed — tell the user to approve the Kelvia connection in the
   browser window Claude Code opens, then run this command again. If no window
   appeared, point them at `/mcp` to reconnect the `kelvia` server.

   If they do not have an account yet, they need a free one at
   https://kelvia.app — signing up takes an email address and nothing else.

2. Call `list_boards`. Report what they have, briefly.

3. If they have no boards, offer to create one with `create_board` and ask what
   it should be called. Do not create it unasked.

4. If they have boards, ask which one this project should default to, and
   remember the answer for the rest of the session.

5. Show them one thing that works — read the board's columns with
   `list_board_columns` and describe the workflow it encodes, so they can see the
   connection is live rather than being told it is.

Keep this short. It is a setup command, not a tour.
