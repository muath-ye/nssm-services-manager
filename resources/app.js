const $ = (id) => document.getElementById(id);

const state = {
  services: [],
  filter: 'all',
  status: 'all',
  startup: 'all',
  logon: 'all',
  query: '',
  busy: new Set(),
  expanded: new Set(),
  timer: null,
  page: 'services',
  valid: false,
  elevated: true,
  dismissConfirm: null,
};

const FILTERS = [
  { key: 'all', label: 'All services' },
  { key: 'nssm', label: 'NSSM only' },
];

const DROPDOWNS = { status: 'fStatus', startup: 'fStartup', logon: 'fLogon' };

function startupKey(s) {
  const mode = String(s.startMode || '').toLowerCase();
  return mode === 'auto' && s.delayedStart ? 'delayed' : mode;
}

const STARTUP_LABEL = {
  auto: 'Automatic',
  delayed: 'Automatic (Delayed Start)',
  manual: 'Manual',
  disabled: 'Disabled',
  boot: 'Boot',
  system: 'System',
};

function logonKey(s) {
  const name = String(s.startName || 'LocalSystem');
  if (/^localsystem$/i.test(name)) return 'system';
  if (/localservice$/i.test(name)) return 'local';
  if (/networkservice$/i.test(name)) return 'network';
  return 'user';
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Segoe Fluent Icons glyphs. */
const GLYPH = { restart: '', edit: '', trash: '', gear: '', warn: '', error: '', info: '' };

/** SVG chevrons: small icon-font glyphs get coloured ClearType fringes, vector paths do not. */
const chevronSvg = (d) =>
  `<svg class="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const CHEVRON = { down: chevronSvg('M2 4.5l4 4 4-4'), up: chevronSvg('M2 7.5l4-4 4 4') };

function show(id, visible, display = 'flex') {
  const el = $(id);
  el.classList.toggle('hidden', !visible);
  el.classList.toggle(display, visible);
}

function toast(message, ok = true) {
  const el = document.createElement('div');
  el.className = `max-w-sm rounded border border-stroke border-l-4 bg-card px-4 py-3 text-sm shadow-xl ${
    ok ? 'border-l-ok' : 'border-l-bad'
  }`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

/* ---------- InfoBar ---------- */

const INFO = {
  warn: { bg: 'bg-warn/10', icon: 'text-warn', glyph: GLYPH.warn },
  error: { bg: 'bg-bad/10', icon: 'text-bad', glyph: GLYPH.error },
  info: { bg: 'bg-accent/10', icon: 'text-accent', glyph: GLYPH.info },
};
const INFO_CLASSES = Object.values(INFO).flatMap((i) => [i.bg]);
const INFO_ICON_CLASSES = Object.values(INFO).map((i) => i.icon);

function infoBar(id, kind, title, text, action = null) {
  const style = INFO[kind] || INFO.info;
  const actionButton = $(`${id}Action`);
  if (actionButton) {
    actionButton.classList.toggle('hidden', !action);
    actionButton.textContent = action ? action.label : '';
    actionButton.onclick = action ? action.run : null;
  }
  const bar = $(id);
  bar.classList.remove(...INFO_CLASSES);
  bar.classList.add(style.bg);
  const icon = $(`${id}Icon`);
  icon.classList.remove(...INFO_ICON_CLASSES);
  icon.classList.add(style.icon);
  icon.textContent = style.glyph;
  $(`${id}Title`).textContent = title;
  $(`${id}Text`).textContent = text;
  show(id, true);
}

/* ---------- Navigation ---------- */

function navigate(page) {
  state.page = page;
  show('page-services', page === 'services', 'flex');
  show('page-settings', page === 'settings', 'block');
  document.querySelectorAll('.nav-item').forEach((item) => {
    if (item.dataset.page === page) {
      item.setAttribute('aria-current', 'page');
    } else {
      item.removeAttribute('aria-current');
    }
  });
}

/* ---------- Settings ---------- */

async function loadSettings() {
  const config = await api.getConfig();
  state.valid = config.valid;
  state.elevated = config.elevated;
  $('nssmInput').value = config.nssmPath || '';
  $('configFile').textContent = config.configFile;
  $('versionText').textContent = config.version;
  $('themeSelect').value = config.theme;
  document.querySelector('[data-page="services"]').disabled = !config.valid;
  renderStartup(await api.getStartup());
  return config;
}

function renderStartup({ supported, enabled, reason }) {
  const sw = $('startupSwitch');
  sw.setAttribute('aria-checked', String(enabled));
  sw.disabled = !supported;
  $('startupLabel').textContent = enabled ? 'On' : 'Off';
  $('startupHint').textContent = supported
    ? 'Open automatically when you sign in, with administrator rights'
    : reason;
}

async function toggleStartup() {
  const sw = $('startupSwitch');
  const next = sw.getAttribute('aria-checked') !== 'true';
  sw.disabled = true;
  const r = await api.setStartup(next);
  sw.disabled = false;
  if (r.ok) {
    renderStartup({ supported: true, enabled: r.enabled });
    toast(r.enabled ? 'Will start with Windows.' : 'Will no longer start with Windows.');
  } else {
    toast(r.message, false);
  }
}

async function saveNssm() {
  const r = await api.setNssmPath($('nssmInput').value);
  $('setupError').classList.toggle('hidden', r.ok);
  $('setupError').textContent = r.ok ? '' : r.message;
  if (r.ok) {
    show('settingsInfo', false);
    toast('NSSM path saved.');
    await startServices();
  }
}

/* ---------- Services ---------- */

const STATE_TEXT = { Running: 'text-ok', Stopped: 'text-fg3', Paused: 'text-warn' };

function visibleServices() {
  const q = state.query.trim().toLowerCase();
  return state.services.filter((s) => {
    if (state.filter === 'nssm' && !s.isNssm) return false;
    if (state.status === 'pending' ? !/pending$/i.test(s.state) : state.status !== 'all' && s.state !== state.status) {
      return false;
    }
    if (state.startup !== 'all' && startupKey(s) !== state.startup) return false;
    if (state.logon !== 'all' && logonKey(s) !== state.logon) return false;
    return (
      !q ||
      s.name.toLowerCase().includes(q) ||
      (s.displayName || '').toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q)
    );
  });
}

const hasActiveFilters = () =>
  state.filter !== 'all' || state.status !== 'all' || state.startup !== 'all' || state.logon !== 'all' || state.query;

function clearFilters() {
  Object.assign(state, { filter: 'all', status: 'all', startup: 'all', logon: 'all', query: '' });
  $('search').value = '';
  Object.values(DROPDOWNS).forEach((id) => ($(id).value = 'all'));
  renderFilters();
  renderList();
}

function renderFilters() {
  $('filters').innerHTML = FILTERS.map(
    (f) => `<button data-filter="${f.key}" aria-pressed="${state.filter === f.key}">${f.label}</button>`,
  ).join('');
}

function renderList() {
  const items = visibleServices();
  const running = state.services.filter((s) => s.state === 'Running').length;
  const nssmCount = state.services.filter((s) => s.isNssm).length;
  const shown = items.length === state.services.length ? '' : `${items.length} shown · `;
  $('summary').textContent = `${shown}${state.services.length} services · ${running} running · ${nssmCount} managed by NSSM`;
  $('clearFilters').classList.toggle('hidden', !hasActiveFilters());
  show('empty', items.length === 0);
  $('list').classList.toggle('hidden', items.length === 0);

  $('list').innerHTML = items.map(renderRow).join('');
}

/** One Settings-expander card: header row, plus a details panel while expanded. */
function renderRow(s) {
  const busy = state.busy.has(s.name);
  const running = s.state === 'Running';
  const settled = running || s.state === 'Stopped';
  const expanded = state.expanded.has(s.name);
  const toggleLabel = busy ? 'Working…' : running ? 'On' : s.state === 'Stopped' ? 'Off' : s.state;
  const attr = `data-name="${esc(s.name)}"`;

  const detail = (label, value, { mono = false, tone = '' } = {}) => `
    <div class="flex items-start justify-between gap-8 border-t border-stroke py-3 pl-14 pr-5 first:border-t-0">
      <span class="shrink-0 text-sm">${label}</span>
      <span class="select-text break-all text-right text-sm ${tone || 'text-fg2'} ${mono ? 'font-mono text-xs' : ''}">${esc(value)}</span>
    </div>`;

  const details = expanded
    ? `<div class="border-t border-stroke bg-subtle/[0.03]">
        ${s.description ? detail('Description', s.description) : ''}
        ${detail('Service name', s.name, { mono: true })}
        ${detail('Display name', s.displayName || s.name)}
        ${detail('Status', s.state, { tone: STATE_TEXT[s.state] || 'text-warn' })}
        ${detail('Startup type', STARTUP_LABEL[startupKey(s)] || s.startMode)}
        ${detail('Log on as', s.startName || 'LocalSystem')}
        ${detail('Path to executable', s.path || '—', { mono: true })}
        ${detail('Managed by NSSM', s.isNssm ? 'Yes' : 'No')}
      </div>`
    : '';

  return `
  <div class="card overflow-hidden">
    <div data-expand="${esc(s.name)}" class="flex cursor-pointer items-center gap-4 px-5 py-3 transition hover:bg-cardhover">
      <i class="fi w-5 shrink-0 text-xl text-fg2">${GLYPH.gear}</i>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate">${esc(s.displayName || s.name)}</span>
          ${s.isNssm ? '<span class="rounded bg-accent/15 px-1.5 py-px text-[10px] font-semibold uppercase text-accent">nssm</span>' : ''}
        </div>
        <p class="truncate text-xs ${s.description ? 'text-fg2' : 'italic text-fg3'}">${esc(s.description || 'No description')}</p>
      </div>
      <span class="w-14 text-right text-sm ${busy ? 'animate-pulse text-fg2' : ''}">${esc(toggleLabel)}</span>
      <button ${attr} data-act="${running ? 'stop' : 'start'}" role="switch" aria-checked="${running}"
        aria-label="${esc(s.name)}" class="switch" title="${running ? 'Stop' : 'Start'}" ${busy || !settled ? 'disabled' : ''}></button>
      <div class="flex gap-0.5">
        <button ${attr} data-act="restart" class="btn btn-icon" title="Restart" aria-label="Restart" ${busy ? 'disabled' : ''}><i class="fi">${GLYPH.restart}</i></button>
        ${
          s.isNssm
            ? `<button ${attr} data-act="edit" class="btn btn-icon" title="Edit in NSSM" aria-label="Edit in NSSM"><i class="fi">${GLYPH.edit}</i></button>
               <button ${attr} data-act="remove" class="btn btn-icon btn-danger" title="Remove" aria-label="Remove" ${busy ? 'disabled' : ''}><i class="fi">${GLYPH.trash}</i></button>`
            : ''
        }
        <button class="btn btn-icon" tabindex="-1" aria-label="${expanded ? 'Collapse' : 'Expand'} details" aria-expanded="${expanded}">${CHEVRON[expanded ? 'up' : 'down']}</button>
      </div>
    </div>
    ${details}
  </div>`;
}

async function refresh({ silent = false } = {}) {
  const r = await api.listServices();
  $('loading').classList.add('hidden');
  if (!r.ok) {
    if (!silent) {
      infoBar('infobar', 'error', 'Could not load services', r.message);
    }
    return;
  }
  if ($('infobarTitle').textContent === 'Could not load services') {
    show('infobar', false);
  }
  state.services = r.services.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
  renderList();
}

async function perform(name, act) {
  if (act === 'edit') {
    const r = await api.edit(name);
    if (!r.ok) toast(r.message, false);
    return;
  }
  if (act === 'remove' && !(await confirmDialog(`Remove "${name}"?`, 'The service will be stopped and deleted.'))) {
    return;
  }
  state.busy.add(name);
  renderList();
  const r = act === 'remove' ? await api.remove(name) : await api.action(name, act);
  state.busy.delete(name);
  toast(r.ok ? `${name}: ${act} succeeded` : `${name}: ${r.message}`, r.ok);
  await refresh({ silent: true });
}

/* ---------- Dialogs ---------- */

function confirmDialog(title, text) {
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  show('confirmModal', true);
  $('confirmCancel').focus();
  return new Promise((resolve) => {
    const done = (value) => {
      show('confirmModal', false);
      $('confirmOk').onclick = null;
      $('confirmCancel').onclick = null;
      state.dismissConfirm = null;
      resolve(value);
    };
    $('confirmOk').onclick = () => done(true);
    $('confirmCancel').onclick = () => done(false);
    state.dismissConfirm = () => done(false);
  });
}

function openModal() {
  ['fName', 'fApp', 'fArgs', 'fDir'].forEach((id) => ($(id).value = ''));
  show('modal', true);
  $('fName').focus();
}

async function submitInstall() {
  const r = await api.install({
    name: $('fName').value.trim(),
    application: $('fApp').value.trim().replace(/^"|"$/g, ''),
    args: $('fArgs').value.trim(),
    directory: $('fDir').value.trim().replace(/^"|"$/g, ''),
  });
  toast(r.message, r.ok);
  if (r.ok) {
    show('modal', false);
    await refresh({ silent: true });
  }
}

/* ---------- Boot ---------- */

async function restartAsAdmin() {
  const r = await api.relaunchElevated();
  if (!r.ok) {
    toast(r.message, false);
  }
}

async function startServices() {
  navigate('services');
  renderFilters();
  show('infobar', false);
  if (!state.elevated) {
    infoBar(
      'infobar',
      'warn',
      'Administrator rights needed',
      'You can browse services now. Starting, stopping, installing and removing them needs administrator rights.',
      { label: 'Restart as administrator', run: restartAsAdmin },
    );
  }
  $('loading').classList.remove('hidden');
  await loadSettings();
  await refresh();
  clearInterval(state.timer);
  state.timer = setInterval(() => refresh({ silent: true }), 5000);
}

async function boot() {
  const config = await loadSettings();
  if (config.valid) {
    return startServices();
  }
  clearInterval(state.timer);
  navigate('settings');
  infoBar('settingsInfo', 'info', 'Welcome', 'Select the location of nssm.exe to get started.');
}

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', async () => {
    if (item.dataset.page === 'settings') {
      await loadSettings();
    }
    navigate(item.dataset.page);
  });
});

$('startupSwitch').addEventListener('click', toggleStartup);
$('themeSelect').addEventListener('change', (e) => api.setTheme(e.target.value));
$('winMin').addEventListener('click', () => api.minimize());
$('winMax').addEventListener('click', () => api.toggleMaximize());
$('winClose').addEventListener('click', () => api.close());
api.onMaximized((maximized) => {
  $('winMaxIcon').textContent = maximized ? '' : '';
  $('winMax').title = maximized ? 'Restore' : 'Maximize';
});

$('saveBtn').addEventListener('click', saveNssm);
$('nssmInput').addEventListener('keydown', (e) => e.key === 'Enter' && saveNssm());
$('browseBtn').addEventListener('click', async () => {
  const p = await api.browseNssm();
  if (p) $('nssmInput').value = p;
});
$('refreshBtn').addEventListener('click', () => refresh());
$('installBtn').addEventListener('click', openModal);
$('modalCancel').addEventListener('click', () => show('modal', false));
$('modalOk').addEventListener('click', submitInstall);
$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderList();
});
Object.entries(DROPDOWNS).forEach(([key, id]) => {
  $(id).addEventListener('change', (e) => {
    state[key] = e.target.value;
    renderList();
  });
});
$('clearFilters').addEventListener('click', clearFilters);
$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  renderFilters();
  renderList();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.dismissConfirm) {
      state.dismissConfirm();
    } else {
      show('modal', false);
    }
  } else if (e.key === 'F5' && state.page === 'services') {
    e.preventDefault();
    refresh();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'f' && state.page === 'services') {
    e.preventDefault();
    $('search').focus();
  } else if (e.key === 'Enter' && !$('modal').classList.contains('hidden') && e.target.tagName === 'INPUT') {
    submitInstall();
  }
});

$('list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    if (!btn.disabled) perform(btn.dataset.name, btn.dataset.act);
    return;
  }
  const header = e.target.closest('[data-expand]');
  if (header) {
    const name = header.dataset.expand;
    state.expanded.has(name) ? state.expanded.delete(name) : state.expanded.add(name);
    renderList();
  }
});

$('titleDrag').addEventListener('dblclick', () => api.toggleMaximize());

api.ready.then(() => {
  api.setDragRegion('titleDrag');
  boot();
});
