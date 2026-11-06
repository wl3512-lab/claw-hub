# claw hub

A local dashboard for people who work with Claude Code in the terminal. See what every agent is doing, jump back to its terminal, and close completed sessions you forgot about. Conversations stay saved so you can resume them later. Runs only on `127.0.0.1:4777`.

Monitoring is passive by default: opening the dashboard does not launch Claude calls.

- **room**: a pixel playpen of hermit crabs, one per running session. Crabs type at desks, read in the library, come to the gate when they have a question, and sleep in their shells on the shell beach. Subagents hatch as baby crabs named after their task.
- **chats**: every past conversation (Terminal, VS Code, Claude app) as chat bubbles, with search, projects, pins and notes.
- **chat inside the hub**: start or continue chats without a terminal; attach images; enhance a chat with one of your saved skills. Hub chats run detached and survive server restarts.
- **job board + tanks**: sticky-note tasks you drag onto a crab (or the floor to hire one), repeating schedules, and a tab per project.
- **logbook**: a daily page of what every crab did, built locally from transcripts.
- **session cleanup**: tidy completed sessions after 30 minutes idle, or opt into automatic closure after 15, 30 or 60 minutes. Working sessions, questions and unfinished helpers stay open.
- **iMessage**: crabs text you when they finish or ask something; reply to answer (needs Full Disk Access for node to read replies).

## Run

```sh
node server.js            # then open http://127.0.0.1:4777
./tools/make-app.sh       # builds ~/Applications/Claw Hub.app, the menubar crab, and login services
```

No dependencies. Reads `~/.claude/projects` and `~/.claude/sessions`; your own labels and uploads live in `data/` (not committed).

## Leave fewer sessions running

Open **settings → session cleanup** and choose an auto-close timer. It starts off. The hub checks every 30 seconds and only closes terminal or hub sessions with a confirmed completed reply and no pending work. Editor and phone sessions stay open. If Claude's state is unclear, the session stays open.

**Tidy up** in the crew list closes eligible sessions idle for at least 30 minutes. Each session is checked again before closing, so a session that resumed work is skipped. Closing Claude returns you to your terminal shell; it does not close the terminal window or delete the transcript. Use **open in terminal** on a saved chat to resume it.

An open terminal is not itself a usage charge, but background features can make model requests while a session is idle. See [Claude Code's background token usage](https://code.claude.com/docs/en/costs#background-token-usage). Cleanup limits how long forgotten sessions remain running; it is not a billing cap.

The usage meter uses cached reports from your hub chats and shows when the last report arrived. It never makes a Claude call just to refresh itself. AI nicknames and overlap suggestions are optional in settings and use Claude credits when enabled. Existing cached names remain available with the option off. Starting chats, sending messages and running jobs still use Claude as usual.

## Verify changes

Use Node.js 24 or later:

```sh
node --test test/*.test.js
```

The tests use temporary homes and fixture processes, not your sessions or Claude account. They cover passive monitoring, cleanup guards, timer closure, transcript preservation and child-process shutdown. The timer test takes about 30 seconds. GitHub Actions runs the same tests on macOS.
