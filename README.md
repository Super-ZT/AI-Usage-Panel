# Usage Panel

Usage Panel is a local, read-only dashboard for AI coding usage. It reads token
counters and model identity from supported command-line tool logs, then shows
quota, token categories, and an OpenRouter-equivalent estimate.

The customer package contains only the desktop client. Server administration,
database migrations, backups, deployment tooling, and private infrastructure
are deliberately excluded.

## Install on Windows 10 or 11 (64-bit x64)

Supported customer installs are **Windows 10 x64 and Windows 11 x64**. The
packaged application is a self-contained **win-x64** build. Windows 10 on ARM
is not supported. Windows 11 on ARM may run it only through x64 emulation;
that path is not a first-class support claim for 1.0.3.

1. Open the [latest Usage Panel release](https://github.com/Super-ZT/AI-Usage-Panel/releases/latest).
2. Download `UsagePanel-Setup-<version>.exe` — not the source archive.
3. Double-click the installer and follow the prompts.
4. Open **Usage Panel** from the Desktop or Start Menu.
5. If asked, create a one-time link code at
   <https://super-zt.com/portal/usage-panel> and paste it into the app.

The installer includes its own Node.js runtime, a self-contained Windows
application host, and Microsoft’s small Edge WebView2 Evergreen bootstrapper
(installed only when the runtime is missing). It creates Desktop and Start Menu
shortcuts through the signed-in user’s shell folders (including OneDrive-managed
Desktop paths) and adds a normal Windows uninstaller. Customers do **not**
install Node.js or .NET and do not use a terminal.

Upgrading from public v1.0.2 installs directly over the existing folder: the
installer stops only Usage Panel-owned processes for that install, removes the
obsolete hidden launchers (`open-panel.cmd`, `open-panel.vbs`,
`start-hidden.vbs`), clears a stale stop marker, and refuses a half-upgrade when
files are locked. Safe enrollment state under `%APPDATA%\usage-panel\` is
preserved. Closing the Usage Panel window fully exits Usage Panel-owned
processes; monitoring resumes the next time you open the app.

Version 1.0.3 is unsigned, so Windows SmartScreen may show **Unknown
publisher**; compare the download against the published `.sha256` file if you
want to verify its bytes. If the embedded browser runtime is still missing after
install, install Microsoft Edge WebView2 from Microsoft and reopen Usage Panel.

## Safety boundaries

- The dashboard and optional capture proxy bind to `127.0.0.1` by default.
- Prompts, completions, source code, project paths, API keys, and raw provider
  session/request identifiers are never uploaded.
- Fleet sync is opt-in and sends only device label/platform, model identity,
  token categories, timestamps, and local event identifiers.
- Public plaintext HTTP is refused. Use HTTPS for a remote collector. The
  `--allow-insecure` enrollment flag exists only for loopback or isolated
  laboratory endpoints; never use it across a public or untrusted network.
- The client does not run Claude or Grok commands, perform speed-test downloads,
  administer servers, create account links, enroll other devices, or revoke them.

## Advanced source install

The source archive remains available for developers. It requires Node.js 18 or
newer; the client has no production package dependencies.

### Run locally from source

```bash
npm start
```

Open <http://localhost:8899>.

The immutable bundled defaults are in `config.example.json`. To customize local
paths or enable the loopback capture proxy, copy only the settings you need into
the operating-system user configuration directory:

| Platform | User configuration |
|---|---|
| Windows | `%APPDATA%\usage-panel\config.json` |
| macOS | `~/Library/Application Support/usage-panel/config.json` |
| Linux | `$XDG_CONFIG_HOME/usage-panel/config.json` or `~/.config/usage-panel/config.json` |

The package template is never modified at runtime.

## Detection and token capture

Supported tools are detected from their executable and standard data directory.
Current signatures cover Claude Code, OpenAI Codex, Grok Build, Gemini CLI,
Kimi, OpenCode, pi, CodeRabbit, Hermes, Agent Zero, and Cursor.

For tools that do not persist served model/token facts, the optional capture
proxy records those facts from provider responses. Enable `proxy.enabled` in
the user config and point the tool at:

```text
http://127.0.0.1:8898/<harness>/<provider>/v1
```

Credentials pass through to the selected upstream but are not logged, stored,
or added to usage events.

## Link this computer

The Windows app prompts on first launch when the computer is not yet linked.
Create a one-time code at <https://super-zt.com/portal/usage-panel>, paste it
into the prompt, and choose **Link computer**. Enrollment goes only to the fixed
Super ZT HTTPS endpoint, and the one-time code is piped through standard input
rather than exposed in the process command line. After linking, the prompt says
**Linked. Opening Usage Panel...**, closes without a second confirmation, and
opens the main dashboard automatically. This also applies when linking from the
Start Menu shortcut.

Version 1.0.3 replaces the hidden script-and-browser launcher with a real
Windows application window. The app stays visible while the local dashboard
starts and shows a plain-English error if a child process fails. Its bounded
diagnostic file records only fixed startup status names and timestamps; it never
records account names, local paths, one-time codes, credentials, prompts,
tokens, raw exception text, or server/ops content.

Advanced source installs can perform the same enrollment non-interactively:

```bash
usage-panel enroll --endpoint https://super-zt.com/api/usage-panel --code-stdin --label reception-pc < enrollment-code.txt
```

The returned upload-only credential and assigned device identity are written to
protected per-user data storage, outside the repository and npm package:

| Platform | Protected enrollment state |
|---|---|
| Windows | `%APPDATA%\usage-panel\enrollment.json` |
| macOS | `~/Library/Application Support/usage-panel/enrollment.json` |
| Linux | `$XDG_DATA_HOME/usage-panel/enrollment.json` or `~/.local/share/usage-panel/enrollment.json` |

On POSIX systems the directory is mode `0700` and the file is mode `0600`.
Neither the credential nor device identity is printed.

## Accuracy labels

- Native task counters are exact only when the required model and token fields
  exist.
- Missing token categories remain partial; missing model identity remains
  unknown and is not priced with a fallback.
- Costs are OpenRouter-equivalent catalogue estimates, not subscription bills.
- Provider account windows stay separate from task rows.
- Codex cache-read and cache-write counters are split from inclusive input.

## Tests

Repository maintainers run the full suite against a disposable PostgreSQL
database because it also protects the separately maintained server source:

```bash
TEST_DATABASE_URL='postgresql://postgres@127.0.0.1/usage_panel_disposable' npm test
npm run accuracy:codex
```

The repository-only release gate runs those checks, both dependency audits,
and a second real archive build and extraction:

```bash
TEST_DATABASE_URL='postgresql://postgres@127.0.0.1/usage_panel_disposable' \
  sh scripts/release-safety.sh
```

The release test builds the actual npm archive, enrolls with sentinel values in
isolated per-user directories, and rejects credentials, private metadata,
server/operations files, or side-effecting customer behavior.

## Public repository history

Publish only a fresh or squashed history made from the approved sanitized tree.
Do not expose this private development repository's ancestors: earlier commits
contain account metadata that is intentionally absent from the release tree.

## License

MIT
