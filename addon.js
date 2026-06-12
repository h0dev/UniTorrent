#!/usr/bin/env node
// ============================================================================
// Jackett + TorrServer Stremio Addon
// ============================================================================
// Tìm torrent qua Jackett → Stream qua TorrServer (hoặc Stremio built-in)
// Web UI config tại / — deploy lên HuggingFace Spaces
// ============================================================================

const fs = require('fs');
const path = require('path');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

// ============================================================================
// 1. CONFIG MANAGEMENT
// ============================================================================
const CONFIG_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('Config load error:', e.message);
  }

  // Fallback: environment variables
  return {
    jackettUrl: process.env.JACKETT_URL || '',
    jackettApiKey: process.env.JACKETT_API_KEY || '',
    torrServerUrl: process.env.TORRSERVER_URL || '',
    maxResults: parseInt(process.env.MAX_RESULTS || '5', 10),
  };
}

function saveConfig(data) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // Clean: only store what we need
  const cleaned = {
    jackettUrl: (data.jackettUrl || '').replace(/\/$/, ''),
    jackettApiKey: data.jackettApiKey || '',
    torrServerUrl: (data.torrServerUrl || '').replace(/\/$/, ''),
    maxResults: Math.min(Math.max(parseInt(data.maxResults || '5', 10) || 5, 1), 20),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cleaned, null, 2), 'utf-8');
  return cleaned;
}

// ============================================================================
// 2. JACKETT API
// ============================================================================

/**
 * Search torrents via Jackett API
 * @param {object} config - { jackettUrl, jackettApiKey }
 * @param {string} imdbId - IMDb ID (e.g. tt1375666)
 * @param {string} query - Fallback search query
 * @returns {Promise<Array>} Sorted results by seeders desc
 */
async function searchJackett(config, imdbId, query) {
  const baseUrl = config.jackettUrl.replace(/\/$/, '');
  const params = new URLSearchParams({ apikey: config.jackettApiKey });

  // Use IMDb ID for precise match, fallback to text query
  if (imdbId && /^tt\d+$/.test(imdbId)) {
    params.set('imdbid', imdbId);
  } else if (query) {
    params.set('query', query);
  } else {
    return [];
  }

  const url = `${baseUrl}/api/v2.0/indexers/all/results?${params}`;
  console.log(`[Jackett] Searching: ${imdbId || query}`);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(20000), // 20s timeout
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Jackett HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  const results = data.Results || [];
  console.log(`[Jackett] Found ${results.length} results`);

  // Sort by seeders descending
  return results.sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));
}

// ============================================================================
// 3. HELPERS
// ============================================================================

/**
 * Extract tracker URLs from a magnet URI
 */
function extractTrackers(magnetUri) {
  if (!magnetUri) return [];
  const trackers = [];
  try {
    const qs = magnetUri.split('?')[1] || '';
    const params = new URLSearchParams(qs);
    params.forEach((value, key) => {
      if (key === 'tr' && value) trackers.push(`tracker:${value}`);
    });
  } catch (e) { /* ignore */ }
  return trackers;
}

/**
 * Guess file extension from category
 */
function guessExtension(categoryDesc) {
  if (!categoryDesc) return 'mkv';
  const cat = categoryDesc.toLowerCase();
  if (cat.includes('uhd') || cat.includes('4k') || cat.includes('2160p')) return 'mp4';
  if (cat.includes('hd') || cat.includes('1080p') || cat.includes('720p')) return 'mp4';
  if (cat.includes('audio') || cat.includes('music')) return 'mp3';
  return 'mkv';
}

/**
 * Get IMDb ID from Stremio content ID
 * Handles: "tt1234567" -> "tt1234567"
 * Handles: "tt1234567:1:2" -> "tt1234567"
 */
function extractIMDbId(id) {
  if (!id) return '';
  const parts = id.split(':');
  const candidate = parts[0];
  if (/^tt\d+$/.test(candidate)) return candidate;
  return ''; // Not an IMDb ID
}

// ============================================================================
// 4. STREMIO ADDON
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
  behaviorHints: {
    configurationRequired: true,
  },
};

const builder = new addonBuilder(manifest);

// --- Stream Handler ---
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const config = loadConfig();

    // Validate config
    if (!config.jackettUrl || !config.jackettApiKey) {
      console.log('[Stream] No config, returning empty');
      return { streams: [] };
    }

    const imdbId = extractIMDbId(id);
    if (!imdbId) {
      console.log(`[Stream] Not an IMDb ID: ${id}`);
      return { streams: [] };
    }

    console.log(`[Stream] Request: ${type} ${imdbId}`);
    const results = await searchJackett(config, imdbId, id);

    if (!results || results.length === 0) {
      console.log(`[Stream] No results for ${imdbId}`);
      return { streams: [] };
    }

    const maxResults = config.maxResults || 5;
    const streams = results.slice(0, maxResults).map((r) => {
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

      // If TorrServer URL is configured, use HTTP stream instead
      if (config.torrServerUrl) {
        delete stream.infoHash;
        delete stream.fileIdx;
        delete stream.sources;
        stream.url = `${config.torrServerUrl}/stream?link=${encodeURIComponent(r.MagnetUri)}&index=1&play`;
        stream.title = label;
        stream.behaviorHints.notWebReady = false;
      }

      return stream;
    });

    console.log(`[Stream] Returning ${streams.length} streams for ${imdbId}`);
    return { streams, cacheMaxAge: 600 }; // 10 min cache
  } catch (err) {
    console.error('[Stream] Error:', err.message);
    return { streams: [] };
  }
});

// ============================================================================
// 5. WEB UI — Express App
// ============================================================================

const CONFIG_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jackett Torrents - Cấu hình</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 40px 20px;
    }
    .container { max-width: 520px; width: 100%; }
    .header { text-align: center; margin-bottom: 40px; }
    .header h1 { font-size: 28px; color: #fff; margin-bottom: 4px; }
    .header h1 span { color: #5b9cf5; }
    .header p { color: #888; font-size: 14px; }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 32px;
      margin-bottom: 16px;
    }
    .success-card {
      background: #0d2818;
      border: 1px solid #1a4a2a;
      border-radius: 12px;
      padding: 16px 24px;
      margin-bottom: 16px;
      color: #4ade80;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .success-card .icon { font-size: 20px; }
    label {
      display: block;
      margin-top: 20px;
      font-size: 13px;
      font-weight: 600;
      color: #aaa;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    label:first-child { margin-top: 0; }
    input {
      width: 100%;
      padding: 12px 14px;
      margin-top: 6px;
      background: #0f0f0f;
      border: 1px solid #333;
      border-radius: 8px;
      color: #fff;
      font-size: 15px;
      transition: border-color 0.2s;
    }
    input:focus { border-color: #5b9cf5; outline: none; }
    input::placeholder { color: #555; }
    .hint { font-size: 12px; color: #666; margin-top: 4px; }
    .btn {
      margin-top: 28px;
      padding: 14px 0;
      width: 100%;
      background: #5b9cf5;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: #4a8be4; }
    .btn-secondary {
      background: transparent;
      border: 1px solid #333;
      color: #ccc;
      margin-top: 12px;
    }
    .btn-secondary:hover { background: #222; }
    .install-box {
      margin-top: 24px;
      padding: 16px;
      background: #0f1a2f;
      border: 1px solid #1a2a4a;
      border-radius: 8px;
      text-align: center;
    }
    .install-box p { color: #888; font-size: 13px; margin-bottom: 8px; }
    .install-box .url {
      color: #5b9cf5;
      font-size: 12px;
      word-break: break-all;
      background: #0a0a1a;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid #1a2a4a;
      user-select: all;
    }
    .install-box .btn-install {
      display: inline-block;
      margin-top: 12px;
      padding: 10px 24px;
      background: #5b9cf5;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
    }
    .install-box .btn-install:hover { background: #4a8be4; }
    .footer { text-align: center; color: #444; font-size: 12px; margin-top: 24px; }
    .env-note {
      background: #1a1a2a;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
      font-size: 13px;
      color: #aaa;
    }
    .env-note code {
      background: #0a0a1a;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      color: #5b9cf5;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚡ Jackett <span>Torrents</span></h1>
      <p>Stremio Addon — Streaming torrents qua Jackett & TorrServer</p>
    </div>

    {{SUCCESS_MSG}}

    <div class="env-note">
      💡 Bạn cũng có thể cấu hình qua biến môi trường:
      <code>JACKETT_URL</code>, <code>JACKETT_API_KEY</code>, <code>TORRSERVER_URL</code>
    </div>

    <div class="card">
      <form method="POST" action="/save-config">
        <label>🔗 Jackett Server URL</label>
        <input type="url" name="jackettUrl" value="{{JACKETT_URL}}" placeholder="http://192.168.1.100:9117" required>
        <div class="hint">Địa chỉ server Jackett (VD: http://192.168.1.100:9117)</div>

        <label>🔑 Jackett API Key</label>
        <input type="text" name="jackettApiKey" value="{{JACKETT_API_KEY}}" placeholder="abc123def456..." required>
        <div class="hint">API key từ Jackett Web UI (trang Dashboard)</div>

        <label>📡 TorrServer URL (tùy chọn)</label>
        <input type="url" name="torrServerUrl" value="{{TORRSERVER_URL}}" placeholder="http://192.168.1.100:8090">
        <div class="hint">Để trống nếu muốn dùng Stremio built-in torrent client</div>

        <label>📊 Số kết quả tối đa</label>
        <input type="number" name="maxResults" value="{{MAX_RESULTS}}" min="1" max="20">
        <div class="hint">Số torrent hiển thị trong Stremio (1-20)</div>

        <button type="submit" class="btn">💾 Lưu cấu hình</button>
      </form>
    </div>

    {{INSTALL_SECTION}}
    
    <div class="footer">
      Jackett Torrents Addon v1.0.0
    </div>
  </div>
</body>
</html>`;

/**
 * Render the config HTML with values
 */
function renderConfigHtml(config, success, manifestUrl) {
  let html = CONFIG_HTML
    .replace(/{{JACKETT_URL}}/g, escapeHtml(config.jackettUrl || ''))
    .replace(/{{JACKETT_API_KEY}}/g, escapeHtml(config.jackettApiKey || ''))
    .replace(/{{TORRSERVER_URL}}/g, escapeHtml(config.torrServerUrl || ''))
    .replace(/{{MAX_RESULTS}}/g, config.maxResults || '5');

  // Success message
  if (success) {
    html = html.replace(
      '{{SUCCESS_MSG}}',
      '<div class="success-card"><span class="icon">✅</span> Cấu hình đã được lưu thành công!</div>'
    );
  } else {
    html = html.replace('{{SUCCESS_MSG}}', '');
  }

  // Install section (only when configured)
  if (manifestUrl) {
    const stremioInstallUrl = `stremio://${manifestUrl.replace(/^https?:\/\//, '')}`;
    html = html.replace(
      '{{INSTALL_SECTION}}',
      `<div class="install-box">
        <p>📦 Addon đã sẵn sàng! Thêm vào Stremio:</p>
        <div class="url">${escapeHtml(manifestUrl)}</div>
        <a class="btn-install" href="${escapeHtml(stremioInstallUrl)}" target="_blank">🚀 Mở trong Stremio</a>
        <p style="margin-top:8px;font-size:12px;color:#666;">
          Hoặc copy URL trên → Stremio → Addons → Install from URL
        </p>
      </div>`
    );
  } else {
    html = html.replace('{{INSTALL_SECTION}}', '');
  }

  return html;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Express Setup ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Config page
app.get('/', (req, res) => {
  const config = loadConfig();
  const hasConfig = !!(config.jackettUrl && config.jackettApiKey);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const manifestUrl = hasConfig ? `${baseUrl}/manifest.json` : '';
  res.send(renderConfigHtml(config, false, manifestUrl));
});

// Save config
app.post('/save-config', (req, res) => {
  const config = saveConfig(req.body);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const manifestUrl = `${baseUrl}/manifest.json`;
  res.send(renderConfigHtml(config, true, manifestUrl));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// 6. STARTUP
// ============================================================================

// Mount Stremio addon router (handles /manifest.json, /stream/*, etc.)
app.use(getRouter(builder.getInterface()));

const PORT = parseInt(process.env.PORT || '7860', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('  Jackett + TorrServer Stremio Addon');
  console.log('='.repeat(50));
  console.log(`  Server:   http://0.0.0.0:${PORT}`);
  console.log(`  Config:   http://0.0.0.0:${PORT}/`);
  console.log(`  Manifest: http://0.0.0.0:${PORT}/manifest.json`);
  console.log(`  Health:   http://0.0.0.0:${PORT}/health`);
  console.log('='.repeat(50));
});
