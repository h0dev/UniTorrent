#!/usr/bin/env node
// ============================================================================
// Jackett + TorrServer Stremio Addon
// ============================================================================
// - Per-user config via Stremio built-in config UI
// - Stream: search Jackett → return infoHash (built-in) or TorrServer URL
// - Deploy: HuggingFace Spaces (Docker)
// ============================================================================

const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

// ============================================================================
// 1. MANIFEST với per-user config
// ============================================================================
const manifest = {
  id: 'com.jackett.torrents',
  version: '1.0.0',
  name: 'Jackett Torrents',
  description: 'Tìm torrent qua Jackett, phát qua TorrServer hoặc Stremio built-in torrent client',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: true },
  // Per-user config — mỗi người tự điền trong Stremio, lưu ở client
  config: [
    {
      key: 'jackettUrl',
      type: 'text',
      title: 'Jackett Server URL',
      default: '',
      required: true,
    },
    {
      key: 'jackettApiKey',
      type: 'text',
      title: 'Jackett API Key',
      default: '',
      required: true,
    },
    {
      key: 'torrServerUrl',
      type: 'text',
      title: 'TorrServer URL (optional)',
      description: 'Để trống nếu muốn dùng Stremio built-in torrent client',
      default: '',
      required: false,
    },
    {
      key: 'maxResults',
      type: 'number',
      title: 'Max results per query',
      default: 5,
    },
  ],
};

const builder = new addonBuilder(manifest);

// ============================================================================
// 2. HELPERS
// ============================================================================

/**
 * Search Jackett for torrents
 * @param {object} cfg - { jackettUrl, jackettApiKey } từ config per-user
 * @param {string} imdbId - IMDb ID (e.g. tt1375666)
 * @returns {Promise<Array>} Sorted by seeders desc
 */
async function searchJackett(cfg, imdbId) {
  const baseUrl = cfg.jackettUrl.replace(/\/$/, '');
  const params = new URLSearchParams({ apikey: cfg.jackettApiKey, imdbid: imdbId });

  const url = `${baseUrl}/api/v2.0/indexers/all/results?${params}`;
  console.log(`[Jackett] Searching: ${imdbId}`);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) throw new Error(`Jackett HTTP ${res.status}`);

  const data = await res.json();
  const results = data.Results || [];
  console.log(`[Jackett] Found ${results.length} results`);

  return results.sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));
}

/**
 * Parse tracker from magnet URI
 */
function extractTrackers(magnetUri) {
  if (!magnetUri) return [];
  const trackers = [];
  try {
    const params = new URLSearchParams(magnetUri.split('?')[1] || '');
    params.forEach((v, k) => { if (k === 'tr' && v) trackers.push(`tracker:${v}`); });
  } catch (e) { /* ignore */ }
  return trackers;
}

/**
 * Guess extension from category
 */
function guessExtension(cat) {
  if (!cat) return 'mkv';
  const c = cat.toLowerCase();
  if (c.includes('uhd') || c.includes('4k') || c.includes('2160p')) return 'mp4';
  if (c.includes('hd') || c.includes('1080p') || c.includes('720p')) return 'mp4';
  if (c.includes('audio') || c.includes('music')) return 'mp3';
  return 'mkv';
}

/**
 * Extract IMDb ID from Stremio content ID
 * "tt1234567:1:2" → "tt1234567"
 */
function extractIMDbId(id) {
  if (!id) return '';
  const m = id.match(/^(tt\d+)/);
  return m ? m[1] : '';
}

/**
 * Lấy config, ưu tiên per-user (từ Stremio), fallback env vars
 */
function resolveConfig(userConfig) {
  const envJackett = process.env.JACKETT_URL || '';
  const envApiKey = process.env.JACKETT_API_KEY || '';
  const envTorr = process.env.TORRSERVER_URL || '';

  // Luôn ưu tiên per-user config từ Stremio
  return {
    jackettUrl: (userConfig?.jackettUrl || envJackett).replace(/\/$/, ''),
    jackettApiKey: userConfig?.jackettApiKey || envApiKey,
    torrServerUrl: (userConfig?.torrServerUrl || envTorr).replace(/\/$/, ''),
    maxResults: Math.min(Math.max(parseInt(userConfig?.maxResults || '5', 10) || 5, 1), 20),
  };
}

// ============================================================================
// 3. STREAM HANDLER
// ============================================================================
builder.defineStreamHandler(async ({ type, id, config: userConfig }) => {
  try {
    const cfg = resolveConfig(userConfig || {});

    if (!cfg.jackettUrl || !cfg.jackettApiKey) {
      console.log('[Stream] No Jackett config — cần config trong Stremio');
      return { streams: [] };
    }

    const imdbId = extractIMDbId(id);
    if (!imdbId) return { streams: [] };

    console.log(`[Stream] ${type} ${imdbId}`);
    const results = await searchJackett(cfg, imdbId);

    if (!results || results.length === 0) return { streams: [] };

    const streams = results.slice(0, cfg.maxResults).map((r) => {
      const label = `⬆${r.Seeders || 0} ${r.Title}`;
      const stream = {
        name: label,
        infoHash: r.InfoHash,
        fileIdx: 0,
        sources: extractTrackers(r.MagnetUri),
        behaviorHints: {
          videoSize: r.Size || 0,
          filename: r.Title
            ? `${r.Title.replace(/[^a-zA-Z0-9._ -]/g, '')}.${guessExtension(r.CategoryDesc)}`
            : 'video.mkv',
        },
      };

      // Nếu có TorrServer → dùng HTTP stream thay vì infoHash
      if (cfg.torrServerUrl) {
        delete stream.infoHash;
        delete stream.fileIdx;
        delete stream.sources;
        stream.url = `${cfg.torrServerUrl}/stream?link=${encodeURIComponent(r.MagnetUri)}&index=1&play`;
        stream.title = label;
        stream.behaviorHints.notWebReady = false;
      }

      return stream;
    });

    console.log(`[Stream] → ${streams.length} streams`);
    return { streams, cacheMaxAge: 600 };
  } catch (err) {
    console.error('[Stream] Error:', err.message);
    return { streams: [] };
  }
});

// ============================================================================
// 4. EXPRESS — Landing page + Stremio addon
// ============================================================================

const LANDING_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jackett Torrents - Stremio Addon</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .container { max-width: 520px; width: 100%; text-align: center; }
    .logo { margin-bottom: 40px; }
    .logo h1 { font-size: 32px; color: #fff; margin-bottom: 4px; }
    .logo h1 span { color: #5b9cf5; }
    .logo p { color: #888; font-size: 14px; }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 32px;
    }
    .manifest-url {
      background: #0a0a1a;
      border: 1px solid #1a2a4a;
      border-radius: 8px;
      padding: 12px 16px;
      margin: 16px 0;
      font-size: 13px;
      color: #5b9cf5;
      word-break: break-all;
      user-select: all;
    }
    .btn {
      display: inline-block;
      padding: 14px 32px;
      background: #5b9cf5;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      transition: background 0.2s;
      margin-top: 8px;
    }
    .btn:hover { background: #4a8be4; }
    .steps {
      text-align: left;
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid #2a2a2a;
    }
    .steps h3 { color: #fff; margin-bottom: 12px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; }
    .steps ol { padding-left: 20px; color: #aaa; font-size: 13px; line-height: 1.8; }
    .steps ol li strong { color: #e0e0e0; }
    .footer { color: #444; font-size: 12px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>⚡ Jackett <span>Torrents</span></h1>
      <p>Stremio Addon — Streaming torrents qua Jackett & TorrServer</p>
    </div>
    <div class="card">
      <p style="color:#aaa;margin-bottom:8px;">📦 Addon Manifest URL:</p>
      <div class="manifest-url">{{MANIFEST_URL}}</div>
      <a class="btn" href="{{STREMIO_LINK}}" target="_blank">🚀 Mở trong Stremio</a>

      <div class="steps">
        <h3>📋 Hướng dẫn cài đặt</h3>
        <ol>
          <li><strong>Bước 1:</strong> Click nút "Mở trong Stremio" bên trên</li>
          <li><strong>Bước 2:</strong> Trong Stremio → chọn Install</li>
          <li><strong>Bước 3:</strong> Vào Settings của addon → điền <strong>Jackett URL</strong> + <strong>API Key</strong></li>
          <li><strong>Bước 4:</strong> (Tùy chọn) Điền TorrServer URL nếu muốn stream HTTP</li>
          <li><strong>Bước 5:</strong> Tìm phim và xem! 🎬</li>
        </ol>
      </div>
    </div>
    <div class="footer">Jackett Torrents Addon v1.0.0</div>
  </div>
</body>
</html>`;

function renderLandingPage(baseUrl) {
  const manifestUrl = `${baseUrl}/manifest.json`;
  const stremioLink = `stremio://${manifestUrl.replace(/^https?:\/\//, '')}`;
  return LANDING_HTML
    .replace('{{MANIFEST_URL}}', manifestUrl)
    .replace('{{STREMIO_LINK}}', stremioLink);
}

// --- Express Setup ---
const app = express();

// Landing page
app.get('/', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.send(renderLandingPage(baseUrl));
});

// (Config UI hoàn toàn do Stremio xử lý — /configure auto-generated bởi SDK)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// 5. STARTUP
// ============================================================================

// Mount Stremio addon router (xử lý /manifest.json, /stream/*, /configure)
app.use(getRouter(builder.getInterface()));

const PORT = parseInt(process.env.PORT || '7860', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('  Jackett + TorrServer Stremio Addon');
  console.log('='.repeat(50));
  console.log(`  Server:   http://0.0.0.0:${PORT}`);
  console.log(`  Landing:  http://0.0.0.0:${PORT}/`);
  console.log(`  Manifest: http://0.0.0.0:${PORT}/manifest.json`);
  console.log(`  Config:   http://0.0.0.0:${PORT}/configure`);
  console.log(`  Health:   http://0.0.0.0:${PORT}/health`);
  console.log('='.repeat(50));
});
