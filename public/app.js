'use strict';

let searchResults = [];
let catalogueData = null;
let syncPollTimer = null;
let followedNames = new Set();

// ── Init ──────────────────────────────────────────────────────────────────────

async function loadFollowedNames() {
  try {
    const data = await apiFetch('/api/follows');
    followedNames = new Set((data.follows || []).map(f => f.name));
  } catch { /* ignore */ }
}

async function init() {
  await checkStatus();
  await Promise.all([loadCached(), loadFollowedNames()]);

  // Tab navigation
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // Search
  document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
  });
  document.getElementById('search-btn').addEventListener('click', doSearch);
  document.getElementById('refresh-btn').addEventListener('click', refreshListings);

  // Catalogue
  document.getElementById('catalogue-load-btn').addEventListener('click', loadCatalogue);
  document.getElementById('catalogue-refresh-btn').addEventListener('click', () => refreshListings(true));
  document.getElementById('catalogue-filter').addEventListener('input', filterCatalogue);

  // Following
  document.getElementById('sync-now-btn').addEventListener('click', triggerSync);
}

// ── Views ─────────────────────────────────────────────────────────────────────

function showView(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  ['search', 'catalogue', 'following'].forEach(v => {
    document.getElementById(`view-${v}`).hidden = v !== name;
  });
  if (name === 'following') {
    loadFollowing();
    startSyncPoll();
  } else {
    stopSyncPoll();
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

async function checkStatus() {
  const bar = document.getElementById('version-bar');
  try {
    const data = await apiFetch('/api/status');
    if (data.available) {
      bar.textContent = `get_iplayer ready — ${data.version}`;
      bar.className = 'ok';
    } else {
      bar.textContent = 'get_iplayer not found — check the container';
      bar.className = 'fail';
    }
  } catch {
    bar.textContent = 'Could not reach server';
    bar.className = 'fail';
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

async function doSearch() {
  const raw = document.getElementById('search-input').value.trim();
  if (!raw) return;

  const btn = document.getElementById('search-btn');
  btn.disabled = true;
  btn.textContent = 'Searching…';

  const isPid = /^[a-z0-9]{6,15}$/.test(raw);
  const url = isPid ? `/api/search?pid=${encodeURIComponent(raw)}` : `/api/search?q=${encodeURIComponent(raw)}`;

  try {
    const data = await apiFetch(url);
    renderSearchResults(data.shows || []);
    if (!data.shows?.length) {
      showAlert('No results found. Try different keywords, or paste the PID from a BBC Sounds URL.', 'info');
    }
  } catch (err) {
    showAlert(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search';
  }
}

function renderSearchResults(shows) {
  searchResults = shows;
  const card = document.getElementById('results-card');
  const list = document.getElementById('results-list');
  const count = document.getElementById('results-count');

  card.hidden = false;
  count.textContent = shows.length ? `(${shows.length})` : '';

  if (!shows.length) {
    list.innerHTML = '<div class="empty">No results</div>';
    return;
  }

  list.innerHTML = shows.map((s, i) => {
    const isFollowed = followedNames.has(s.name);
    return `
    <div class="show-card">
      <div class="show-body">
        <div class="show-title">${esc(s.name)}${s.episode ? ' — ' + esc(s.episode) : ''}</div>
        <div class="show-meta">
          ${s.channel ? esc(s.channel) + ' &middot; ' : ''}
          ${fmtDuration(s.duration)}
          <span class="tag">${esc(s.pid)}</span>
        </div>
        ${s.desc ? `<div class="show-desc">${esc(truncate(s.desc, 200))}</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
        <button class="btn sm" data-action="cache" data-idx="${i}">Cache</button>
        <button class="btn xs ${isFollowed ? 'dark' : 'outline'}"
          data-action="follow-toggle"
          data-idx="${i}"
          data-followed="${isFollowed}">
          ${isFollowed ? 'Following' : 'Follow'}
        </button>
      </div>
    </div>
  `}).join('');

  list.querySelectorAll('[data-action="cache"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = searchResults[+btn.dataset.idx];
      if (s) startDownload(s.pid, s.name + (s.episode ? ' — ' + s.episode : ''));
    });
  });

  list.querySelectorAll('[data-action="follow-toggle"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = searchResults[+btn.dataset.idx];
      if (!s) return;
      if (btn.dataset.followed === 'true') {
        unfollowShow(s.name, btn);
      } else {
        followShow(s.name, s.channel, s.desc, btn);
      }
    });
  });
}

// ── Refresh listings ──────────────────────────────────────────────────────────

async function refreshListings(thenLoadCatalogue = false) {
  const btn = thenLoadCatalogue
    ? document.getElementById('catalogue-refresh-btn')
    : document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  showAlert('Downloading BBC programme guide — this takes a minute…', 'info');

  try {
    const data = await apiFetch('/api/refresh', { method: 'POST' });
    showAlert(data.ok ? 'Listings refreshed.' : 'Refresh finished with errors.', data.ok ? 'info' : 'error');
    if (thenLoadCatalogue && data.ok) loadCatalogue();
  } catch (err) {
    showAlert(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = thenLoadCatalogue ? 'Refresh Listings' : 'Refresh Listings';
  }
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

async function loadCatalogue() {
  const btn = document.getElementById('catalogue-load-btn');
  const content = document.getElementById('catalogue-content');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  content.innerHTML = '<div class="empty">Loading catalogue…</div>';

  try {
    const data = await apiFetch('/api/catalogue');
    catalogueData = data;
    document.getElementById('catalogue-count').textContent =
      data.total ? `(${data.total} shows, ${data.stations.length} stations)` : '';
    renderCatalogue(data.stations);
  } catch (err) {
    content.innerHTML = `<div class="empty">Failed to load: ${esc(err.message)}</div>`;
    showAlert(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reload';
  }
}

function renderCatalogue(stations) {
  const content = document.getElementById('catalogue-content');
  const filter = document.getElementById('catalogue-filter').value.toLowerCase();

  if (!stations.length) {
    content.innerHTML = '<div class="empty">No programmes found. Try <strong>Refresh Listings</strong> first.</div>';
    return;
  }

  content.innerHTML = stations.map(station => {
    const shows = filter
      ? station.shows.filter(s => s.name.toLowerCase().includes(filter))
      : station.shows;
    if (!shows.length) return '';

    const rows = shows.map((s, i) => `
      <div class="catalogue-show">
        <div class="catalogue-show-name">${esc(s.name)}</div>
        ${s.desc ? `<div class="catalogue-show-meta" title="${esc(s.desc)}">${esc(truncate(s.desc, 60))}</div>` : ''}
        <button class="btn xs ${s.followed ? 'dark' : 'outline'}"
          data-action="follow-toggle"
          data-name="${esc(s.name)}"
          data-channel="${esc(s.channel)}"
          data-desc="${esc(s.desc)}"
          data-followed="${s.followed}">
          ${s.followed ? 'Following' : 'Follow'}
        </button>
      </div>
    `).join('');

    const sId = `station-${btoa(encodeURIComponent(station.channel)).replace(/[^a-z0-9]/gi, '')}`;
    return `
      <div class="station-section">
        <div class="station-header" data-station="${sId}">
          <span class="station-name">${esc(station.channel)}</span>
          <span class="station-count">${shows.length}</span>
          <span class="station-toggle">▼</span>
        </div>
        <div class="station-shows" id="${sId}">${rows}</div>
      </div>
    `;
  }).join('');

  // Station expand/collapse
  content.querySelectorAll('.station-header').forEach(h => {
    h.addEventListener('click', () => {
      const shows = document.getElementById(h.dataset.station);
      const arrow = h.querySelector('.station-toggle');
      shows.classList.toggle('open');
      arrow.textContent = shows.classList.contains('open') ? '▲' : '▼';
    });
  });

  // Follow/unfollow buttons
  content.querySelectorAll('[data-action="follow-toggle"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const { name, channel, desc, followed } = btn.dataset;
      if (followed === 'true') {
        unfollowShow(name, btn);
      } else {
        followShow(name, channel, desc, btn);
      }
    });
  });
}

function filterCatalogue() {
  if (catalogueData) renderCatalogue(catalogueData.stations);
}

// ── Follow / Unfollow ─────────────────────────────────────────────────────────

async function followShow(name, channel, desc, btn) {
  try {
    await apiFetch('/api/follows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, channel, desc })
    });
    followedNames.add(name);
    if (btn) { btn.textContent = 'Following'; btn.className = 'btn xs dark'; btn.dataset.followed = 'true'; }
    showAlert(`Following "${name}"`, 'info');
    if (catalogueData) {
      for (const st of catalogueData.stations) {
        const s = st.shows.find(s => s.name === name);
        if (s) s.followed = true;
      }
    }
  } catch (err) {
    showAlert('Follow failed: ' + err.message, 'error');
  }
}

async function unfollowShow(name, btn) {
  try {
    await apiFetch(`/api/follows/${encodeURIComponent(name)}`, { method: 'DELETE' });
    followedNames.delete(name);
    if (btn) { btn.textContent = 'Follow'; btn.className = 'btn xs outline'; btn.dataset.followed = 'false'; }
    showAlert(`Unfollowed "${name}"`, 'info');
    if (catalogueData) {
      for (const st of catalogueData.stations) {
        const s = st.shows.find(s => s.name === name);
        if (s) s.followed = false;
      }
    }
    loadFollowing();
  } catch (err) {
    showAlert('Unfollow failed: ' + err.message, 'error');
  }
}

// ── Following view ────────────────────────────────────────────────────────────

async function loadFollowing() {
  try {
    const data = await apiFetch('/api/follows');
    renderFollowing(data.follows || []);
  } catch { /* ignore */ }
  updateSyncStatus();
}

function renderFollowing(follows) {
  const list = document.getElementById('following-list');
  if (!follows.length) {
    list.innerHTML = '<div class="empty">No followed shows yet — browse the Catalogue to follow shows.</div>';
    return;
  }
  list.innerHTML = follows.map(f => `
    <div class="followed-show">
      <div class="followed-show-info">
        <div class="followed-show-name">${esc(f.name)}</div>
        <div class="followed-show-meta">
          ${f.channel ? esc(f.channel) + ' &middot; ' : ''}
          Following since ${fmtDate(f.addedAt)}
        </div>
      </div>
      <button class="btn ghost sm" data-action="unfollow" data-name="${esc(f.name)}">Unfollow</button>
    </div>
  `).join('');

  list.querySelectorAll('[data-action="unfollow"]').forEach(btn => {
    btn.addEventListener('click', () => unfollowShow(btn.dataset.name, null));
  });
}

async function triggerSync() {
  const btn = document.getElementById('sync-now-btn');
  btn.disabled = true;
  try {
    const data = await apiFetch('/api/sync', { method: 'POST' });
    if (!data.ok) showAlert(data.message, 'info');
    else startSyncPoll();
  } catch (err) {
    showAlert(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function updateSyncStatus() {
  try {
    const s = await apiFetch('/api/sync/status');
    document.getElementById('sync-status-val').textContent = s.running ? 'Running…' : 'Idle';
    document.getElementById('sync-status-val').className = `sync-stat-value${s.running ? ' running' : ''}`;
    document.getElementById('sync-last-val').textContent = s.lastSync ? fmtRelative(s.lastSync) : 'Never';
    document.getElementById('sync-next-val').textContent = s.nextSync ? fmtRelative(s.nextSync) : '—';
  } catch { /* ignore */ }
}

function startSyncPoll() {
  stopSyncPoll();
  updateSyncStatus();
  syncPollTimer = setInterval(updateSyncStatus, 5000);
}

function stopSyncPoll() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
}

// ── Download / cache ──────────────────────────────────────────────────────────

async function startDownload(pid, label) {
  try {
    const data = await apiFetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid })
    });
    if (!data.jobId) throw new Error(data.error || 'No job ID');
    trackJob(data.jobId, pid, label);
  } catch (err) {
    showAlert('Could not start download: ' + err.message, 'error');
  }
}

function trackJob(jobId, pid, label) {
  const card = document.getElementById('jobs-card');
  const list = document.getElementById('jobs-list');
  card.hidden = false;

  const jobEl = document.createElement('div');
  jobEl.className = 'job';
  jobEl.id = `job-${jobId}`;
  jobEl.innerHTML = `
    <div class="job-header">
      <div>
        <span class="job-title">${esc(label || pid)}</span>
        <span class="tag" style="margin-left:7px">${esc(pid)}</span>
      </div>
      <span class="badge badge-running" id="badge-${jobId}">Downloading</span>
    </div>
    <div class="log" id="log-${jobId}"></div>
    <div class="job-actions" id="actions-${jobId}"></div>
  `;
  list.prepend(jobEl);

  const logEl     = document.getElementById(`log-${jobId}`);
  const badgeEl   = document.getElementById(`badge-${jobId}`);
  const actionsEl = document.getElementById(`actions-${jobId}`);

  const es = new EventSource(`/api/progress/${jobId}`);
  es.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'line') {
      logEl.textContent += msg.text + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    }
    if (msg.type === 'done') {
      es.close();
      badgeEl.className = `badge badge-${msg.status}`;
      badgeEl.textContent = msg.status === 'complete' ? 'Done' : 'Error';
      if (msg.status === 'complete' && msg.file) {
        const dlBtn = document.createElement('button');
        dlBtn.className = 'btn sm';
        dlBtn.textContent = 'Download to my computer';
        dlBtn.onclick = () => { window.location.href = `/api/file/${encodeURIComponent(msg.file)}`; };
        actionsEl.appendChild(dlBtn);
        loadCached();
      }
    }
  };
  es.onerror = () => {
    es.close();
    badgeEl.className = 'badge badge-error';
    badgeEl.textContent = 'Error';
  };
}

// ── Cached files ──────────────────────────────────────────────────────────────

async function loadCached() {
  try {
    const data = await apiFetch('/api/cached');
    renderCached(data.files || []);
  } catch { /* ignore on startup */ }
}

function renderCached(files) {
  const list = document.getElementById('cached-list');
  if (!files.length) {
    list.innerHTML = '<div class="empty">No cached files yet</div>';
    return;
  }
  list.innerHTML = files.map(f => `
    <div class="file-row">
      <div class="file-name">${esc(f.name)}</div>
      <div class="file-meta">${fmtSize(f.size)} &middot; ${fmtDate(f.date)}</div>
      <div class="file-actions">
        <button class="btn sm" data-dl="${esc(f.name)}">Download</button>
        <button class="btn ghost sm" data-del="${esc(f.name)}">Delete</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('[data-dl]').forEach(btn => {
    btn.addEventListener('click', () => {
      window.location.href = `/api/file/${encodeURIComponent(btn.dataset.dl)}`;
    });
  });
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteFile(btn.dataset.del));
  });
}

async function deleteFile(name) {
  if (!confirm(`Delete "${name}"?`)) return;
  try {
    await apiFetch(`/api/file/${encodeURIComponent(name)}`, { method: 'DELETE' });
    loadCached();
  } catch (err) {
    showAlert('Delete failed: ' + err.message, 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showAlert(msg, type) {
  const el = document.getElementById('alert');
  el.textContent = msg;
  el.className = type;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 7000);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function truncate(str, n) { return str.length > n ? str.slice(0, n) + '…' : str; }

function fmtSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes > 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
  return bytes + ' B';
}

function fmtDuration(secs) {
  const s = parseInt(secs);
  if (!s || isNaN(s)) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h > 0 ? `${h}h ${m}m` : `${m} mins`) + ' &middot; ';
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtRelative(iso) {
  const diff = new Date(iso) - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  if (abs < 60000)  return past ? 'just now' : 'in a moment';
  if (abs < 3600000) { const m = Math.round(abs / 60000); return past ? `${m}m ago` : `in ${m}m`; }
  if (abs < 86400000) { const h = Math.round(abs / 3600000); return past ? `${h}h ago` : `in ${h}h`; }
  return fmtDate(iso);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
