# BBC Radio Downloader

A self-hosted web app for searching, caching and downloading BBC radio programmes. Runs [get_iplayer](https://github.com/get-iplayer/get_iplayer) inside Docker, with a clean browser UI backed by the BBC Sounds catalogue.

![BBC Radio Downloader](https://img.shields.io/badge/BBC-Radio%20Downloader-dc143c?style=flat-square)

## Features

- **Search** the full BBC Sounds catalogue by keyword or paste a PID directly from a BBC Sounds/iPlayer URL
- **Catalogue** — browse popular shows organised by station (Radio 1, Radio 4, 6 Music, World Service, etc.)
- **Follow shows** — mark shows as followed from search results or the catalogue; new episodes are automatically downloaded every 6 hours
- **Download with progress** — real-time log streamed to the browser via SSE; handles both episode PIDs and brand/series PIDs
- **Cached files** — manage downloaded audio files; stream or save to your computer
- **Auto-cleanup** — files older than 14 days are deleted automatically

## Requirements

- Docker (can be on a remote machine — see below)
- The machine running Docker needs outbound HTTPS access to BBC servers

## Quick start

```bash
# Clone
git clone https://github.com/RicBancroft/bbc-iplayer.git
cd bbc-iplayer

# Build and run
docker compose up --build -d
```

Open **http://localhost:3000** in your browser.

### Remote Docker host

If Docker is on another machine (e.g. a Mac on your local network), open an SSH tunnel and point the Docker client at it:

```bash
# In one terminal — keep this running
ssh -L 2375:192.168.64.2:2375 -N user@192.168.0.x

# In another terminal
export DOCKER_HOST=tcp://localhost:2375
docker compose up --build -d
```

## Usage

### Search
Type a show name or paste a PID (e.g. `m002tnzw`) from a BBC Sounds URL. Results come from the live BBC Sounds catalogue. Click **Cache** to download the episode, or **Follow** to auto-download new episodes going forward.

### Catalogue
Click **Load Catalogue** to browse ~120 popular shows grouped by station. Use the filter box to narrow results. Click **Follow** on any show.

### Following
The **Following** tab shows all followed shows and sync status. New episodes are checked every 6 hours. Click **Sync now** to trigger an immediate check.

### Downloading
Downloads stream progress in real-time. When complete a **Download to my computer** button appears. Files are also listed in the **Cached Files** panel at the bottom of every page and are deleted automatically after 14 days.

## Architecture

```
Browser  ──►  Express (Node 20)  ──►  get_iplayer (Perl)  ──►  BBC servers
                    │
              Docker volume
              /app/downloads
```

- **Backend** — `server.js`: Express API wrapping get_iplayer as a child process. BBC Sounds catalogue search via `rms.api.bbc.co.uk`. Follows persisted to `/root/.get_iplayer/follows.json` on a named Docker volume.
- **Frontend** — single-page vanilla JS (`public/app.js`) with a BBC-inspired dark/red theme.
- **Docker** — `node:20-slim` base with Perl, get_iplayer, ffmpeg and AtomicParsley installed at build time.

## Docker volumes

| Volume | Purpose |
|---|---|
| `downloads` | Downloaded audio files |
| `iplayer-cache` | get_iplayer programme cache and follows list |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `GET_IPLAYER_DIR` | *(empty)* | Extra PATH entry for get_iplayer on Windows |

## Notes

- Downloads use `--force` so re-caching a PID always fetches the latest copy
- Brand/series PIDs (returned by catalogue and search) automatically retry with `--pid-recursive --limit-matches 1` to grab the most recent episode
- The sync job skips episodes already in get_iplayer's download history (no `--force`), so only genuinely new episodes are downloaded
