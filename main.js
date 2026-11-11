const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Config lives next to the executable: the portable exe's folder when packaged,
 * or the project root when running with `npm start`.
 */
function configDir() {
  if (!app.isPackaged) {
    return __dirname;
  }
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
}

const configFile = () => path.join(configDir(), 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
}

/** NSSM prints UTF-16LE; decode that, falling back to UTF-8. */
function decode(buffer) {
  if (!buffer || buffer.length === 0) {
    return '';
  }
  const text = buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8');
  return text.replace(/\u0000/g, '').trim();
}

function run(file, args, { timeout = 60000, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: 'buffer',
        windowsHide: true,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : process.env,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: decode(stdout),
          stderr: decode(stderr),
          code: error ? error.code : 0,
        });
      },
    );
  });
}

function nssmPath() {
  const p = readConfig().nssmPath;
  return p && fs.existsSync(p) ? p : null;
}

function nssm(args, opts) {
  const p = nssmPath();
  if (!p) {
    return Promise.resolve({ ok: false, stdout: '', stderr: 'nssm.exe path is not configured.', code: -1 });
  }
  return run(p, args, opts);
}

const result = (r, fallback) => ({
  ok: r.ok,
  message: r.ok ? r.stdout || fallback : r.stderr || r.stdout || `Failed (exit ${r.code})`,
});

function isNssmExecutable(p) {
  return typeof p === 'string' && /nssm(\d+)?\.exe$/i.test(p) && fs.existsSync(p) && fs.statSync(p).isFile();
}

const LIST_SCRIPT = `
$ErrorActionPreference = 'Stop'
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
}) | ConvertTo-Json -Compress -Depth 3
`;

const THEMES = ['system', 'light', 'dark'];
const themeName = () => (THEMES.includes(readConfig().theme) ? readConfig().theme : 'system');
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: windowBackground(),
    frame: false,
    icon: path.join(__dirname, 'renderer', 'assets', 'nssm-services-manager.png'),
    title: 'NSSM Services Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender);

ipcMain.on('window:minimize', (e) => senderWindow(e)?.minimize());
ipcMain.on('window:toggle-maximize', (e) => {
  const win = senderWindow(e);
  if (win) {
    win.isMaximized() ? win.unmaximize() : win.maximize();
  }
});
ipcMain.on('window:close', (e) => senderWindow(e)?.close());

/** `fltmc` only succeeds from an elevated process, which makes it a cheap admin check. */
const isElevated = () => run('fltmc.exe', [], { timeout: 5000 }).then((r) => r.ok);

ipcMain.handle('config:get', async () => {
  const config = readConfig();
  return {
    elevated: await isElevated(),
    version: app.getVersion(),
    nssmPath: config.nssmPath || null,
    valid: Boolean(nssmPath()),
    theme: themeName(),
    configFile: configFile(),
  };
});

ipcMain.handle('theme:set', (_e, theme) => {
  const next = THEMES.includes(theme) ? theme : 'system';
  nativeTheme.themeSource = next;
  writeConfig({ ...readConfig(), theme: next });
  return next;
});

ipcMain.handle('dialog:browse-nssm', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Select nssm.exe',
    properties: ['openFile'],
    filters: [{ name: 'NSSM', extensions: ['exe'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('config:set-nssm', (_e, p) => {
  const cleaned = String(p || '').trim().replace(/^"|"$/g, '');
  if (!isNssmExecutable(cleaned)) {
    return { ok: false, message: 'That path is not a valid nssm.exe file.' };
  }
  writeConfig({ ...readConfig(), nssmPath: cleaned });
  return { ok: true, message: 'Saved.' };
});

ipcMain.handle('services:list', async () => {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT]);
  if (!r.ok) {
    return { ok: false, message: r.stderr || 'Could not list services.', services: [] };
  }
  try {
    const parsed = JSON.parse(r.stdout || '[]');
    return { ok: true, services: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return { ok: false, message: 'Could not parse service list.', services: [] };
  }
});

const ACTIONS = new Set(['start', 'stop', 'restart']);

ipcMain.handle('services:action', async (_e, name, action) => {
  if (!ACTIONS.has(action)) {
    return { ok: false, message: 'Unknown action.' };
  }
  return result(await nssm([action, String(name)]), `${action} OK`);
});

ipcMain.handle('services:install', async (_e, { name, application, args, directory }) => {
  if (!name || !application) {
    return { ok: false, message: 'Service name and application path are required.' };
  }
  const installed = await nssm(['install', String(name), String(application), ...(args ? [String(args)] : [])]);
  if (!installed.ok) {
    return result(installed);
  }
  if (directory) {
    await nssm(['set', String(name), 'AppDirectory', String(directory)]);
  }
  return { ok: true, message: `Service "${name}" installed.` };
});

ipcMain.handle('services:remove', async (_e, name) => {
  await nssm(['stop', String(name)]);
  return result(await nssm(['remove', String(name), 'confirm']), `Service "${name}" removed.`);
});

ipcMain.handle('services:edit', (_e, name) => {
  const p = nssmPath();
  if (!p) {
    return { ok: false, message: 'nssm.exe path is not configured.' };
  }
  spawn(p, ['edit', String(name)], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, message: 'Opened NSSM editor.' };
});

/*
 * Run at sign-in. The app needs administrator rights, and Windows will not start elevated apps from the
 * normal "Run" registry key, so we register a Scheduled Task that runs at logon with highest privileges.
 */
const STARTUP_TASK = 'NSSM Services Manager';

/** Path to launch at sign-in; null while running from source (`npm start`). */
const startupExe = () => (app.isPackaged ? process.env.PORTABLE_EXECUTABLE_FILE || process.execPath : null);

const powershell = (script, env) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000, env });

const QUERY_TASK_SCRIPT = `
$t = Get-ScheduledTask -TaskName $env:WSM_TASK -ErrorAction SilentlyContinue
if ($t) { $t.Actions[0].Execute }
`;

const REGISTER_TASK_SCRIPT = `
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $env:WSM_EXE
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $env:WSM_TASK -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts NSSM Services Manager at sign-in' -Force | Out-Null
`;

const REMOVE_TASK_SCRIPT = `
$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName $env:WSM_TASK -Confirm:$false
`;

/** Executable the existing startup task launches, or null when there is no task. */
async function registeredStartupExe() {
  const r = await powershell(QUERY_TASK_SCRIPT, { WSM_TASK: STARTUP_TASK });
  return r.ok && r.stdout ? r.stdout.replace(/^"|"$/g, '') : null;
}

const samePath = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function registerStartupTask(exe) {
  return powershell(REGISTER_TASK_SCRIPT, { WSM_TASK: STARTUP_TASK, WSM_EXE: exe });
}

ipcMain.handle('startup:get', async () => {
  const exe = startupExe();
  if (!exe) {
    return { supported: false, enabled: false, reason: 'Available in the packaged app (npm run dist).' };
  }
  return { supported: true, enabled: Boolean(await registeredStartupExe()) };
});

ipcMain.handle('startup:set', async (_e, enabled) => {
  const exe = startupExe();
  if (!exe) {
    return { ok: false, message: 'Available in the packaged app only.' };
  }
  const r = enabled
    ? await registerStartupTask(exe)
    : await powershell(REMOVE_TASK_SCRIPT, { WSM_TASK: STARTUP_TASK });
  if (!r.ok) {
    return { ok: false, message: r.stderr || 'Could not change the startup setting. Run as administrator.' };
  }
  return { ok: true, enabled: Boolean(enabled) };
});

/** If the exe was moved since the task was created, point the task at the current location. */
async function refreshStartupTask() {
  const exe = startupExe();
  const registered = exe ? await registeredStartupExe() : null;
  if (registered && !samePath(registered, exe)) {
    await registerStartupTask(exe);
  }
}

/** Grayscale text smoothing: ClearType leaves orange/blue fringes on small icons and labels. */
app.commandLine.appendSwitch('disable-lcd-text');

app.whenReady().then(() => {
  nativeTheme.themeSource = themeName();
  nativeTheme.on('updated', () => {
    BrowserWindow.getAllWindows().forEach((w) => w.setBackgroundColor(windowBackground()));
  });
  createWindow();
  refreshStartupTask();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
