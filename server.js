const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const FOLLOWS_FILE = '/root/.get_iplayer/follows.json';
const isWin = process.platform === 'win32';
const GET_IPLAYER_DIR = process.env.GET_IPLAYER_DIR ||
  (isWin ? 'C:\\Program Files (x86)\\get_iplayer' : '');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map();

// ── get_iplayer runner ────────────────────────────────────────────────────────

function runGetIplayer(args) {
  const env = {
    ...process.env,
    PATH: [process.env.PATH, GET_IPLAYER_DIR].filter(Boolean).join(isWin ? ';' : ':')
  };
  if (isWin) return spawn('cmd.exe', ['/c', 'get_iplayer', ...args], { env, windowsHide: true });
  return spawn('get_iplayer', args, { env });
}

// ── Follows helpers ───────────────────────────────────────────────────────────

function loadFollows() {
  try { return JSON.parse(fs.readFileSync(FOLLOWS_FILE, 'utf8')); }
  catch { return { follows: [] }; }
}

function saveFollows(data) {
  try { fs.writeFileSync(FOLLOWS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('saveFollows:', e.message); }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const syncState = { running: false, lastSync: null, nextSync: null, log: [] };

function runSync() {
  if (syncState.running) return;
  const { follows } = loadFollows();
  if (!follows.length) return;

  syncState.running = true;
  syncState.log = [`[${new Date().toISOString()}] Sync started — ${follows.length} show(s)`];

  // First refresh listings to pick up new episodes
  const refresh = runGetIplayer(['--type=radio', '--refresh', '--nocopyright']);
  refresh.on('close', () => {
    syncState.log.push('Listings refreshed — checking followed shows');
    let i = 0;

    function next() {
      if (i >= follows.length) {
        syncState.running = false;
        syncState.lastSync = new Date().toISOString();
        syncState.nextSync = new Date(Date.now() + SYNC_INTERVAL_MS).toISOString();
        syncState.log.push('Sync complete');
        return;
      }
      const show = follows[i++];
      syncState.log.push(`Checking: ${show.name}`);

      // No --force here: only downloads episodes not already in history
      const proc = runGetIplayer([
        '--type=radio', show.name, '--get',
        `--output=${DOWNLOADS_DIR}`, '--nocopyright'
      ]);
      const collect = d => syncState.log.push(...d.toString().split('\n').filter(Boolean));
      proc.stdout.on('data', collect);
      proc.stderr.on('data', collect);
      proc.on('close', next);
      proc.on('error', next);
    }
    next();
  });
  refresh.on('error', () => {
    syncState.running = false;
    syncState.log.push('ERROR: get_iplayer not found');
  });
}

syncState.nextSync = new Date(Date.now() + SYNC_INTERVAL_MS).toISOString();
setInterval(runSync, SYNC_INTERVAL_MS);

// ── 14-day download cleanup ───────────────────────────────────────────────────

const MAX_FILE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function runCleanup() {
  const cutoff = Date.now() - MAX_FILE_AGE_MS;
  try {
    for (const f of fs.readdirSync(DOWNLOADS_DIR)) {
      if (f.startsWith('.')) continue;
      const fp = path.join(DOWNLOADS_DIR, f);
      if (fs.statSync(fp).mtime.getTime() < cutoff) {
        fs.unlinkSync(fp);
        console.log(`Cleaned up (14-day): ${f}`);
      }
    }
  } catch (e) { console.error('Cleanup error:', e.message); }
}

setInterval(runCleanup, 6 * 60 * 60 * 1000);
runCleanup();

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseInfoOutput(output) {
  const data = {};
  for (const line of output.split('\n')) {
    const m = line.match(/^(\w+):\s+(.+)/);
    if (m && !data[m[1]]) data[m[1]] = m[2].trim();
  }
  if (!data.pid) return null;
  return {
    pid: data.pid, name: data.name || '', episode: data.episode || '',
    channel: data.channel || '', duration: data.duration || '',
    desc: data.descshort || data.desc || ''
  };
}

const SEP = '|||';
const LISTFORMAT = `<pid>${SEP}<name>${SEP}<episode>${SEP}<channel>${SEP}<duration>${SEP}<desc>`;

function parseListformat(stdout) {
  const shows = [];
  for (const line of stdout.split('\n')) {
    const p = line.split(SEP);
    if (p.length >= 4 && /^[a-z0-9]{6,15}$/.test(p[0].trim())) {
      shows.push({
        pid: p[0].trim(), name: p[1]?.trim() || '',
        episode: p[2]?.trim() || '', channel: p[3]?.trim() || '',
        duration: p[4]?.trim() || '', desc: p[5]?.trim() || ''
      });
    }
  }
  return shows;
}

// ── BBC Sounds search (via RMS API) ──────────────────────────────────────────

function rmsSearch(q) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ q, lang: 'en' });
    const options = {
      hostname: 'rms.api.bbc.co.uk',
      path: `/v2/experience/inline/search?${qs}`,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'application/json' }
    };
    const req = https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`RMS API: ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function mapRmsItem(item) {
  // For episodes, the actual download PID is the last segment of the URN
  // e.g. "urn:bbc:radio:episode:m002tnzw" -> "m002tnzw"
  // For brands, id and urn last segment match
  const pid = item.urn ? item.urn.split(':').pop() : (item.id || '');
  const isEpisode = item.type === 'playable_item';
  return {
    pid,
    name: item.titles?.primary || '',
    episode: isEpisode ? (item.titles?.secondary || '') : '',
    channel: item.network?.short_title || '',
    duration: String(item.duration?.value || ''),
    desc: item.synopses?.short || ''
  };
}

// ── Status ────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const proc = runGetIplayer(['--version']);
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => out += d);
  proc.on('close', code => res.json({ available: code === 0, version: out.trim().split('\n')[0] || '' }));
  proc.on('error', () => res.json({ available: false, version: '' }));
});

// ── Search ────────────────────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  const { q, pid } = req.query;
  if (!q && !pid) return res.status(400).json({ error: 'Provide q or pid' });
  if (pid && !/^[a-z0-9]{6,15}$/.test(pid)) return res.status(400).json({ error: 'Invalid PID' });

  if (pid) {
    const proc = runGetIplayer(['--type=radio', `--pid=${pid}`, '--info', '--nocopyright']);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => out += d);
    proc.on('close', () => {
      const show = parseInfoOutput(out);
      res.json({ shows: show ? [show] : [] });
    });
    proc.on('error', () => res.status(503).json({ error: 'get_iplayer not found' }));
    return;
  }

  // Keyword search — BBC Sounds full catalogue (via RMS API) with local cache fallback
  try {
    const data = await rmsSearch(q);
    const shows = [];
    for (const mod of (data.data || [])) {
      for (const item of (mod.data || [])) {
        const m = mapRmsItem(item);
        if (m.pid && m.name) shows.push(m);
      }
    }
    return res.json({ shows, source: 'bbc_sounds' });
  } catch (err) {
    console.error('BBC RMS API failed, falling back to local cache:', err.message);
  }

  const proc = runGetIplayer(['--type=radio', `--listformat=${LISTFORMAT}`, '--nocopyright', q]);
  let stdout = '';
  proc.stdout.on('data', d => stdout += d);
  proc.on('close', () => res.json({ shows: parseListformat(stdout), source: 'local_cache' }));
  proc.on('error', () => res.status(503).json({ error: 'get_iplayer not found' }));
});

// ── Refresh listings ──────────────────────────────────────────────────────────

app.post('/api/refresh', (req, res) => {
  const proc = runGetIplayer(['--type=radio', '--refresh', '--nocopyright']);
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => out += d);
  proc.on('close', code => res.json({ ok: code === 0, output: out.trim() }));
  proc.on('error', () => res.status(503).json({ error: 'get_iplayer not found' }));
});

// ── Catalogue ─────────────────────────────────────────────────────────────────

const CATALOGUE_QUERIES = [
  'radio 1', 'radio 2', 'radio 3', 'radio 4', '4 extra',
  '6 music', '5 live', '1xtra', 'world service', 'asian network',
  'comedy', 'drama', 'documentary', 'sport'
];

async function buildCatalogue() {
  const seen = new Set();
  const allShows = [];
  await Promise.all(CATALOGUE_QUERIES.map(async q => {
    try {
      const data = await rmsSearch(q);
      for (const mod of (data.data || [])) {
        for (const item of (mod.data || [])) {
          if (item.type !== 'container_item') continue; // brands only
          const show = mapRmsItem(item);
          if (show.pid && show.name && !seen.has(show.pid)) {
            seen.add(show.pid);
            allShows.push(show);
          }
        }
      }
    } catch { /* ignore individual query failures */ }
  }));
  return allShows;
}

app.get('/api/catalogue', async (req, res) => {
  try {
    const shows = await buildCatalogue();
    const { follows } = loadFollows();
    const followedNames = new Set(follows.map(f => f.name));
    const stationMap = {};

    for (const { pid, name, channel, desc } of shows) {
      if (!name || !channel) continue;
      if (!stationMap[channel]) stationMap[channel] = {};
      if (!stationMap[channel][name]) {
        stationMap[channel][name] = {
          name, channel,
          desc: (desc || '').slice(0, 200),
          followed: followedNames.has(name)
        };
      }
    }

    const stations = Object.keys(stationMap).sort().map(channel => ({
      channel,
      shows: Object.values(stationMap[channel]).sort((a, b) => a.name.localeCompare(b.name))
    }));

    res.json({ stations, total: stations.reduce((n, s) => n + s.shows.length, 0) });
  } catch (err) {
    res.status(503).json({ error: 'Failed to load catalogue: ' + err.message });
  }
});

// ── Follows API ───────────────────────────────────────────────────────────────

app.get('/api/follows', (req, res) => res.json(loadFollows()));

app.post('/api/follows', (req, res) => {
  const { name, channel, desc } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const data = loadFollows();
  if (!data.follows.find(f => f.name === name)) {
    data.follows.push({ name, channel: channel || '', desc: desc || '', addedAt: new Date().toISOString() });
    saveFollows(data);
  }
  res.json({ ok: true });
});

app.delete('/api/follows/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const data = loadFollows();
  data.follows = data.follows.filter(f => f.name !== name);
  saveFollows(data);
  res.json({ ok: true });
});

// ── Sync API ──────────────────────────────────────────────────────────────────

app.post('/api/sync', (req, res) => {
  if (syncState.running) return res.json({ ok: false, message: 'Already running' });
  runSync();
  res.json({ ok: true });
});

app.get('/api/sync/status', (req, res) => res.json(syncState));

// ── Download ──────────────────────────────────────────────────────────────────

app.post('/api/download', (req, res) => {
  const { pid } = req.body;
  if (!pid || !/^[a-z0-9]{6,15}$/.test(pid)) return res.status(400).json({ error: 'Invalid PID' });

  for (const [id, job] of jobs) {
    if (job.pid === pid && job.status === 'downloading') return res.json({ jobId: id, existing: true });
  }

  const jobId = crypto.randomUUID();
  const job = { pid, status: 'starting', lines: [], file: null };
  jobs.set(jobId, job);
  res.json({ jobId });

  const before = new Set(fs.readdirSync(DOWNLOADS_DIR));
  const proc = runGetIplayer([
    '--type=radio', `--pid=${pid}`, '--get',
    `--output=${DOWNLOADS_DIR}`, '--nocopyright', '--force', '--overwrite'
  ]);

  job.status = 'downloading';
  const collect = d => job.lines.push(...d.toString().split('\n').filter(l => l.trim()));
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  proc.on('close', code => {
    const newFile = fs.readdirSync(DOWNLOADS_DIR).find(f => !before.has(f));
    if (newFile) { job.status = 'complete'; job.file = newFile; return; }

    // Brand/series PID — retry with --pid-recursive to grab the latest episode
    if (job.lines.some(l => l.includes('series or brand PID'))) {
      job.lines.push('Brand PID detected — retrying with --pid-recursive to fetch latest episode…');
      const before2 = new Set(fs.readdirSync(DOWNLOADS_DIR));
      const retry = runGetIplayer([
        '--type=radio', `--pid=${pid}`, '--get', '--pid-recursive',
        `--output=${DOWNLOADS_DIR}`, '--nocopyright', '--force', '--overwrite',
        '--limit-matches', '1'
      ]);
      retry.stdout.on('data', collect);
      retry.stderr.on('data', collect);
      retry.on('close', code2 => {
        job.status = code2 === 0 ? 'complete' : 'error';
        const newFile2 = fs.readdirSync(DOWNLOADS_DIR).find(f => !before2.has(f));
        if (newFile2) job.file = newFile2;
      });
      retry.on('error', () => { job.status = 'error'; job.lines.push('Error: retry failed'); });
      return;
    }

    job.status = code === 0 ? 'complete' : 'error';
  });
  proc.on('error', () => {
    job.status = 'error';
    job.lines.push('Error: get_iplayer not found');
  });
});

// ── Progress SSE ──────────────────────────────────────────────────────────────

app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  let idx = 0;

  const tick = setInterval(() => {
    const j = jobs.get(req.params.jobId);
    while (idx < j.lines.length) send({ type: 'line', text: j.lines[idx++] });
    if (j.status === 'complete' || j.status === 'error') {
      send({ type: 'done', status: j.status, file: j.file });
      clearInterval(tick);
      res.end();
    }
  }, 200);

  req.on('close', () => clearInterval(tick));
});

// ── Cached files ──────────────────────────────────────────────────────────────

app.get('/api/cached', (req, res) => {
  const files = fs.readdirSync(DOWNLOADS_DIR)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const stat = fs.statSync(path.join(DOWNLOADS_DIR, f));
      return { name: f, size: stat.size, date: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ files });
});

app.get('/api/file/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const filePath = path.join(DOWNLOADS_DIR, safe);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.download(filePath);
});

app.delete('/api/file/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const filePath = path.join(DOWNLOADS_DIR, safe);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ── Bulk download (ZIP) ───────────────────────────────────────────────────────

app.post('/api/files/zip', (req, res) => {
  const { files, all } = req.body;
  const names = all
    ? fs.readdirSync(DOWNLOADS_DIR).filter(f => !f.startsWith('.'))
    : (Array.isArray(files) ? files.map(f => path.basename(f)) : []);

  if (!names.length) return res.status(400).json({ error: 'No files' });

  const existing = names.filter(n => fs.existsSync(path.join(DOWNLOADS_DIR, n)));
  if (!existing.length) return res.status(404).json({ error: 'No files found' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="bbc-radio.zip"');

  const archive = archiver('zip', { zlib: { level: 0 } }); // audio is already compressed
  archive.on('error', err => { console.error('Zip error:', err); res.end(); });
  archive.pipe(res);
  for (const name of existing) archive.file(path.join(DOWNLOADS_DIR, name), { name });
  archive.finalize();
});

// ── Bulk delete ───────────────────────────────────────────────────────────────

app.delete('/api/files', (req, res) => {
  const { files, all } = req.body;
  const names = all
    ? fs.readdirSync(DOWNLOADS_DIR).filter(f => !f.startsWith('.'))
    : (Array.isArray(files) ? files.map(f => path.basename(f)) : []);

  let deleted = 0;
  for (const name of names) {
    const fp = path.join(DOWNLOADS_DIR, name);
    if (fs.existsSync(fp)) { fs.unlinkSync(fp); deleted++; }
  }
  res.json({ ok: true, deleted });
});

app.listen(PORT, () => {
  console.log(`BBC Radio Downloader → http://localhost:${PORT}`);
  console.log(`Downloads folder: ${DOWNLOADS_DIR}`);
});
