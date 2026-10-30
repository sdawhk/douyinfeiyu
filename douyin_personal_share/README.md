# Douyin personal recommendation sharing

Standalone Python tool for reading the logged-in account's recommendation feed and optionally sharing canonical video links to one configured Douyin user.

## Setup

```powershell
cd D:\deepseek\repo\douyin_personal_share
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item config.example.json config.json
```

The tool uses installed Microsoft Edge (`channel="msedge"`) and does not need a downloaded browser. `tzdata` supplies the Singapore timezone database on Windows. Browser temporary files go into ignored `playwright-temp/`; set `DOUYIN_PLAYWRIGHT_TEMP` to use a different directory. If Edge is unavailable, install Chromium and change the launch channel in `douyin_share.py` to `"chromium"` after running `playwright install chromium`.

Fill `recipient_profile_url` with the user's profile URL and `recipient_handle` with the exact visible Douyin ID. A Douyin ID can differ from the opaque token in the profile URL; the tool never treats them as interchangeable. No credentials or recipient details belong in tracked files. The example values are blank.

Run `python douyin_share.py --login`, complete login manually in the visible browser, then press Enter in the terminal. The persistent browser profile is stored in `browser-profile/`. Run `python douyin_share.py --verify-recipient` to check the configured Douyin ID on the profile, open the matching chat without sending, and create a local verification marker. Then run `python douyin_share.py` to inspect candidate recommendations in dry-run mode.

Sending requires the verification marker to match the configured profile URL and handle. Scheduled sends also obey `daily_max` (default 5, maximum 5). Before every send, the tool opens the configured profile, confirms its visible Douyin ID, opens the message inbox, and selects the unique conversation whose display name matches that verified profile. It then checks the visible conversation editor and the unique send control. If a check fails, it stops. Each attempted video is saved before clicking Send, so an ambiguous result cannot be retried automatically; inspect the conversation and local `state.json` before clearing an attempt. Each message contains the video's canonical link and a short neutral note derived from its title. Attempted video URLs are deduplicated in `state.json`.

`run_daily.ps1` invokes `--scheduled`. The local Windows task `DaFeiYu-DouyinShare` checks every 15 minutes from 09:00 to 23:00 Singapore time. It opens Edge only when one of five saved random daily slots is due, and sends at most one video per slot. The task runs only while the Windows user is logged in and ignores overlapping launches so it can use the visible Edge profile safely. Manage it in Windows Task Scheduler under Task Scheduler Library.

The tool persists five randomly chosen Singapore local times per day, one in each window: 09:00–11:30, 11:30–14:00, 14:00–17:00, 17:00–20:00, and 20:00–23:00. Each poll launches Edge only when a pending time is due. It accepts a run up to 25 minutes late; older missed slots are marked skipped. At most one item is attempted per slot. A slot is recorded as attempted before Edge opens, so failures and ambiguous sends consume that slot and are not retried. The persisted plan is in `state.json`.

The collector selects the first eligible video cards in feed order, requires a title and canonical `/video/<id>` URL, avoids duplicate URLs, and prefers distinct authors. It does not rank or infer personal interests. Before enabling scheduled sends, verify the logged-in account and recipient inbox with the manual setup commands; Douyin can still change its page markup. An unrecognized layout fails closed. Use only with an account and recipient you control and in accordance with Douyin's terms.

Douyin's official mini-program documentation lists the proactive message API scope as `im.direct_message` and says the mini-program operator must apply for the capability in the developer console: [Private and group messaging overview](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/tutorial/open-capabilities/management/private-domain/private-and-group-message). This module uses the visible website UI and does not call that API.

## State and safety

`state.json` contains attempted and confirmed video URLs plus per-day counts. The browser profile contains account session data; keep both local and out of source control. Dry-run is the default. No real messages are sent by the included tests.
