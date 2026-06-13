# UniTorrent

Multi-provider Stremio addon. Search torrents from **Jackett**, **Prowlarr**, **Torrentio**, **Comet**, **Jacred**, **MediaFusion** — stream via **TorrServer**.

## Features

- **6 providers** in one addon — parallel search, deduplication, sort by priority + seeders
- **Config embedded in URL** — each user gets a unique install URL, no server-side storage
- **TorrServer streaming** — HTTP stream any torrent, supports auth + fork
- **Result caching** — 5 min in-memory cache, per-config isolation
- **Provider priority** — set order (1-6) per provider, results sorted accordingly
- **Save to TorrServer DB** — optional checkbox to persist torrents after playback
- **Manifest URL input** — paste full manifest URLs (with or without config path)

## Quick Start

```bash
git clone https://github.com/h0dev/UniTorrent.git
cd UniTorrent
npm install
node src/index.js
```

Open `http://localhost:3000/configure` in your browser.

## Deploy

| Platform | Notes |
|----------|-------|
| Render | Free plan: sleeps after 15 min. Start cmd: `node src/index.js` |
| Fly.io | No sleep, 3 free VMs |
| Koyeb | Free, but sleeps |
| VPS | Best perf, 24/7 |

## Configuration

1. Open `/configure` in browser
2. Enable providers + enter URLs/API keys
3. Set TorrServer address
4. Click **Generate Personal URL**
5. Copy URL → install in Stremio

### TorrServer Type

- **Official** — [YouROK/TorrServer](https://github.com/YouROK/TorrServer)
- **Fork** — [9000000/TorrServer](https://github.com/9000000/TorrServer)

## API

| Route | Description |
|-------|-------------|
| `/configure` | Web UI configurator |
| `/api/generate` | Generate install URL from config |
| `/api/test/:provider` | Test provider connectivity |
| `/:config/manifest.json` | Stremio manifest |
| `/:config/stream/:type/:id.json` | Stream search |

## Providers

| Provider | Type | Config |
|----------|------|--------|
| Jackett | Indexer | URL + API Key |
| Prowlarr | Indexer | URL + API Key |
| Torrentio | Proxy/Cached | Manifest URL |
| Comet | Debrid proxy | Manifest URL |
| Jacred | Indexer (Jackett-compatible) | URL + API Key |
| MediaFusion | Proxy/Cached | Manifest URL |
| TorrServer | Streamer | URL + Auth + Type + Save to DB |

## License

MIT
