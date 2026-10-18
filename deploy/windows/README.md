# Windows startup files

These files support the local `D:\deepseek` installation. Copy `start-bot.bat`, `autostart.bat`, `model-pool-proxy.mjs`, and `dsh-run.ps1.template` to `D:\deepseek`, renaming the last file to `dsh-run.ps1`.

The model proxy tries the requested model first, then the configured free models after quota/rate-limit errors, unavailable-model responses, network timeouts, and upstream 408/425/5xx responses. Each upstream attempt defaults to 30 seconds, with a 4-minute total fallback budget (`UPSTREAM_TIMEOUT_MS` and `MODEL_FALLBACK_BUDGET_MS` can override these limits). The QQ bridge waits up to 4 minutes 30 seconds before reporting a failed reply.

Proactive balance-threshold switching is not enabled. OpenRouter's credits endpoint requires a separate management key; the local deployment currently has no management key configured.

Set the Windows user environment variable `DEEPSEEK_API_KEY` to the key used by the local model proxy. The key is intentionally not stored in this repository. If DSH's Node runtime is installed in a non-default location, set `DSH_NODE_EXE` to its full path.

Double-click `start-bot.bat` to start the services. Windows will ask for administrator permission when SnowLuma needs to inject into QQ. Complete QQ login in the elevated window. `autostart.bat` is the Task Scheduler entry point and expects an interactive user session for QQ injection.

The launcher checks service ports before starting components and checks the `QQBridge` window title to avoid starting a second bridge watchdog. DSH output is written to `D:\deepseek\logs\dshweb.out` with shared read access so the bridge can read its refreshed token while DSH is running.

When an upstream request reports exhausted credits, quota/rate limits, or an unavailable model, the local model-pool proxy tries the configured free models in order. This reacts to an upstream error; checking a balance threshold in advance requires a provider management key and a configured threshold. Keep `keys.json` local and do not commit it.
