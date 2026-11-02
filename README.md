# Invictus 52111A Scouting – Netlify version

## Put it online (about 10 minutes)
1. Make a free GitHub repo and upload everything in this folder (keep the folders as they are: `public/`, `netlify/functions/`, `netlify.toml`, `package.json`).
2. On netlify.com: **Add new site → Import an existing project → GitHub**, pick the repo, and press Deploy. The settings come from `netlify.toml`.
3. In Netlify: **Site configuration → Environment variables**, add two:
   - `TEAM_CODE` = a code your team will type to get in (pick something not guessable)
   - `ROBOTEVENTS_KEY` = your VEX Events API key (mark it as secret)
4. **Deploys → Trigger deploy** so the variables take effect.
5. Open your Netlify link on your phone, enter the team code, then on the Event tab type your event code (e.g. RE-V5RC-26-5068) and press **Import / update now**.

## Live updates
Always on. While the page is open it checks for teammates' changes every second and VEX Events every 5 seconds (change NOTE_MS and RE_MS near the top of the script in public/index.html to slow it down). Nothing runs when nobody has the page open.
