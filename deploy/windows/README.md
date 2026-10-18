# Windows startup files

These files support the local `D:\deepseek` installation. Copy `start-bot.bat`, `autostart.bat`, and `dsh-run.ps1.template` to `D:\deepseek`, renaming the last file to `dsh-run.ps1`.

Set the Windows user environment variable `DEEPSEEK_API_KEY` to the key used by the local model proxy. The key is intentionally not stored in this repository. If DSH's Node runtime is installed in a non-default location, set `DSH_NODE_EXE` to its full path.

Double-click `start-bot.bat` to start the services. Windows will ask for administrator permission when SnowLuma needs to inject into QQ. Complete QQ login in the elevated window. `autostart.bat` is the Task Scheduler entry point and expects an interactive user session for QQ injection.

The launcher checks service ports before starting components and checks the `QQBridge` window title to avoid starting a second bridge watchdog. DSH output is written to `D:\deepseek\logs\dshweb.out` with shared read access so the bridge can read its refreshed token while DSH is running.
