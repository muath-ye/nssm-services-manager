/*
 * Bridge to the OS, built on the Neutralino native API. It exposes the same `api` surface the UI used under
 * Electron, so app.js does not care what is underneath.
 *
 * Security: Neutralino runs commands through the shell. To keep user-provided values (service names, paths,
 * arguments) out of any command line, every PowerShell script receives its data as base64 variables and is
 * itself passed with -EncodedCommand, so the command line only ever contains [A-Za-z0-9+/=].
 */
const api = (() => {
  const THEMES = ['system', 'light', 'dark'];
  const STARTUP_TASK = 'NSSM Services Manager';
  /**
   * Folder holding config.json: the exe's own folder when built (it can be started from any working
   * directory, e.g. by the sign-in task), or the project root under `neu run`.
   */
  const appDir = () => (packaged() ? NL_ARGS[0].replace(/[\\/][^\\/]*$/, '') : NL_PATH);
  const configFile = () => `${appDir()}/config.json`;

  /* ---------- encoding helpers ---------- */

  const toBase64 = (bytes) => {
    let binary = '';
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary);
  };
  const utf8B64 = (text) => toBase64(new TextEncoder().encode(String(text ?? '')));
  const utf16B64 = (text) => {
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      bytes[i * 2] = text.charCodeAt(i) & 255;
      bytes[i * 2 + 1] = text.charCodeAt(i) >> 8;
    }
    return toBase64(bytes);
  };

  /** Runs a PowerShell script. `vars` become $variables, passed safely as base64. */
  async function powershell(script, vars = {}) {
    const assignments = Object.entries(vars)
      .map(([name, value]) => `$${name} = V '${utf8B64(value)}'`)
      .join('\n');
    const full = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function V($s) { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
function Nssm {
  $ErrorActionPreference = 'Continue'
  $lines = & $nssm @args 2>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ }
  }
  $o = ($lines | Out-String) -replace [char]0, ''
  if ($LASTEXITCODE -ne 0) { throw $o.Trim() }
  $o.Trim()
}
try {
$ErrorActionPreference = 'Stop'
${assignments}
${script}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
    try {
      const r = await Neutralino.os.execCommand(
        `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${utf16B64(full)}`,
      );
      return { ok: r.exitCode === 0, stdout: r.stdOut.trim(), stderr: r.stdErr.trim(), code: r.exitCode };
    } catch (error) {
      return { ok: false, stdout: '', stderr: String(error.message || error), code: -1 };
    }
  }

  const result = (r, fallback) => ({
    ok: r.ok,
    message: r.ok ? r.stdout || fallback : r.stderr || r.stdout || `Failed (exit ${r.code})`,
  });

  /* ---------- config (config.json next to the executable) ---------- */

  async function readConfig() {
    try {
      return JSON.parse(await Neutralino.filesystem.readFile(configFile()));
    } catch {
      return {};
    }
  }

  const writeConfig = (config) => Neutralino.filesystem.writeFile(configFile(), JSON.stringify(config, null, 2));

  async function isFile(path) {
    try {
      return (await Neutralino.filesystem.getStats(path)).isFile;
    } catch {
      return false;
    }
  }

  const isNssmName = (path) => /nssm(\d+)?\.exe$/i.test(path);

  async function validNssmPath() {
    const { nssmPath } = await readConfig();
    return nssmPath && (await isFile(nssmPath)) ? nssmPath : null;
  }

  /** Runs `nssm <args>` with PowerShell; `vars` are exposed to `script` as $variables. */
  async function nssm(script, vars = {}) {
    const path = await validNssmPath();
    if (!path) {
      return { ok: false, stdout: '', stderr: 'nssm.exe path is not configured.', code: -1 };
    }
    return powershell(script, { nssm: path, ...vars });
  }

  /* ---------- theme ---------- */

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }

  const themeName = (config) => (THEMES.includes(config.theme) ? config.theme : 'system');

  /* ---------- run at sign-in (Scheduled Task, highest privileges) ---------- */

  /** True for the built exe (resources bundled), false under `neu run`. */
  const packaged = () => typeof NL_RESMODE !== 'undefined' && NL_RESMODE === 'bundle';

  const QUERY_TASK = `
$t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if ($t) { $t.Actions[0].Execute }`;

  const REGISTER_TASK = `
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $exe
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts NSSM Services Manager at sign-in' -Force | Out-Null`;

  const REMOVE_TASK = 'Unregister-ScheduledTask -TaskName $task -Confirm:$false';

  /** Full path of this running executable. */
  async function currentExe() {
    const r = await powershell('(Get-Process -Id ([int]$procId)).Path', { procId: NL_PID });
    return r.ok ? r.stdout : null;
  }

  async function registeredExe() {
    const r = await powershell(QUERY_TASK, { task: STARTUP_TASK });
    return r.ok && r.stdout ? r.stdout.replace(/^"|"$/g, '') : null;
  }

  const registerTask = (exe) => powershell(REGISTER_TASK, { task: STARTUP_TASK, exe });

  /** If the exe moved since the task was created, point the task at the current location. */
  async function refreshStartupTask() {
    if (!packaged()) return;
    const [registered, exe] = [await registeredExe(), await currentExe()];
    if (registered && exe && registered.toLowerCase() !== exe.toLowerCase()) {
      await registerTask(exe);
    }
  }

  /* ---------- services ---------- */

  const LIST_SCRIPT = `
@(Get-CimInstance Win32_Service | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name
    displayName = $_.DisplayName
    state = $_.State
    startMode = $_.StartMode
    delayedStart = [bool]$_.DelayedAutoStart
    startName = $_.StartName
    description = $_.Description
    path = $_.PathName
    isNssm = [bool]($_.PathName -match 'nssm')
  }
}) | ConvertTo-Json -Compress -Depth 3`;

  const ACTIONS = new Set(['start', 'stop', 'restart']);

  /* ---------- window ---------- */

  const maximizedListeners = [];
  const emitMaximized = (value) => maximizedListeners.forEach((cb) => cb(value));

  let readyPromise;
  function ready() {
    if (!readyPromise) {
      readyPromise = new Promise((resolve) => {
        Neutralino.events.on('ready', resolve);
        Neutralino.events.on('windowClose', () => Neutralino.app.exit());
        Neutralino.init();
        setTimeout(resolve, 3000); // do not hang if the ready event is missed
      });
      readyPromise.then(() => refreshStartupTask()); // background; must not delay startup
    }
    return readyPromise;
  }

  return {
    get ready() {
      return ready();
    },

    async getConfig() {
      const config = await readConfig();
      const theme = themeName(config);
      applyTheme(theme);
      const elevated = (await Neutralino.os.execCommand('fltmc.exe')).exitCode === 0;
      return {
        nssmPath: config.nssmPath || null,
        valid: Boolean(await validNssmPath()),
        theme,
        elevated,
        version: NL_APPVERSION,
        configFile: configFile().replace(/\//g, '\\'),
      };
    },

    async setNssmPath(path) {
      const cleaned = String(path || '').trim().replace(/^"|"$/g, '');
      if (!isNssmName(cleaned) || !(await isFile(cleaned))) {
        return { ok: false, message: 'That path is not a valid nssm.exe file.' };
      }
      await writeConfig({ ...(await readConfig()), nssmPath: cleaned });
      return { ok: true, message: 'Saved.' };
    },

    async browseNssm() {
      const files = await Neutralino.os.showOpenDialog('Select nssm.exe', {
        filters: [{ name: 'NSSM', extensions: ['exe'] }],
      });
      return files && files.length ? files[0] : null;
    },

    async setTheme(theme) {
      const next = THEMES.includes(theme) ? theme : 'system';
      applyTheme(next);
      await writeConfig({ ...(await readConfig()), theme: next });
      return next;
    },

    async listServices() {
      const r = await powershell(LIST_SCRIPT);
      if (!r.ok) {
        return { ok: false, message: r.stderr || 'Could not list services.', services: [] };
      }
      try {
        const parsed = JSON.parse(r.stdout || '[]');
        return { ok: true, services: Array.isArray(parsed) ? parsed : [parsed] };
      } catch {
        return { ok: false, message: 'Could not parse service list.', services: [] };
      }
    },

    async action(name, action) {
      if (!ACTIONS.has(action)) {
        return { ok: false, message: 'Unknown action.' };
      }
      return result(await nssm('Nssm $action $name', { action, name }), `${action} OK`);
    },

    async install({ name, application, args, directory }) {
      if (!name || !application) {
        return { ok: false, message: 'Service name and application path are required.' };
      }
      const script = `
$a = @('install', $name, $app)
if ($appArgs) { $a += $appArgs }
Nssm @a | Out-Null
if ($dir) { Nssm set $name AppDirectory $dir | Out-Null }`;
      const r = await nssm(script, { name, app: application, appArgs: args || '', dir: directory || '' });
      return r.ok ? { ok: true, message: `Service "${name}" installed.` } : result(r);
    },

    async remove(name) {
      const script = `
try { Nssm stop $name | Out-Null } catch { }
Nssm remove $name confirm`;
      return result(await nssm(script, { name }), `Service "${name}" removed.`);
    },

    async edit(name) {
      const r = await nssm("Start-Process -FilePath $nssm -ArgumentList @('edit', ('\"' + $name + '\"'))", { name });
      return r.ok ? { ok: true, message: 'Opened NSSM editor.' } : result(r);
    },

    async getStartup() {
      if (!packaged()) {
        return { supported: false, enabled: false, reason: 'Available in the packaged app (npm run build).' };
      }
      return { supported: true, enabled: Boolean(await registeredExe()) };
    },

    async setStartup(enabled) {
      if (!packaged()) {
        return { ok: false, message: 'Available in the packaged app only.' };
      }
      const exe = enabled ? await currentExe() : null;
      if (enabled && !exe) {
        return { ok: false, message: 'Could not find the app location.' };
      }
      const r = enabled ? await registerTask(exe) : await powershell(REMOVE_TASK, { task: STARTUP_TASK });
      if (!r.ok) {
        return { ok: false, message: r.stderr || 'Could not change the startup setting. Run as administrator.' };
      }
      return { ok: true, enabled: Boolean(enabled) };
    },

    /** Starts a second copy of this app with administrator rights (UAC prompt), then closes this one. */
    async relaunchElevated() {
      const args = NL_ARGS.slice(1).filter((a) => a !== '--neu-dev-auto-reload');
      const script = `
$list = @()
foreach ($a in (ConvertFrom-Json $argJson)) { $list += $(if ($a -match '\\s') { '"' + $a + '"' } else { $a }) }
$p = @{ FilePath = $exe; Verb = 'RunAs'; WorkingDirectory = $cwd }
if ($list.Count -gt 0) { $p.ArgumentList = $list }
Start-Process @p`;
      const r = await powershell(script, { exe: NL_ARGS[0], argJson: JSON.stringify(args), cwd: NL_CWD });
      if (!r.ok) {
        const cancelled = /cancel/i.test(r.stderr);
        return { ok: false, message: cancelled ? 'Elevation was cancelled.' : r.stderr || 'Could not restart.' };
      }
      await Neutralino.app.exit();
      return { ok: true };
    },

    minimize: () => Neutralino.window.minimize(),
    close: () => Neutralino.app.exit(),
    async toggleMaximize() {
      const maximized = await Neutralino.window.isMaximized();
      await (maximized ? Neutralino.window.unmaximize() : Neutralino.window.maximize());
      emitMaximized(!maximized);
    },
    onMaximized: (cb) => maximizedListeners.push(cb),

    /** Makes the element drag the window (the window has no native title bar). */
    setDragRegion: (id) => Neutralino.window.setDraggableRegion(id),
  };
})();
