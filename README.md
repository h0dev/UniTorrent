# UniTorrent

Multi-provider Stremio addon. Search torrents from **Jackett**, **Prowlarr**, **Torrentio**, **Comet**, **Meteor**, **Jacred**, **MediaFusion** — stream via **TorrServer**.

## Features

- **7 providers** in one addon — parallel search, deduplicated results
- **Config embedded in URL** — each user gets a unique install URL, no server-side storage
- **TorrServer streaming** — HTTP stream any torrent, supports auth
- **TorrServer fork support** — dropdown to choose official or [9000000/TorrServer](https://github.com/9000000/TorrServer)
- **Self-host or cloud** — works anywhere Node.js runs

## Quick Start

```bash
git clone https://github.com/h0dev/UniTorrent.git
cd UniTorrent
npm install
npm start
```

Open `http://localhost:3000/configure` in your browser.

## Docker

```bash
docker build -t unitorrent .
docker run -d -p 3000:3000 unitorrent
```

## API

| Route | Description |
|-------|-------------|
| `/configure` | Web UI configurator |
| `/api/generate` | Generate install URL from config |
| `/api/test/:provider` | Test provider connectivity |
| `/stremio/:uuid/:config/manifest.json` | Stremio manifest |
| `/stremio/:uuid/:config/stream/:type/:id.json` | Stream search |

## Providers

| Provider | Type | Config |
|----------|------|--------|
| Jackett | Indexer | URL + API Key |
| Prowlarr | Indexer | URL + API Key |
| Torrentio | Proxy/Cached | URL + Config String |
| Comet | Debrid proxy | URL |
| Meteor | Debrid proxy | URL |
| Jacred | Indexer | URL + API Key |
| MediaFusion | Proxy/Cached | URL |
| TorrServer | Streamer | URL + Auth + Version |

## License

MIT
