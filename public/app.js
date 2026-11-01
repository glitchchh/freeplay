// Freeplay dashboard client.
const $ = (id) => document.getElementById(id);

let latest = null;
let logSeen = 0;
let startedAt = 0;
let busy = false;
let saveTimer = null;

const fmtMB = (bytes) => `${Math.round((bytes || 0) / (1024 * 1024))} MB`;

function fmtUptime(ms) {
  if (!ms || ms < 1000) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setSaveState(text) {
  $('saveState').textContent = text;
}

function queueSave(patch, label = 'Saved') {
  clearTimeout(saveTimer);
  setSaveState('Saving…');
  saveTimer = setTimeout(async () => {
    try {
      const snap = await api('/api/config', patch);
      latest = { ...latest, config: snap.config };
      setSaveState(label);
      setTimeout(() => setSaveState(''), 1600);
    } catch (err) {
      setSaveState(err.message);
    }
  }, 350);
}

function render(snapshot) {
  if (!snapshot) return;
  latest = snapshot;
  const { status, config, plan, install } = snapshot;
  const state = status.state;
  const running = state === 'starting' || state === 'live';
  if (status.uptimeMs && !startedAt) startedAt = Date.now() - status.uptimeMs;
  if (!status.uptimeMs) startedAt = 0;

  $('appVersion').textContent = snapshot.version;

  // Status pill.
  const pill = $('pill');
  pill.dataset.state = state;
  $('pillText').textContent =
    state === 'live' ? 'Live' : state === 'starting' ? 'Starting' : state === 'error' ? 'Error' : 'Offline';

  // Hero copy.
  const headline = $('headline');
  const subline = $('subline');
  if (state === 'live') {
    headline.textContent = status.clients > 0 ? 'Device connected' : 'Waiting for a device';
    const where = status.advertised ? `“${status.advertised.name}”` : 'this PC';
    subline.textContent =
      status.clients > 0
        ? `Your screen is mirrored to ${where}. Keep Freeplay running to stay mirrored.`
        : `Discoverable as ${where}${status.advertised?.port ? ` on port ${status.advertised.port}` : ''}. Open Control Center on your iPhone or iPad and pick Screen Mirroring.`;
  } else if (state === 'starting') {
    headline.textContent = 'Starting receiver…';
    subline.textContent = 'Advertising on the local network. This usually takes a few seconds.';
  } else if (state === 'error') {
    headline.textContent = 'Receiver stopped';
    subline.textContent = status.lastError || 'The engine reported a problem. Check the log below.';
  } else {
    headline.textContent = 'Receiver is off';
    subline.textContent = status.engine
      ? 'Start Freeplay, then mirror your iPhone or iPad to this PC over Wi-Fi.'
      : 'Install a receiver engine below, then start mirroring.';
  }

  const toggle = $('toggle');
  toggle.disabled = busy || (!status.engine && !running);
  toggle.textContent = running ? 'Stop receiver' : 'Start receiver';
  toggle.classList.toggle('stop', running);
  $('restart').hidden = !running;

  $('statEngine').textContent = status.engine ? status.engine.label : 'none';
  $('statPort').textContent = status.advertised?.port ? String(status.advertised.port) : '—';
  $('statClients').textContent = String(status.clients || 0);
  $('statUptime').textContent = running ? fmtUptime(startedAt ? Date.now() - startedAt : status.uptimeMs) : '—';

  // Receiver settings (only write when the field is not being edited).
  if (document.activeElement !== $('name')) $('name').value = config.receiverName;
  if (document.activeElement !== $('pin')) $('pin').value = config.pin;
  if (document.activeElement !== $('extraArgs')) $('extraArgs').value = config.extraArgs;
  $('h265').checked = Boolean(config.h265);
  $('fullscreen').checked = Boolean(config.fullscreen);
  $('stepName').textContent = config.receiverName;

  // Engine panel.
  $('engineName').textContent = status.engine ? status.engine.label + (status.version ? ` ${status.version}` : '') : 'Not installed';
  $('enginePath').textContent = status.engine ? status.engine.path : 'No engine binary found';
  const source = $('engineSource');
  source.hidden = !status.engine;
  source.textContent = status.engine ? status.engine.source : '';

  const installBox = $('installBox');
  installBox.hidden = Boolean(status.engine) || !plan.downloadable;
  if (!status.engine && plan.downloadable && !install.active) {
    $('install').textContent = `Install engine${plan.approxBytes ? ` (~${fmtMB(plan.approxBytes)})` : ''}`;
    $('install').disabled = busy;
  }

  const notes = status.notes || [];
  $('engineNotes').hidden = notes.length === 0;
  $('engineNotes').textContent = notes.join(' ');

  if (!status.engine) {
    $('engineHelp').textContent = plan.downloadable
      ? `${plan.name}: ${plan.note}`
      : plan.note;
  } else if (install.phase === 'done') {
    $('engineHelp').textContent = 'Engine ready. Press Start receiver.';
  } else {
    $('engineHelp').textContent = '';
  }

  renderInstall(install);
  renderLog(status.log || []);
}

function renderInstall(install) {
  const progress = $('progress');
  const bar = $('bar');
  const text = $('progressText');
  if (!install || install.phase === 'idle') {
    progress.hidden = true;
    return;
  }
  if (install.phase === 'failed') {
    progress.hidden = false;
    bar.style.width = '100%';
    bar.style.opacity = '0.4';
    text.textContent = `Install failed: ${install.error}`;
    $('install').disabled = false;
    return;
  }
  bar.style.opacity = '1';
  if (install.phase === 'done') {
    progress.hidden = true;
    return;
  }
  progress.hidden = false;
  const pct = install.total ? Math.min(100, Math.round((install.received / install.total) * 100)) : 0;
  bar.style.width = `${pct}%`;
  text.textContent =
    install.phase === 'extract'
      ? `Unpacking engine… ${pct}%`
      : `Downloading engine… ${fmtMB(install.received)} / ${fmtMB(install.total)} (${pct}%)`;
}

function renderLog(lines) {
  const el = $('log');
  if (lines.length < logSeen) el.textContent = '';
  const slice = el.textContent === '' ? lines : lines.slice(logSeen);
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  for (const entry of slice) {
    const row = document.createElement('div');
    const time = new Date(entry.t).toLocaleTimeString([], { hour12: false });
    row.innerHTML = `<span class="t">${time}</span> `;
    row.append(document.createTextNode(entry.line));
    if (entry.level === 'error') row.classList.add('err');
    el.append(row);
  }
  if (lines.length === 0) {
    el.innerHTML = '<div class="empty">Engine output will appear here.</div>';
  } else if (el.querySelector('.empty')) {
    el.querySelector('.empty').remove();
  }
  logSeen = lines.length;
  while (el.childElementCount > 300) el.firstElementChild.remove();
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

async function refresh() {
  try {
    render(await api('/api/state'));
  } catch {
    /* server not up yet */
  }
}

$('toggle').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  $('toggle').disabled = true;
  try {
    const running = latest?.status.state === 'live' || latest?.status.state === 'starting';
    render(await api(running ? '/api/receiver/stop' : '/api/receiver/start', {}));
  } catch (err) {
    $('subline').textContent = err.message;
  } finally {
    busy = false;
    refresh();
  }
});

$('restart').addEventListener('click', async () => {
  busy = true;
  try {
    await api('/api/receiver/stop', {});
    await new Promise((r) => setTimeout(r, 600));
    render(await api('/api/receiver/start', {}));
  } catch (err) {
    $('subline').textContent = err.message;
  } finally {
    busy = false;
    refresh();
  }
});

$('install').addEventListener('click', async () => {
  try {
    $('install').disabled = true;
    await api('/api/engine/install', {});
  } catch (err) {
    $('progressText').textContent = err.message;
    $('progress').hidden = false;
    $('install').disabled = false;
  }
});

$('name').addEventListener('input', (e) => queueSave({ receiverName: e.target.value }));
$('name').addEventListener('change', () => refresh());

$('pin').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  queueSave({ pin: e.target.value });
});

$('extraArgs').addEventListener('input', (e) => queueSave({ extraArgs: e.target.value }));
$('extraArgs').addEventListener('change', () => refresh());

$('h265').addEventListener('change', async (e) => {
  await api('/api/config', { h265: e.target.checked });
  refresh();
});
$('fullscreen').addEventListener('change', async (e) => {
  await api('/api/config', { fullscreen: e.target.checked });
  refresh();
});

$('clearLog').addEventListener('click', () => {
  logSeen = 0;
  $('log').textContent = '';
  $('log').innerHTML = '<div class="empty">Engine output will appear here.</div>';
});

// Live updates.
function connect() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === 'snapshot') {
      logSeen = 0;
      $('log').textContent = '';
      render(payload.data);
    } else if ((payload.type === 'state' || payload.type === 'tick') && latest) {
      latest = { ...latest, status: { ...latest.status, ...payload.status } };
      render(latest);
    } else if (payload.type === 'install' && latest) {
      latest.install = payload.data;
      renderInstall(payload.data);
      if (payload.data.phase === 'failed') $('install').disabled = false;
    }
  };
  source.onerror = () => {
    source.close();
    setTimeout(connect, 2500);
  };
}

setInterval(() => {
  if (latest?.status.state === 'live' && startedAt) {
    $('statUptime').textContent = fmtUptime(Date.now() - startedAt);
  }
}, 1000);

refresh();
connect();
