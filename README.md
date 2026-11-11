# NSSM Services Manager

A modern Windows 11-style desktop app to start, stop and manage Windows services, powered by
[NSSM](https://nssm.cc) (the Non-Sucking Service Manager).

Built with [Neutralino.js](https://neutralino.js.org) and Tailwind CSS, following Windows 11 / WinUI design: a
navigation pane, Settings-style expandable cards, toggle switches, light and dark themes, and a frameless custom
title bar. The whole app is **a single exe of a few MB**, because it uses the WebView2 browser engine that already
ships with Windows instead of bundling its own.

## Features

- **Browse every Windows service** with live status (refreshes every 5 seconds)
- **Start, stop and restart** services with a toggle switch, using `nssm.exe`
- **Install, edit and remove** NSSM services (edit opens NSSM's own editor)
- **Expand a service** to see its description, service name, status, startup type, log-on account and executable path
- **Filter** by status, startup type (including delayed start) and log-on account, plus an "NSSM only" view
- **Search** by name, display name or description
- **Light, Dark or follow-system theme**
- **Start with Windows** option (Settings), using a Scheduled Task so it runs with administrator rights
- Keyboard shortcuts: `F5` refresh, `Ctrl+F` search, `Esc` close dialogs

## Requirements

- Windows 10 or 11 (the design targets Windows 11)
- The [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/). It is built into Windows 11 and
  already installed on almost all Windows 10 machines.
- [`nssm.exe`](https://nssm.cc/download) on the machine; the app asks for its location on first launch
- Administrator rights to start, stop, install or remove services. The app opens normally without a UAC prompt, so
  you can browse services right away. A banner offers **Restart as administrator** when you need to change something.

## Install

Download the latest build from the [Releases](../../releases) page:

| File | What it is |
| --- | --- |
| `NSSMServicesManager-<version>.exe` | The app. A single file, no installation needed |
| `SHA256SUMS.txt` | Checksums to verify the download |

Put the exe anywhere you like. The build is not code-signed, so Windows SmartScreen may show a warning on first run
(**More info → Run anyway**).

## First run

1. Start the app. It opens **Settings** and asks for the path to `nssm.exe`.
2. Click **Browse** (or paste the path) and **Save**.
3. The **Services** page opens. Use the switch on a service to start or stop it.

## Configuration

Settings are saved in `config.json` in the same folder as the exe:

```json
{
  "nssmPath": "C:\\tools\\nssm\\win64\\nssm.exe",
  "theme": "system"
}
```

`theme` is `system`, `light` or `dark`. You normally change these in the app's Settings page.

### Start with Windows

Turn on **Settings → Start with Windows** to launch the app at sign-in. Windows does not start elevated apps from
the usual startup registry key, so the app registers a Scheduled Task named `NSSM Services Manager` (trigger: at
logon, highest privileges). Turning the option off removes the task. If you move the exe, the task is updated the
next time you start the app. This option is only available in the built exe, not when running from source.

## Development

Requirements: [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run setup    # downloads the Neutralino binary and client library (once)
npm run dev      # builds the CSS and launches the app
```

Run the terminal as administrator if you want to test starting and stopping services, or use the in-app
**Restart as administrator** button.

| Script | Purpose |
| --- | --- |
| `npm run setup` | Download the Neutralino binary into `bin/` and the client library into `resources/js/` |
| `npm run dev` | Build the CSS and run the app from source |
| `npm run css` | Build `resources/styles.css` from `src/input.css` |
| `npm run css:watch` | Rebuild the CSS on change |
| `npm run build` | Build the single-file exe into `dist/` |

### Project layout

```
neutralino.config.json  App window and permission settings
resources/              The UI: index.html, app.js, api.js, assets/, icons/ (styles.css is generated)
  api.js                Bridge to Windows: NSSM and PowerShell calls, config, theme, startup task
  app.js                The UI logic
src/input.css           Tailwind source with the Windows 11 design tokens
tailwind.config.js      Maps Tailwind colors to the design tokens
scripts/build.js        Stamps the exe (icon, version info) and builds it
build/                  App icon (icon.ico and icon.png)
```

### How commands run safely

Neutralino starts commands through the shell, so values such as service names and paths are never put on a command
line. Every PowerShell script receives its data as base64-encoded variables and is itself passed with
`-EncodedCommand`, so the command line only contains base64 characters. The app's window is also limited to the few
Neutralino functions it needs (`nativeAllowList` in `neutralino.config.json`).

## Releasing

A GitHub Actions workflow ([release.yml](.github/workflows/release.yml)) builds and publishes a release when you
push a version tag:

```bash
git tag v1.2.0
git push origin v1.2.0
```

The app version is taken from the tag. Tags that contain a dash, such as `v1.2.0-beta.1`, are published as
pre-releases. If the release step fails with a permissions error, set **Settings → Actions → General → Workflow
permissions** to "Read and write".

## License

MIT
