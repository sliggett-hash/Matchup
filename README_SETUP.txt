MATCH-UP LIVE LEADERBOARD V5
============================

WHAT THIS VERSION DOES
----------------------
1. Keeps the Competition V4 scoring.
2. Adds a shared leaderboard visible to every Chromebook.
3. The browser never submits a score number that the server trusts.
   The Cloudflare Worker recalculates the official score itself.
4. Today's #1 score stays until the date changes in America/Detroit.
5. Places 2-10 expire after 30 minutes.
6. When today's champion is beaten, the old champion gets a fresh
   30-minute life on the live board.
7. The all-time record persists permanently.
8. Students submit only a display name such as "Emma R."
9. The leaderboard refreshes every 20 seconds.

FILES
-----
index.html       GitHub Pages game
worker.js        Cloudflare Worker API
schema.sql       D1 database tables
wrangler.jsonc   Cloudflare Worker configuration

IMPORTANT
---------
The game itself will still work before the leaderboard backend is connected.
The page will show a warning that the leaderboard backend is not connected.

PART A — CREATE THE CLOUDFLARE D1 DATABASE
-------------------------------------------
This assumes Node.js/npm is available on your computer.

1. Put worker.js, schema.sql, and wrangler.jsonc in one folder.

2. Open Terminal in that folder.

3. Install Wrangler if necessary:
   npm install -D wrangler

4. Sign in:
   npx wrangler login

5. Create the database:
   npx wrangler d1 create matchup-leaderboard

6. Cloudflare will print a database ID.
   Open wrangler.jsonc and replace:

   PASTE_D1_DATABASE_ID_HERE

   with that database ID.

7. Create the database tables:
   npx wrangler d1 execute matchup-leaderboard --remote --file=./schema.sql

PART B — DEPLOY THE WORKER
---------------------------
1. From the same folder run:

   npx wrangler deploy

2. Wrangler will print a URL similar to:

   https://matchup-leaderboard.YOUR-SUBDOMAIN.workers.dev

3. Test it in a browser by adding /health:

   https://matchup-leaderboard.YOUR-SUBDOMAIN.workers.dev/health

   You should see JSON containing:
   "ok": true

PART C — CONNECT THE GAME TO THE WORKER
----------------------------------------
1. Open index.html.

2. Near the beginning of the JavaScript find:

   const LEADERBOARD_API = "PASTE_YOUR_WORKER_URL_HERE";

3. Replace only PASTE_YOUR_WORKER_URL_HERE with your Worker URL.
   Do NOT add a slash at the end.

   Example:

   const LEADERBOARD_API =
     "https://matchup-leaderboard.example.workers.dev";

4. Save index.html.

PART D — UPDATE GITHUB
----------------------
1. Open:
   https://github.com/sliggett-hash/Matchup

2. Replace the existing root-level index.html with this new index.html.

3. Commit the change.

4. Wait for GitHub Pages to deploy.

5. Test:
   https://sliggett-hash.github.io/Matchup/?v=5

6. Confirm you see:
   LIVE LEADERBOARD • V5

PART E — SCHOOLOGY
-------------------
Keep using the GitHub Pages address as the Schoology Link:

https://sliggett-hash.github.io/Matchup/?v=5

The leaderboard is part of the same page, so students do not need another link.

EXPIRATION RULES
----------------
Today's champion:
- Remains visible for the current America/Detroit calendar day.
- Disappears the next time the leaderboard is requested after midnight.

Places 2-10:
- Expire 30 minutes after submission.
- If today's champion gets beaten, that former champion is given a fresh
  30-minute expiration.

All-time record:
- Stored separately and never expires.

PRIVACY
-------
This build is intentionally designed to store only:
- first name + last initial (display name)
- score/game performance
- timestamps

It does not require student email addresses, IDs, cookies, or Schoology login data.

ANTI-CHEATING
-------------
The browser does NOT tell the Worker "my score is 9,000,000."

Instead:
- the Worker starts a run using server time,
- the browser sends the sequence of attempted matches at the end,
- the Worker validates the ten real matches,
- the Worker calculates mistakes, streaks, accuracy, exact elapsed time,
  and the final score itself.

This blocks simple score editing in Chrome Developer Tools.

It is not intended to be cryptographically cheat-proof against a student
who reverse-engineers the API, but it is substantially stronger than
trusting a score value from the browser.

VERY FAST RUNS
--------------
Runs under 5 seconds are marked ineligible for the leaderboard. The game
still finishes normally. This is a basic safeguard against automated score
submissions.

TEACHER NOTE
------------
If you later want it, an admin page can be added so you can:
- remove an inappropriate name,
- reset the all-time record,
- clear the live board,
- download scores as CSV.
