# command-center-dashboard

DCF Command Center - live read-only mirror of the second-brain vault

## What is in here

- **`index.html`** — the Command Center. Regenerated from the vault by the
  auto-update job, so it is not hand-edited; changes made here are overwritten
  on the next run.
- **`jarvis.html`** — J.A.R.V.I.S. mission control. A HUD you talk to out loud,
  showing the one number that matters plus what the agents are doing. Runs on
  mock data on day one and on real data field by field after that.
- **`agents/`** — the three agent prompts behind it: the Scout (gathers), the
  Operator (works), the Advisor (decides), plus the FAQ file that bounds what
  the Operator may answer on its own.
- **`JARVIS.md`** — how the pieces fit, the build order, and the rules that
  keep it safe.

Open `jarvis.html` in a browser to use it. Serve the folder over http
(`python3 -m http.server`) if you want it to pick up live data from
`data/jarvis-data.json`.
