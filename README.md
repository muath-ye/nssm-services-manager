# NSSM Services Manager

A modern Windows 11-style desktop app to start, stop and manage Windows services, powered by
[NSSM](https://nssm.cc) (the Non-Sucking Service Manager).

Built with Electron and Tailwind CSS, following Windows 11 / WinUI design: a navigation pane, Settings-style
expandable cards, toggle switches, light and dark themes, and a frameless custom title bar.

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
- [`nssm.exe`](https://nssm.cc/download) on the machine; the app asks for its location on first launch
- Administrator rights to start, stop, install or remove services. The packaged app requests elevation
  automatically.

## Install

Download the latest build from the [Releases](../../releases) page:

| File | What it is |
| --- | --- |
| `NSSMServicesManager-Setup-<version>.exe` | Installer (choose the install folder, installs for all users) |
| `NSSMServicesManager-Portable-<version>.exe` | Single-file portable version, no installation |
| `SHA256SUMS.txt` | Checksums to verify the downloads |

The builds are not code-signed, so Windows SmartScreen may show a warning on first run
(**More info → Run anyway**).

## First run

1. Start the app. It opens **Settings** and asks for the path to `nssm.exe`.
2. Click **Browse** (or paste the path) and **Save**.
3. The **Services** page opens. Use the switch on a service to start or stop it.

## Configuration

Settings are saved in `config.json` next to the executable (the folder of the portable exe, or the install
folder for the installer version):

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
logon, highest privileges). Turning the option off removes the task. This option is only available in the packaged
app, not when running from source.

## Development

Requirements: [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm start        # builds the CSS and launches the app
```

Run the terminal as administrator if you want to test starting and stopping services.

| Script | Purpose |
| --- | --- |
| `npm start` | Build the CSS and run the app |
| `npm run css` | Build `renderer/styles.css` from `src/input.css` |
| `npm run css:watch` | Rebuild the CSS on change |
| `npm run dist` | Build the installer and portable exe into `dist/` |

If `npm start` reports "Electron failed to install correctly", the Electron binary download did not finish. Run
`node node_modules/electron/install.js`, or delete `node_modules/electron` and run `npm install` again.

### Project layout

```
main.js             Electron main process: window, config, NSSM and PowerShell calls, IPC
preload.js          Safe bridge between the main process and the UI
renderer/           The UI (index.html, app.js, generated styles.css, assets/)
src/input.css       Tailwind source with the Windows 11 design tokens
tailwind.config.js  Maps Tailwind colors to the design tokens
build/icon.png      App icon used for the exe and installer
```

The UI runs with context isolation and no Node access; it talks to the main process only through the
functions exposed in `preload.js`. NSSM and PowerShell are always called without a shell, with arguments passed
as an array.

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
