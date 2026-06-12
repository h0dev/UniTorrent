#!/usr/bin/env node
// ============================================================================
// Jackett + TorrServer Stremio Addon
// ============================================================================
// Config nhúng trong URL (base64) — mỗi người 1 URL riêng
// Format: /stremio/{uuid}/{base64_config}/manifest.json
//         /stremio/{uuid}/{base64_config}/stream/{type}/{id}.json
// ============================================================================

const crypto = require('crypto');
const express = require('express');

// ============================================================================
// 1. MANIFEST (static, không có config vì config ở URL)
// ============================================================================
const MANIFEST = {
  id: 'com.jackett.torrents',
  version: '1.0.0',
  name: 'Jackett Torrents',
  description: 'Tìm torrent qua Jackett, phát qua TorrServer hoặc Stremio built-in torrent client',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

// ============================================================================
// 2. ENCODING / DECODING
// ============================================================================

/**
 * Mã hóa config object thành URL-safe base64
 */
function encodeConfig(config) {
  const json = JSON.stringify({
    ju: config.jackettUrl.replace(/\/$/, ''),
    ja: config.jackettApiKey,
    tu: (config.torrServerUrl || '').replace(/\/$/, ''),
    mr: Math.min(Math.max(parseInt(config.maxResults || '5', 10) || 5, 1), 20),
  });
  return Buffer.from(json)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Giải mã URL-safe base64 thành config object
 * Fallback: env vars cho field nào thiếu
 */
function decodeConfig(b64) {
  try {
    // Khôi phục base64 chuẩn
    let standard = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (standard.length % 4) standard += '=';
    const json = Buffer.from(standard, 'base64').toString('utf-8');
    const data = JSON.parse(json);

    return {
      jackettUrl: data.ju || process.env.JACKETT_URL || '',
      jackettApiKey: data.ja || process.env.JACKETT_API_KEY || '',
      torrServerUrl: data.tu || process.env.TORRSERVER_URL || '',
      maxResults: data.mr || 5,
    };
  } catch (e) {
    // Fallback env vars
    return {
      jackettUrl: process.env.JACKETT_URL || '',
      jackettApiKey: process.env.JACKETT_API_KEY || '',
      torrServerUrl: process.env.TORRSERVER_URL || '',
      maxResults: 5,
    };
  }
}

/**
 * Sinh UUID v4
 */
function generateUUID() {
  return crypto.randomUUID();
}

// ============================================================================
// 3. JACKETT API & HELPERS
// ============================================================================

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

function extractTrackers(magnetUri) {
  if (!magnetUri) return [];
  const trackers = [];
  try {
    const params = new URLSearchParams(magnetUri.split('?')[1] || '');
    params.forEach((v, k) => { if (k === 'tr' && v) trackers.push(`tracker:${v}`); });
  } catch (e) { /* ignore */ }
  return trackers;
}

function guessExtension(cat) {
  if (!cat) return 'mkv';
  const c = cat.toLowerCase();
  if (c.includes('uhd') || c.includes('4k') || c.includes('2160p')) return 'mp4';
  if (c.includes('hd') || c.includes('1080p') || c.includes('720p')) return 'mp4';
  if (c.includes('audio') || c.includes('music')) return 'mp3';
  return 'mkv';
}

function extractIMDbId(id) {
  if (!id) return '';
  const m = id.match(/^(tt\d+)/);
  return m ? m[1] : '';
}

// ============================================================================
// 4. STREAM HANDLER (nhận config object, trả về streams array)
// ============================================================================

async function handleStream(config, type, id) {
  try {
    if (!config.jackettUrl || !config.jackettApiKey) {
      console.log('[Stream] No config');
      return { streams: [] };
    }

    const imdbId = extractIMDbId(id);
    if (!imdbId) return { streams: [] };

    console.log(`[Stream] ${type} ${imdbId}`);
    const results = await searchJackett(config, imdbId);

    if (!results || results.length === 0) return { streams: [] };

    const streams = results.slice(0, config.maxResults).map((r) => {
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

    console.log(`[Stream] → ${streams.length} streams`);
    return { streams, cacheMaxAge: 600 };
  } catch (err) {
    console.error('[Stream] Error:', err.message);
    return { streams: [] };
  }
}

// ============================================================================
// 5. EXPRESS — Routes
// ============================================================================

const CONFIG_PAGE_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jackett Torrents - Tạo Config</title>
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
    .container { max-width: 560px; width: 100%; }
    .header { text-align: center; margin-bottom: 40px; }
    .header h1 { font-size: 28px; color: #fff; margin-bottom: 4px; }
    .header h1 span { color: #5b9cf5; }
    .header p { color: #888; font-size: 14px; }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 32px;
    }
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
    .result-box {
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid #2a2a2a;
    }
    .result-box h3 { color: #4ade80; font-size: 15px; margin-bottom: 12px; }
    .manifest-url {
      background: #0a0a1a;
      border: 1px solid #1a2a4a;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 12px;
      color: #5b9cf5;
      word-break: break-all;
      user-select: all;
      margin-bottom: 12px;
    }
    .btn-install {
      display: inline-block;
      padding: 12px 24px;
      background: #5b9cf5;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
    }
    .btn-install:hover { background: #4a8be4; }
    .btn-secondary {
      display: inline-block;
      padding: 12px 24px;
      background: #2a2a2a;
      color: #ccc;
      text-decoration: none;
      border-radius: 8px;
      font-size: 14px;
      margin-left: 8px;
    }
    .btn-secondary:hover { background: #333; }
    .footer { text-align: center; color: #444; font-size: 12px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚡ Jackett <span>Torrents</span></h1>
      <p>Tạo URL Stremio Addon cá nhân</p>
    </div>

    <div class="card">
      <form method="POST" action="/configure">
        <label>🔗 Jackett Server URL</label>
        <input type="url" name="jackettUrl" value="{{JACKETT_URL}}" placeholder="http://192.168.1.100:9117" required>
        <div class="hint">Địa chỉ server Jackett</div>

        <label>🔑 Jackett API Key</label>
        <input type="text" name="jackettApiKey" value="{{JACKETT_API_KEY}}" placeholder="abc123..." required>
        <div class="hint">API key trang Dashboard của Jackett</div>

        <label>📡 TorrServer URL (tùy chọn)</label>
        <input type="url" name="torrServerUrl" value="{{TORRSERVER_URL}}" placeholder="http://192.168.1.100:8090">
        <div class="hint">Để trống nếu dùng Stremio built-in torrent client</div>

        <label>📊 Số kết quả tối đa</label>
        <input type="number" name="maxResults" value="{{MAX_RESULTS}}" min="1" max="20">

        <button type="submit" class="btn">🔗 Tạo URL cá nhân</button>
      </form>

      {{RESULT_SECTION}}
    </div>

    <div class="footer">Jackett Torrents Addon v1.0.0</div>
  </div>
</body>
</html>`;

function renderConfigPage(baseUrl, formData, resultUrl) {
  let html = CONFIG_PAGE_HTML
    .replace(/{{JACKETT_URL}}/g, escapeHtml(formData?.jackettUrl || ''))
    .replace(/{{JACKETT_API_KEY}}/g, escapeHtml(formData?.jackettApiKey || ''))
    .replace(/{{TORRSERVER_URL}}/g, escapeHtml(formData?.torrServerUrl || ''))
    .replace(/{{MAX_RESULTS}}/g, formData?.maxResults || '5');

  if (resultUrl) {
    const stremioLink = `stremio://${resultUrl.replace(/^https?:\/\//, '')}`;
    html = html.replace(
      '{{RESULT_SECTION}}',
      `<div class="result-box">
        <h3>✅ URL của bạn đã sẵn sàng!</h3>
        <p style="color:#888;font-size:13px;margin-bottom:8px;">Copy URL này vào Stremio:</p>
        <div class="manifest-url">${escapeHtml(resultUrl)}</div>
        <a class="btn-install" href="${escapeHtml(stremioLink)}" target="_blank">🚀 Mở trong Stremio</a>
        <a class="btn-secondary" href="/configure">🔄 Tạo URL khác</a>
      </div>`
    );
  } else {
    html = html.replace('{{RESULT_SECTION}}', '');
  }

  return html;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Express setup ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============== CONFIG PAGE ==============

// GET /configure — hiển thị form
app.get('/configure', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.send(renderConfigPage(baseUrl, null, null));
});

// POST /configure — tạo URL config
app.post('/configure', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const uuid = generateUUID();
  const b64 = encodeConfig(req.body);
  const manifestUrl = `${baseUrl}/stremio/${uuid}/${b64}/manifest.json`;
  res.send(renderConfigPage(baseUrl, req.body, manifestUrl));
});

// ============== STREMIO ADDON ROUTES ==============

// GET /stremio/:uuid/:config/manifest.json
app.get('/stremio/:uuid/:config/manifest.json', (req, res) => {
  res.json(MANIFEST);
});

// GET /stremio/:uuid/:config/stream/:type/:id.json
app.get('/stremio/:uuid/:config/stream/:type/:id.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  const { type, id } = req.params;
  const result = await handleStream(config, type, id);
  res.json(result);
});

// ============== LANDING & HEALTH ==============

// GET / — redirect đến /configure
app.get('/', (req, res) => {
  res.redirect('/configure');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// 6. STARTUP
// ============================================================================

const PORT = parseInt(process.env.PORT || '7860', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.split('').map(() => '=').join(''));
  console.log('  Jackett + TorrServer Stremio Addon');
  console.log('='.split('').map(() => '=').join(''));
  console.log(`  Server:   http://0.0.0.0:${PORT}`);
  console.log(`  Config:   http://0.0.0.0:${PORT}/configure`);
  console.log(`  Manifest: http://0.0.0.0:${PORT}/stremio/:uuid/:config/manifest.json`);
  console.log(`  Health:   http://0.0.0.0:${PORT}/health`);
  console.log('='.split('').map(() => '=').join(''));
});
