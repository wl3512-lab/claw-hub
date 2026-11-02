# claw hub

A local dashboard for every Claude Code session on this Mac. Runs only on `127.0.0.1:4777`.

- **room**: a pixel playpen of hermit crabs, one per running session. Crabs type at desks, read in the library, come to the gate when they have a question, and sleep in their shells on the shell beach. Subagents hatch as baby crabs named after their task.
- **chats**: every past conversation (Terminal, VS Code, Claude app) as chat bubbles, with search, projects, pins and notes.
- **chat inside the hub**: start or continue chats without a terminal; attach images; enhance a chat with one of your saved skills. Hub chats run detached and survive server restarts.
- **job board + tanks**: sticky-note tasks you drag onto a crab (or the floor to hire one), repeating schedules, and a tab per project.
- **logbook**: a daily page of what every crab did, built locally from transcripts.
- **iMessage**: crabs text you when they finish or ask something; reply to answer (needs Full Disk Access for node to read replies).

## Run

```sh
node server.js            # then open http://127.0.0.1:4777
./tools/make-app.sh       # builds ~/Applications/Claw Hub.app, the menubar crab, and login services
```

No dependencies. Reads `~/.claude/projects` and `~/.claude/sessions`; your own labels and uploads live in `data/` (not committed).
