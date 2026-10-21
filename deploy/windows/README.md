# Windows startup files

These files support the local `D:\deepseek` installation. Copy `start-bot.bat`, `autostart.bat`, `model-pool-proxy.mjs`, and `dsh-run.ps1.template` to `D:\deepseek`, renaming the last file to `dsh-run.ps1`. Keep this repository at `D:\deepseek\repo`: the launchers use `deploy\windows\dsh-watchdog.ps1` from that checkout.

The model proxy tries the requested model first, then the configured free models, with `trae/glm-5.3-flash` last for chat when all free routes fail or cool down. Image requests use only image-capable routes, with `trae/multimodal_image_kimi-k2.5` last. An upstream attempt defaults to 30 seconds, and the fallback budget defaults to 45 seconds (`UPSTREAM_TIMEOUT_MS` and `MODEL_FALLBACK_BUDGET_MS` can override these limits).

Proactive balance-threshold switching is not enabled. OpenRouter's credits endpoint requires a separate management key; the local deployment currently has no management key configured.

Set the Windows user environment variable `DEEPSEEK_API_KEY` to the key used by the local model proxy. The key is intentionally not stored in this repository. If DSH's Node runtime is installed in a non-default location, set `DSH_NODE_EXE` to its full path.

Double-click `start-bot.bat` to start the services. Windows will ask for administrator permission when starting the SnowLuma health watchdog. The watchdog checks the web UI and QQ login API every 15 seconds and restarts a stalled SnowLuma process after three failed checks. Complete QQ login in the desktop client if needed. `autostart.bat` is the Task Scheduler entry point and expects an interactive user session for QQ injection.

The local bot settings page is `http://127.0.0.1:18902/settings`. It manages the QQBridge group interjection cooldown and per-group switches, scheduled QQ posts, and proactive private chats. Changes are saved to `bridge/config.json` and QQBridge picks them up within about five seconds. The image library stays at `http://127.0.0.1:18902/`. The settings server only listens on localhost and never returns the OneBot or DSH credentials.

The conversation model page is `http://127.0.0.1:18902/models`. It shows the DSH default, active route, latest actual model and fallback health. Model choices come from the upstream catalog; saving probes each model with a complete streamed reply, then atomically updates `D:\deepseek\state\model-policy.json`, the DSH default, and existing QQ sessions. The chat router runs on localhost port 18903 and reads the policy for every request. The keys admin stays on port 18901. Both `start-bot.bat` and `autostart.bat` start the chat router if it is absent.

The launcher starts a single-instance DSH watchdog, which checks port 3090 every 10 seconds and restarts DSH after it exits. The bridge watchdog restarts the bridge 5 seconds after it exits. The launcher checks the `QQBridge` window title to avoid starting a second bridge watchdog. DSH output is written to `D:\deepseek\logs\dshweb.out` with shared read access so the bridge can read its refreshed token while DSH is running. Restart events are logged to `D:\deepseek\logs\dsh-watchdog.log` and `bridge.log`.

When an upstream request reports exhausted credits, quota/rate limits, or an unavailable model, the local model-pool proxy tries the configured free models in order, then the last-resort non-free route. This reacts to an upstream error; checking a balance threshold in advance requires a provider management key and a configured threshold. Keep `keys.json` local and do not commit it.
