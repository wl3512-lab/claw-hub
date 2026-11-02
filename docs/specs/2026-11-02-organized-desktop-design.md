# Organized desktop: job board, tanks, scheduled crabs, logbook, iMessage

Approved 2026-11-02. Built in this order; each part reuses the one before.

## 1. Job board
- Jobs live in `data/jobs.json`: `{id, title, prompt, group, cwd, skill, status, queue, schedule, sessionId, runs[], createdAt}`.
- `status`: todo → running → done. `queue: true` starts it automatically when its project has no working crab.
- Corkboard panel beside the pen. Drag a note onto a crab: hub crab gets the prompt as a message; terminal/VS Code crab gets it copied to the clipboard and is jumped to. Drag onto "hire a crab" (or press ▶) to start a new hub chat in the job's folder.
- Prompt sent: terse `/skill task: … dir: …` form.
- A run is done when its chat finishes a turn (status busy → idle).

## 2. Tanks per project
- Tabs above the pen: all · each project (existing groups) · + project.
- A tank shows only its crabs, its job notes and its tips. Crabs without a project only appear in "all".

## 3. Scheduled crabs
- A job can repeat: daily, weekdays, or chosen weekdays at HH:MM (local time).
- The server checks every 30 s; a due job starts a hub chat. Scheduled runs close their process after the first reply (the transcript stays), so daily jobs don't pile up open sessions.

## 4. Daily logbook
- Built locally from transcripts (no tokens): per day, every chat that was active, its project, what you asked, its last reply (short), and whether it ended waiting on you, stuck, or done.
- Saved to `data/logbook/YYYY-MM-DD.json` at 23:30 and on demand; "logbook" tab browses days.

## 5. iMessage pings + replies
- Settings: your iMessage handle (phone or Apple ID email). Pings when a crab asks you something or finishes: `[claw] #3 portfolio hero: <one line>`.
- Replies are read from `~/Library/Messages/chat.db` (needs Full Disk Access for node). `#3 text` answers crab 3; a plain reply goes to the last crab that pinged. Only hub crabs can receive replies; others get a "reply in the hub" ping back.
