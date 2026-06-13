#!/usr/bin/env node
// ============================================================================
// UniTorrent — Multi-Provider Stremio Addon
// ============================================================================
// Providers: Jackett, Prowlarr, Torrentio, Comet, Jacred, MediaFusion
// Config embedded in URL (base64) — TorrServer HTTP streaming support
// ============================================================================

const crypto = require('crypto');
const express = require('express');

// ============================================================================
// 1. DEBUG & CONFIG
// ============================================================================
const DEBUG = process.env.DEBUG === 'true';
const log = (...args) => { if (DEBUG) console.log('[UniTorrent]', ...args); };
const err = (...args) => console.error('[UniTorrent:ERR]', ...args);

// ---- In-memory cache with per-config isolation ----
const resultCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function cacheKey(type, id, cfg) {
  const sig = [cfg.jackettUrl, cfg.prowlarrUrl, cfg.torrentioUrl, cfg.cometUrl, cfg.jacredUrl, cfg.mediafusionUrl].filter(Boolean).join('|');
  return `${sig}:${type}:${id}`;
}
function cacheGet(key) {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { resultCache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) { resultCache.set(key, { ts: Date.now(), data }); }

// ============================================================================
// 2. MANIFEST
// ============================================================================
const MANIFEST = {
  id: 'com.unitorrent.addon',
  version: '2.0.0',
  name: 'UniTorrent',
  description: 'Multi-provider: Jackett + Prowlarr + Torrentio + Comet + Jacred + MediaFusion → TorrServer',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  config: '/configuration',
};

// ============================================================================
// 3. CONFIG ENCODING
// ============================================================================
// Compact format to keep base64 short:
// {
//   j: { u: "jackettUrl", k: "jackettApiKey" },
//   p: { u: "prowlarrUrl", k: "prowlarrApiKey" },
//   t: { u: "torrentioUrl", c: "torrentioConfigString" },
//   o: { u: "cometUrl" },
//   a: { u: "jacredUrl", k: "jacredApiKey" },
//   f: { u: "mediafusionUrl" },
//   s: { u: "torrServerUrl", a: "user:pass", t: "official|fork" },
//   m: 5  // maxResults
// }
function encodeConfig(config) {
  const c = {};
  if (config.jackettUrl) c.j = { u: config.jackettUrl.replace(/\/$/, ''), k: config.jackettApiKey || '' };
  if (config.prowlarrUrl) c.p = { u: config.prowlarrUrl.replace(/\/$/, ''), k: config.prowlarrApiKey || '' };
  if (config.torrentioEnabled && config.torrentioUrl) c.t = { u: config.torrentioUrl.replace(/\/$/, ''), c: config.torrentioConfig || '' };
  if (config.cometUrl) c.o = { u: config.cometUrl.replace(/\/$/, '') };
  if (config.jacredUrl) c.a = { u: config.jacredUrl.replace(/\/$/, ''), k: config.jacredApiKey || '' };
  if (config.mediafusionUrl) c.f = { u: config.mediafusionUrl.replace(/\/$/, '') };
  if (config.torrServerUrl) {
    c.s = { u: config.torrServerUrl.replace(/\/$/, '') };
    if (config.torrServerUser || config.torrServerPassword) {
      c.s.a = `${config.torrServerUser || ''}:${config.torrServerPassword || ''}`;
    }
    if (config.torrServerType && config.torrServerType !== 'official') {
      c.s.t = config.torrServerType;
    }
    if (config.saveToDb) {
      c.s.d = true;
    }
  }
  if (config.providerOrder) {
    c.r = config.providerOrder;
  }
  c.m = Math.min(Math.max(parseInt(config.maxResults || '5', 10) || 5, 1), 20);
  return Buffer.from(JSON.stringify(c)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeConfig(b64) {
  try {
    let s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const d = JSON.parse(Buffer.from(s, 'base64').toString('utf-8'));
    const cfg = { maxResults: d.m || 5, providerOrder: Array.isArray(d.r) ? d.r : undefined };
    if (d.j) { cfg.jackettUrl = d.j.u; cfg.jackettApiKey = d.j.k; }
    if (d.p) { cfg.prowlarrUrl = d.p.u; cfg.prowlarrApiKey = d.p.k; }
    // Torrentio: old format { e, c } or new format { u, c }
    if (d.t) {
      if (d.t.u) { cfg.torrentioUrl = d.t.u; cfg.torrentioConfig = d.t.c || ''; }
      else if (d.t.e) { cfg.torrentioUrl = 'https://torrentio.strem.fun'; cfg.torrentioConfig = d.t.c || ''; }
    }
    if (d.o && d.o.u) { cfg.cometUrl = d.o.u; }
    if (d.a && d.a.u) { cfg.jacredUrl = d.a.u; cfg.jacredApiKey = d.a.k || ''; }
    if (d.f && d.f.u) { cfg.mediafusionUrl = d.f.u; }
    if (d.s) {
      if (typeof d.s === 'string') { cfg.torrServerUrl = d.s; }
      else {
        cfg.torrServerUrl = d.s.u;
        cfg.torrServerType = d.s.t || 'official';
        if (d.s.a) {
          const sep = d.s.a.indexOf(':');
          if (sep >= 0) { cfg.torrServerUser = d.s.a.slice(0, sep); cfg.torrServerPassword = d.s.a.slice(sep + 1); }
          else { cfg.torrServerPassword = d.s.a; }
        }
        cfg.saveToDb = !!d.s.d;
      }
    }
    return cfg;
  } catch (e) {
    return {
      jackettUrl: process.env.JACKETT_URL || '',
      jackettApiKey: process.env.JACKETT_API_KEY || '',
      prowlarrUrl: process.env.PROWLARR_URL || '',
      prowlarrApiKey: process.env.PROWLARR_API_KEY || '',
      torrentioUrl: process.env.TORRENTIO_URL || 'https://torrentio.strem.fun',
      torrentioConfig: process.env.TORRENTIO_CONFIG || '',
      cometUrl: process.env.COMET_URL || '',
      jacredUrl: process.env.JACRED_URL || '',
      jacredApiKey: process.env.JACRED_API_KEY || '',
      mediafusionUrl: process.env.MEDIAFUSION_URL || '',
      torrServerUrl: process.env.TORRSERVER_URL || '',
      torrServerUser: process.env.TORRSERVER_USER || '',
      torrServerPassword: process.env.TORRSERVER_PASSWORD || '',
      saveToDb: false,
      maxResults: 5,
    };
  }
}

function generateUUID() { return crypto.randomUUID(); }

// ============================================================================
// 4. PROVIDER SEARCHERS
// ============================================================================

function extractIMDbId(id) {
  if (!id) return '';
  const m = id.match(/^(tt\d+)/);
  return m ? m[1] : '';
}

function extractTrackers(magnetUri) {
  if (!magnetUri) return [];
  const t = [];
  try { new URLSearchParams(magnetUri.split('?')[1] || '').forEach((v, k) => { if (k === 'tr' && v) t.push(`tracker:${v}`); }); } catch (e) { }
  return t;
}

function guessExtension(cat) {
  if (!cat) return 'mkv';
  const c = cat.toLowerCase();
  if (c.includes('uhd') || c.includes('4k') || c.includes('2160p')) return 'mp4';
  if (c.includes('hd') || c.includes('1080p') || c.includes('720p')) return 'mp4';
  if (c.includes('audio') || c.includes('music')) return 'mp3';
  return 'mkv';
}

function buildStreamEntry(r, cfg) {
  const label = `⬆${r.Seeders || 0} ${r.Title}`;
  const stream = {
    name: `${r._provider ? '[' + r._provider.toUpperCase() + '] ' : ''}${label}`,
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
  if (cfg.torrServerUrl) {
    delete stream.infoHash; delete stream.fileIdx; delete stream.sources;
    let baseUrl = cfg.torrServerUrl.replace(/\/$/, '');
    // Embed HTTP Basic Auth in URL if credentials provided
    if (cfg.torrServerUser || cfg.torrServerPassword) {
      const u = encodeURIComponent(cfg.torrServerUser || '');
      const p = encodeURIComponent(cfg.torrServerPassword || '');
      baseUrl = baseUrl.replace(/^(https?:\/\/)/i, `$1${u}:${p}@`);
    }
    // Use MagnetUri if available, otherwise construct from InfoHash
    const torrentLink = r.MagnetUri || (r.InfoHash ? `magnet:?xt=urn:btih:${r.InfoHash}` : '');
    stream.url = `${baseUrl}/stream?link=${encodeURIComponent(torrentLink)}&index=1&play${cfg.saveToDb ? '&save=true' : ''}`;
    stream.title = label;
    stream.behaviorHints.notWebReady = false;
  }
  return stream;
}

// ---- Jackett ----
async function searchJackett(cfg, imdbId) {
  if (!cfg.jackettUrl || !cfg.jackettApiKey) return [];
  const params = new URLSearchParams({ apikey: cfg.jackettApiKey, imdbid: imdbId });
  const url = `${cfg.jackettUrl}/api/v2.0/indexers/all/results?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jackett HTTP ${res.status}`);
  const data = await res.json();
  return (data.Results || []).map(r => ({ ...r, _provider: 'Jackett' }))
    .sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));
}

// ---- Prowlarr ----
async function searchProwlarr(cfg, imdbId, type) {
  if (!cfg.prowlarrUrl || !cfg.prowlarrApiKey) return [];
  const searchType = type === 'series' ? 'tvsearch' : 'movie';
  // Prowlarr uses structured query format: {ImdbId:tt...}
  const params = new URLSearchParams({
    query: `{ImdbId:${imdbId}}`,
    type: searchType,
    limit: '50',
  });
  const url = `${cfg.prowlarrUrl}/api/v1/search?${params}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { 'X-Api-Key': cfg.prowlarrApiKey, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Prowlarr HTTP ${res.status}`);
  const data = await res.json();
  // Prowlarr response is an array, filter torrents only
  return (Array.isArray(data) ? data : [])
    .filter(r => r.protocol === 'torrent')
    .map(r => ({
      Title: r.title,
      Seeders: r.seeders || 0,
      Size: r.size || 0,
      InfoHash: r.infoHash || '',
      MagnetUri: r.magnetUrl || '',
      CategoryDesc: (r.categories || []).map(c => c.name).join(', '),
      _provider: 'Prowlarr',
    }))
    .sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));
}

// ---- Helper: strip /manifest.json suffix and trailing slash ----
function stripManifestPath(url) {
  return url.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
}

// Provider name → config code for priority ordering
function codeOf(provider) {
  const map = { Jackett: 'j', Prowlarr: 'p', Torrentio: 't', Comet: 'o', Jacred: 'a', MediaFusion: 'f' };
  return map[provider] || '';
}

// ---- Torrentio (HTTP proxy) ----
async function searchTorrentio(cfg, type, id) {
  if (!cfg.torrentioUrl) return [];
  const baseUrl = stripManifestPath(cfg.torrentioUrl);
  const configPart = cfg.torrentioConfig || '';
  const url = configPart
    ? `${baseUrl}/${configPart}/stream/${type}/${id}.json`
    : `${baseUrl}/stream/${type}/${id}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Torrentio HTTP ${res.status}`);
  const data = await res.json();
  return (data.streams || []).filter(s => s.infoHash).map(s => ({
    Title: s.title || s.name || '',
    Seeders: parseInt((s.name || '').match(/👤\s*(\d+)/)?.[1] || '0', 10),
    Size: s.behaviorHints?.videoSize || 0,
    InfoHash: s.infoHash || '',
    MagnetUri: '', // Torrentio doesn't provide magnet URIs
    CategoryDesc: '',
    _provider: 'Torrentio',
    _rawStream: s, // keep original for direct pass-through
  }));
}

// ---- Comet (public or self-hosted) ----
async function searchComet(cfg, type, id) {
  if (!cfg.cometUrl) return [];
  const url = `${stripManifestPath(cfg.cometUrl)}/stream/${type}/${id}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Comet HTTP ${res.status}`);
  const data = await res.json();
  return (data.streams || []).filter(s => s.infoHash || s.url).map(s => ({
    Title: s.title || s.name || '',
    Seeders: parseInt((s.name || '').match(/S:(\d+)/)?.[1] || '0', 10),
    Size: s.behaviorHints?.videoSize || 0,
    InfoHash: s.infoHash || '',
    MagnetUri: '',
    CategoryDesc: '',
    _provider: 'Comet',
    _rawStream: s,
  }));
}


// ---- MediaFusion ----
async function searchMediaFusion(cfg, type, id) {
  if (!cfg.mediafusionUrl) return [];
  const url = `${stripManifestPath(cfg.mediafusionUrl)}/D-/stream/${type}/${id}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`MediaFusion HTTP ${res.status}`);
  const data = await res.json();
  return (data.streams || []).filter(s => s.infoHash || s.url).map(s => ({
    Title: (s.title || s.name || '').replace(/\n/g, ' ').trim(),
    Seeders: parseInt((s.name || '').match(/S:(\d+)/)?.[1] || '0', 10),
    Size: s.behaviorHints?.videoSize || 0,
    InfoHash: s.infoHash || '',
    MagnetUri: '',
    CategoryDesc: '',
    _provider: 'MediaFusion',
    _rawStream: s,
  }));
}

// ---- Jacred (Jackett-compatible) ----
async function searchJacred(cfg, imdbId) {
  if (!cfg.jacredUrl || !cfg.jacredApiKey) return [];
  const params = new URLSearchParams({ apikey: cfg.jacredApiKey, query: imdbId });
  const url = `${cfg.jacredUrl}/api/v2.0/indexers/all/results?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jacred HTTP ${res.status}`);
  const data = await res.json();
  return (data.Results || []).map(r => ({ ...r, _provider: 'Jacred' }))
    .sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));
}

// ============================================================================
// 5. STREAM HANDLER (multi-provider)
// ============================================================================
async function handleStream(config, type, id) {
  const ck = cacheKey(type, id, config);
  const cached = cacheGet(ck);
  if (cached) { log(`  Cache hit for ${type}:${id}`); return cached; }

  try {
    const imdbId = extractIMDbId(id);
    if (!imdbId) {
      log(`No IMDb ID in ${id}`);
      return { streams: [] };
    }
    log(`Stream request: ${type} ${imdbId} | id=${id}`);

    // Query all providers in parallel
    const promises = [];
    if (config.jackettUrl) { log(`  + Jackett: ${config.jackettUrl}`); promises.push(searchJackett(config, imdbId)); }
    if (config.prowlarrUrl) { log(`  + Prowlarr: ${config.prowlarrUrl}`); promises.push(searchProwlarr(config, imdbId, type)); }
    if (config.torrentioUrl) { log(`  + Torrentio: ${config.torrentioUrl}`); promises.push(searchTorrentio(config, type, id)); }
    if (config.cometUrl) { log(`  + Comet: ${config.cometUrl}`); promises.push(searchComet(config, type, id)); }
    if (config.jacredUrl) { log(`  + Jacred: ${config.jacredUrl}`); promises.push(searchJacred(config, imdbId)); }
    if (config.mediafusionUrl) { log(`  + MediaFusion: ${config.mediafusionUrl}`); promises.push(searchMediaFusion(config, type, id)); }

    if (promises.length === 0) {
      log(`  No providers configured → empty`);
      return { streams: [] };
    }

    const settled = await Promise.allSettled(promises);
    const results = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(...r.value);
        log(`  ✓ ${r.value.length || 0} results from a provider`);
      } else {
        err(`  ✗ Provider error: ${r.reason?.message || r.reason}`);
      }
    }

    if (results.length === 0) {
      log(`  All providers returned 0 results`);
      return { streams: [] };
    }

    // Dedup by infoHash
    const seen = new Set();
    const unique = results.filter(r => {
      if (!r.InfoHash) return true;
      if (seen.has(r.InfoHash)) return false;
      seen.add(r.InfoHash);
      return true;
    });

    // Sort by provider priority, then seeders
    const order = config.providerOrder || ['j','p','t','o','a','f'];
    const orderIdx = { j: 0, p: 1, t: 2, o: 3, a: 4, f: 5 };
    unique.sort((a, b) => {
      const pa = order.indexOf(codeOf(a._provider));
      const pb = order.indexOf(codeOf(b._provider));
      if (pa !== pb) return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
      return (b.Seeders || 0) - (a.Seeders || 0);
    });

    const maxResults = config.maxResults || 5;
    const streams = unique.slice(0, maxResults).map(r => {
      // If TorrServer configured, route EVERYTHING through TorrServer
      if (config.torrServerUrl) {
        const s = buildStreamEntry(r, config);
        log(`  → TorrServer: ${s.url?.slice(0, 100)}...`);
        return s;
      }
      // Proxy-style providers (Torrentio, Comet, MediaFusion) — pass through raw stream format
      if ((r._provider === 'Torrentio' || r._provider === 'Comet' || r._provider === 'MediaFusion') && r._rawStream) {
        const s = { ...r._rawStream };
        s.name = `[${r._provider}] ${s.name || ''}`;
        log(`  → Proxy pass: ${r._provider} infoHash=${s.infoHash?.slice(0, 12)}...`);
        return s;
      }
      return buildStreamEntry(r, config);
    });

    log(`  → ${streams.length} streams returned (${results.length} raw, ${unique.length} unique)`);
    const out = { streams, cacheMaxAge: 600 };
    cacheSet(ck, out);
    return out;
  } catch (err_) {
    err(`Stream error: ${err_.message}`);
    return { streams: [] };
  }
}

// ============================================================================
// 5. WEB UI — MediaFusion-inspired
// ============================================================================

const WEB_HTML = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>UniTorrent - Multi-Provider Stremio Addon</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--bg-card:#14141e;--border:#1e1e30;--text:#e0e0e8;--text-dim:#8888a0;--primary:#7c3aed;--primary-hover:#8b5cf6;--accent:#f59e0b;--success:#10b981;--error:#ef4444;--radius:10px}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column}
.header{padding:16px 20px;text-align:center;border-bottom:1px solid var(--border)}
.header h1{font-size:20px;font-weight:700}
.header p{font-size:13px;color:var(--text-dim);margin-top:2px}
.tab-content{flex:1;overflow-y:auto;padding:12px}
.tab-content .tab-pane{display:none}
.tab-content .tab-pane.active{display:block}
.tab-bar{display:flex;border-top:1px solid var(--border);background:var(--bg-card);position:sticky;bottom:0}
.tab-btn{flex:1;padding:12px;text-align:center;font-size:13px;font-weight:600;cursor:pointer;color:var(--text-dim);border:none;background:none;transition:all .15s}
.tab-btn.active{color:var(--accent);background:rgba(245,158,11,.08)}
.tab-btn:hover{color:var(--text)}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px;overflow:hidden}
.card-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600}
.badge{font-size:11px;padding:2px 8px;border-radius:4px;background:var(--border);color:var(--text-dim)}
.badge.success{background:rgba(16,185,129,.15);color:var(--success)}
.badge.error{background:rgba(239,68,68,.15);color:var(--error)}
.provider-card{padding:10px 14px}
.provider-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.provider-name{font-size:13px;font-weight:600}
.toggle{width:40px;height:22px;border-radius:11px;background:var(--border);cursor:pointer;position:relative;transition:background .2s;flex-shrink:0}
.toggle.active{background:var(--primary)}
.toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .2s}
.toggle.active::after{transform:translateX(18px)}
.form-group{margin-bottom:8px}
.form-group label{display:block;font-size:12px;font-weight:600;margin-bottom:3px;color:var(--text-dim)}
.form-group input,.form-group select{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;outline:none;transition:border-color .15s}
.form-group input:focus,.form-group select:focus{border-color:var(--primary)}
.form-group .hint{font-size:11px;color:var(--text-dim);margin-top:3px;word-break:break-all}
.form-group .hint code{background:var(--bg-card);padding:1px 4px;border-radius:3px;font-size:10px}
.btn{display:inline-flex;align-items:center;gap:4px;padding:7px 14px;border-radius:6px;border:none;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover{background:var(--primary-hover)}
.btn-success{background:var(--success);color:#fff}
.btn-secondary{background:var(--border);color:var(--text)}
.btn-secondary:hover{background:#2a2a40}
.btn-sm{padding:5px 10px;font-size:11px}
.test-result{display:none;margin-top:6px;padding:6px 10px;border-radius:6px;font-size:12px}
.test-result.show{display:block}
.test-result.success{background:rgba(16,185,129,.1);color:var(--success)}
.test-result.error{background:rgba(239,68,68,.1);color:var(--error)}
.result-box{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-top:12px;word-break:break-all}
.result-url{font-size:12px;color:var(--text-dim);margin-bottom:10px;word-break:break-all}
.result-actions{display:flex;gap:8px;flex-wrap:wrap}
.toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a1a28;color:var(--text);padding:10px 20px;border-radius:8px;font-size:13px;border:1px solid var(--border);opacity:0;transition:opacity .3s;pointer-events:none;z-index:100}
.toast.show{opacity:1}
</style>
</head>
<body>
<div class="header">
  <h1>UniTorrent</h1>
  <p>Jackett + Prowlarr + Torrentio + Comet + Jacred + MediaFusion → TorrServer</p>
</div>

<div class="tab-content">
  <div class="tab-pane active" id="tab-providers">
    <!-- Jackett -->
    <div class="card">
      <div class="card-header">
        Jackett <span class="badge" id="jackettBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name">Jackett</span>
          <label class="toggle" id="jackettToggle"></label>
        </div>
        <div class="form-group">
          <label>Jackett URL</label>
          <input type="url" id="jackettUrl" placeholder="http://192.168.1.100:9117">
        </div>
        <div class="form-group">
          <label>API Key</label>
          <input type="text" id="jackettApiKey" placeholder="API Key from Jackett">
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary btn-sm" onclick="testJackett()">Test</button>
          <div style="margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">
            Priority
            <input type="number" id="jackettPriority" min="1" max="6" value="3" style="width:40px;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;text-align:center">
          </div>
        </div>
        <div class="test-result" id="jackettTestResult"></div>
      </div>
    </div>
    <!-- Prowlarr -->
    <div class="card">
      <div class="card-header">
        Prowlarr <span class="badge" id="prowlarrBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name">Prowlarr</span>
          <label class="toggle" id="prowlarrToggle"></label>
        </div>
        <div class="form-group">
          <label>Prowlarr URL</label>
          <input type="url" id="prowlarrUrl" placeholder="http://192.168.1.100:9696">
        </div>
        <div class="form-group">
          <label>API Key</label>
          <input type="text" id="prowlarrApiKey" placeholder="API Key from Prowlarr">
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary btn-sm" onclick="testProwlarr()">Test</button>
          <div style="margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">
            Priority
            <input type="number" id="prowlarrPriority" min="1" max="6" value="3" style="width:40px;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;text-align:center">
          </div>
        </div>
        <div class="test-result" id="prowlarrTestResult"></div>
      </div>
    </div>
    <!-- Torrentio -->
    <div class="card">
      <div class="card-header">
        Torrentio <span class="badge" id="torrentioBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name">Torrentio</span>
          <label class="toggle" id="torrentioToggle"></label>
        </div>
        <div class="form-group">
          <label>Torrentio Manifest URL</label>
          <input type="url" id="torrentioUrl" placeholder="https://torrentio.strem.fun/manifest.json">
          <div class="hint">Or with config: <code>https://torrentio.strem.fun/&lt;config&gt;/manifest.json</code></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;justify-content:flex-end">
          <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">
            Priority
            <input type="number" id="torrentioPriority" min="1" max="6" value="3" style="width:40px;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;text-align:center">
          </div>
        </div>
      </div>
    </div>
    <!-- Comet -->
    <div class="card">
      <div class="card-header">
        Comet <span class="badge" id="cometBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name">Comet</span>
          <label class="toggle" id="cometToggle"></label>
        </div>
        <div class="form-group">
          <label>Comet Manifest URL</label>
          <input type="url" id="cometUrl" placeholder="https://comet.feels.legal/manifest.json">
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary btn-sm" onclick="testComet()">Test</button>
          <div style="margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">
            Priority
            <input type="number" id="cometPriority" min="1" max="6" value="3" style="width:40px;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;text-align:center">
          </div>
        </div>
        <div class="test-result" id="cometTestResult"></div>
      </div>
    </div>
    <!-- Jacred -->
    <div class="card">
      <div class="card-header">
        Jacred <span class="badge" id="jacredBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name">Jacred</span>
          <label class="toggle" id="jacredToggle"></label>
        </div>
        <div class="form-group">
          <label>Jacred URL</label>
          <input type="url" id="jacredUrl" placeholder="http://192.168.1.100:9120">
        </div>
        <div class="form-group">
          <label>API Key</label>
          <input type="text" id="jacredApiKey" placeholder="API Key from config">
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary btn-sm" onclick="testJacred()">Test</button>
          <div style="margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">
            Priority
            <input type="number" id="jacredPriority" min="1" max="6" value="3" style="width:40px;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;text-align:center">
          </div>
        </div>
        <div class="test-result" id="jacredTestResult"></div>
      </div>
    </div>
    <!-- MediaFusion -->
    <div class="card">
      <div class="card-header">
        MediaFusion <span class="badge" id="mediafusionBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name">MediaFusion</span>
          <label class="toggle" id="mediafusionToggle"></label>
        </div>
        <div class="form-group">
          <label>MediaFusion Manifest URL</label>
          <input type="url" id="mediafusionUrl" placeholder="https://mediafusion.elfhosted.com/manifest.json">
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary btn-sm" onclick="testMediafusion()">Test</button>
          <div style="margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">
            Priority
            <input type="number" id="mediafusionPriority" min="1" max="6" value="3" style="width:40px;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;text-align:center">
          </div>
        </div>
        <div class="test-result" id="mediafusionTestResult"></div>
      </div>
    </div>
  </div>

  <div class="tab-pane" id="tab-server">
    <div class="card">
      <div class="card-header">TorrServer</div>
      <div class="provider-card">
        <div class="form-group">
          <label>TorrServer URL</label>
          <input type="url" id="torrServerUrl" placeholder="http://192.168.1.100:8090">
        </div>
        <div class="form-group">
          <label>Username (optional)</label>
          <input type="text" id="torrServerUser" placeholder="HTTP Basic Auth user">
        </div>
        <div class="form-group">
          <label>Password (optional)</label>
          <input type="password" id="torrServerPassword" placeholder="HTTP Basic Auth password">
        </div>
        <div class="form-group">
          <label>Type</label>
          <select id="torrServerType">
            <option value="official">Official — github.com/YouROK/TorrServer</option>
            <option value="fork">Fork — github.com/9000000/TorrServer</option>
          </select>
          <div class="hint"><a href="https://github.com/YouROK/TorrServer" target="_blank" style="color:var(--accent)">Official</a> · <a href="https://github.com/9000000/TorrServer" target="_blank" style="color:var(--accent)">Fork</a></div>
          <div class="form-group" style="margin-top:8px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="saveToDb" style="width:auto">
              Save movies to TorrServer database
            </label>
            <div class="hint">Torrent persists in TorrServer after playback. Default: off.</div>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">Settings</div>
      <div class="provider-card">
        <div class="form-group">
          <label>Max Results</label>
          <input type="number" id="maxResults" min="1" max="50" value="5">
        </div>
      </div>
    </div>
  </div>

  <div class="tab-pane" id="tab-url">
    <button class="btn btn-primary" onclick="generateUrl()" style="width:100%;justify-content:center;padding:12px;font-size:14px">Generate Personal URL</button>
    <div class="result-box" id="resultBox" style="display:none">
      <div class="result-url" id="resultUrl"></div>
      <div class="result-actions">
        <button class="btn btn-success btn-sm" onclick="copyUrl()">Copy URL</button>
        <a class="btn btn-primary btn-sm" id="stremioLink" target="_blank">Open in Stremio</a>
      </div>
    </div>
  </div>
</div>

<div class="tab-bar">
  <button class="tab-btn active" onclick="switchTab('providers')">Providers</button>
  <button class="tab-btn" onclick="switchTab('server')">Server</button>
  <button class="tab-btn" onclick="switchTab('url')">URL</button>
</div>

<div class="toast" id="toast"></div>

<script>
window.switchTab = function(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  const idx = {providers:0,server:1,url:2}[name];
  if (idx != null) document.querySelectorAll('.tab-btn')[idx].classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show';
  setTimeout(() => t.classList.remove('show'), 3000);
}
function setupToggle(id) {
  const el = document.getElementById(id);
  el.addEventListener('click', (e) => { e.preventDefault(); el.classList.toggle('active'); });
}
setupToggle('jackettToggle');
setupToggle('prowlarrToggle');
setupToggle('torrentioToggle');
setupToggle('cometToggle');
setupToggle('jacredToggle');
setupToggle('mediafusionToggle');
function collectConfig() {
  const priorities = {
    j: parseInt(document.getElementById('jackettPriority').value) || 3,
    p: parseInt(document.getElementById('prowlarrPriority').value) || 3,
    t: parseInt(document.getElementById('torrentioPriority').value) || 3,
    o: parseInt(document.getElementById('cometPriority').value) || 3,
    a: parseInt(document.getElementById('jacredPriority').value) || 3,
    f: parseInt(document.getElementById('mediafusionPriority').value) || 3,
  };
  const providerOrder = Object.entries(priorities).sort((a, b) => a[1] - b[1]).map(e => e[0]);
  return {
    jackettUrl: document.getElementById('jackettUrl').value,
    jackettApiKey: document.getElementById('jackettApiKey').value,
    jackettEnabled: document.getElementById('jackettToggle').classList.contains('active'),
    prowlarrUrl: document.getElementById('prowlarrUrl').value,
    prowlarrApiKey: document.getElementById('prowlarrApiKey').value,
    prowlarrEnabled: document.getElementById('prowlarrToggle').classList.contains('active'),
    torrentioUrl: document.getElementById('torrentioUrl').value,
    torrentioEnabled: document.getElementById('torrentioToggle').classList.contains('active'),
    cometUrl: document.getElementById('cometUrl').value,
    cometEnabled: document.getElementById('cometToggle').classList.contains('active'),
    jacredUrl: document.getElementById('jacredUrl').value,
    jacredApiKey: document.getElementById('jacredApiKey').value,
    jacredEnabled: document.getElementById('jacredToggle').classList.contains('active'),
    mediafusionUrl: document.getElementById('mediafusionUrl').value,
    mediafusionEnabled: document.getElementById('mediafusionToggle').classList.contains('active'),
    torrServerUrl: document.getElementById('torrServerUrl').value,
    torrServerUser: document.getElementById('torrServerUser').value,
    torrServerPassword: document.getElementById('torrServerPassword').value,
    torrServerType: document.getElementById('torrServerType').value,
    saveToDb: document.getElementById('saveToDb').checked,
    maxResults: document.getElementById('maxResults').value || 5,
    providerOrder,
  };
}
async function generateUrl() {
  const cfg = collectConfig();
  const hasJackett = cfg.jackettEnabled && cfg.jackettUrl && cfg.jackettApiKey;
  const hasProwlarr = cfg.prowlarrEnabled && cfg.prowlarrUrl && cfg.prowlarrApiKey;
  const hasTorrentio = cfg.torrentioEnabled && cfg.torrentioUrl;
  const hasComet = cfg.cometEnabled && cfg.cometUrl;
  const hasJacred = cfg.jacredEnabled && cfg.jacredUrl && cfg.jacredApiKey;
  const hasMediaFusion = cfg.mediafusionEnabled && cfg.mediafusionUrl;
  if (!hasJackett && !hasProwlarr && !hasTorrentio && !hasComet && !hasJacred && !hasMediaFusion) {
    showToast('Enable at least 1 provider');
    return;
  }
  try {
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (!resp.ok) { showToast('Server error'); return; }
    const data = await resp.json();
    document.getElementById('resultUrl').textContent = data.manifestUrl;
    document.getElementById('stremioLink').href = data.stremioLink;
    document.getElementById('resultBox').style.display = 'block';
    switchTab('url');
  } catch (e) { showToast('Error: ' + e.message); }
}
function copyUrl() {
  const text = document.getElementById('resultUrl').textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('URL copied!'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    document.body.removeChild(ta); showToast('URL copied!');
  }
}
async function testJackett() {
  const url = document.getElementById('jackettUrl').value;
  const key = document.getElementById('jackettApiKey').value;
  const el = document.getElementById('jackettTestResult');
  if (!url || !key) { el.className = 'test-result show error'; el.textContent = 'Enter URL and API Key'; return; }
  try {
    el.className = 'test-result'; el.textContent = 'Testing...';
    const r = await fetch('/api/test/jackett?url=' + encodeURIComponent(url) + '&key=' + encodeURIComponent(key));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? d.message : d.message;
    document.getElementById('jackettBadge').textContent = d.ok ? 'OK' : 'Error';
    document.getElementById('jackettBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) { el.className = 'test-result show error'; el.textContent = e.message; }
}
async function testProwlarr() {
  const url = document.getElementById('prowlarrUrl').value;
  const key = document.getElementById('prowlarrApiKey').value;
  const el = document.getElementById('prowlarrTestResult');
  if (!url || !key) { el.className = 'test-result show error'; el.textContent = 'Enter URL and API Key'; return; }
  try {
    el.className = 'test-result'; el.textContent = 'Testing...';
    const r = await fetch('/api/test/prowlarr?url=' + encodeURIComponent(url) + '&key=' + encodeURIComponent(key));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? d.message : d.message;
    document.getElementById('prowlarrBadge').textContent = d.ok ? 'OK' : 'Error';
    document.getElementById('prowlarrBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) { el.className = 'test-result show error'; el.textContent = e.message; }
}
async function testComet() {
  const url = document.getElementById('cometUrl').value;
  const el = document.getElementById('cometTestResult');
  if (!url) { el.className = 'test-result show error'; el.textContent = 'Enter URL'; return; }
  try {
    el.className = 'test-result'; el.textContent = 'Testing...';
    const r = await fetch('/api/test/comet?url=' + encodeURIComponent(url));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? d.message : d.message;
    document.getElementById('cometBadge').textContent = d.ok ? 'OK' : 'Error';
    document.getElementById('cometBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) { el.className = 'test-result show error'; el.textContent = e.message; }
}
async function testJacred() {
  const url = document.getElementById('jacredUrl').value;
  const key = document.getElementById('jacredApiKey').value;
  const el = document.getElementById('jacredTestResult');
  if (!url || !key) { el.className = 'test-result show error'; el.textContent = 'Enter URL and API Key'; return; }
  try {
    el.className = 'test-result'; el.textContent = 'Testing...';
    const r = await fetch('/api/test/jacred?url=' + encodeURIComponent(url) + '&key=' + encodeURIComponent(key));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? d.message : d.message;
    document.getElementById('jacredBadge').textContent = d.ok ? 'OK' : 'Error';
    document.getElementById('jacredBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) { el.className = 'test-result show error'; el.textContent = e.message; }
}
async function testMediafusion() {
  const url = document.getElementById('mediafusionUrl').value;
  const el = document.getElementById('mediafusionTestResult');
  if (!url) { el.className = 'test-result show error'; el.textContent = 'Enter URL'; return; }
  try {
    el.className = 'test-result'; el.textContent = 'Testing...';
    const r = await fetch('/api/test/mediafusion?url=' + encodeURIComponent(url));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? d.message : d.message;
    document.getElementById('mediafusionBadge').textContent = d.ok ? 'OK' : 'Error';
    document.getElementById('mediafusionBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) { el.className = 'test-result show error'; el.textContent = e.message; }
}
(function() {
  if (!window.__CONFIG__) return;
  const c = window.__CONFIG__;
  const fields = {
    jackettUrl: c.jackettUrl, jackettApiKey: c.jackettApiKey,
    prowlarrUrl: c.prowlarrUrl, prowlarrApiKey: c.prowlarrApiKey,
    torrentioUrl: c.torrentioUrl,
    cometUrl: c.cometUrl,
    jacredUrl: c.jacredUrl, jacredApiKey: c.jacredApiKey,
    mediafusionUrl: c.mediafusionUrl,
    torrServerUrl: c.torrServerUrl, torrServerUser: c.torrServerUser,
    torrServerPassword: c.torrServerPassword, torrServerType: c.torrServerType || 'official',
    saveToDb: c.saveToDb || false,
    maxResults: c.maxResults || 5,
    jackettPriority: 3, prowlarrPriority: 3, torrentioPriority: 3,
    cometPriority: 3, jacredPriority: 3, mediafusionPriority: 3,
  };
  // Apply providerOrder to priority fields
  if (Array.isArray(c.providerOrder)) {
    const map = { j: 'jackettPriority', p: 'prowlarrPriority', t: 'torrentioPriority', o: 'cometPriority', a: 'jacredPriority', f: 'mediafusionPriority' };
    c.providerOrder.forEach((code, idx) => { if (map[code]) fields[map[code]] = idx + 1; });
  }
  };
  const toggleMap = {
    jackettUrl: 'jackettToggle', prowlarrUrl: 'prowlarrToggle',
    torrentioUrl: 'torrentioToggle', cometUrl: 'cometToggle',
    jacredUrl: 'jacredToggle', mediafusionUrl: 'mediafusionToggle',
  };
  for (const [id, val] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') { el.checked = !!val; }
    else { el.value = val != null ? val : ''; }
  }
  for (const [fieldId, toggleId] of Object.entries(toggleMap)) {
    const toggle = document.getElementById(toggleId);
    if (toggle && fields[fieldId]) toggle.classList.add('active');
  }
})();
</script>
</body>
</html>`;
// ============================================================================
// 6. EXPRESS SERVER
// ============================================================================

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Suppress browser console warnings about Permissions-Policy features
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy',
    'browsing-topics=(), run-ad-auction=(), join-ad-interest-group=(), private-aggregation=()');
  next();
});

// ---- Helper: build config from Stremio query params (native config UI) ----
function configFromQuery(q) {
  return {
    jackettUrl: q.jackettUrl || '',
    jackettApiKey: q.jackettApiKey || '',
    prowlarrUrl: q.prowlarrUrl || '',
    prowlarrApiKey: q.prowlarrApiKey || '',
    torrentioUrl: q.torrentioUrl || '',
    torrentioConfig: q.torrentioConfig || '',
    cometUrl: q.cometUrl || '',
    jacredUrl: q.jacredUrl || '',
    jacredApiKey: q.jacredApiKey || '',
    mediafusionUrl: q.mediafusionUrl || '',
    torrServerUrl: q.torrServerUrl || '',
    torrServerUser: q.torrServerUser || '',
    torrServerPassword: q.torrServerPassword || '',
    torrServerType: q.torrServerType || 'official',
    saveToDb: q.saveToDb === 'true' || q.saveToDb === '1',
    providerOrder: q.providerOrder ? q.providerOrder.split(',') : undefined,
    maxResults: parseInt(q.maxResults || '5', 10) || 5,
  };
}

// ---- Clean routes for Stremio native config ----
// Manifest (no embedded config — Stremio shows config form)
app.get('/manifest.json', (req, res) => {
  res.json(getManifest(true));
});
// Stream search with config from query params (Stremio passes config values)
app.get('/stream/:type/:id.json', async (req, res) => {
  const cfg = configFromQuery(req.query);
  log(`Clean stream: ${req.params.type} ${req.params.id} from query config`);
  const result = await handleStream(cfg, req.params.type, req.params.id);
  res.json(result);
});

// ---- Config page ----
function serveConfigPage(req, res, initialConfig) {
  let html = WEB_HTML;
  if (initialConfig) {
    // Inject initial config as JSON for client JS to pre-fill
    const script = `<script>window.__CONFIG__ = ${JSON.stringify(initialConfig)};</script>`;
    html = html.replace('</head>', script + '</head>');
  }
  res.type('html').send(html);
}

app.get('/configure', (req, res) => serveConfigPage(req, res, null));
app.get('/configuration', (req, res) => serveConfigPage(req, res, null));
// Edit existing config — decode and pre-fill form
app.get('/:config/configure', (req, res) => {
  try {
    const config = decodeConfig(req.params.config);
    serveConfigPage(req, res, config);
  } catch { serveConfigPage(req, res, null); }
});
app.get('/:config/configuration', (req, res) => {
  try {
    const config = decodeConfig(req.params.config);
    serveConfigPage(req, res, config);
  } catch { serveConfigPage(req, res, null); }
});
app.get('/', (req, res) => res.redirect('/configure'));

// ---- Health ----
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ---- API: Generate URL ----
app.post('/api/generate', (req, res) => {
  const body = req.body || {};
  const cfg = {
    jackettUrl: body.jackettEnabled ? (body.jackettUrl || '') : '',
    jackettApiKey: body.jackettEnabled ? (body.jackettApiKey || '') : '',
    prowlarrUrl: body.prowlarrEnabled ? (body.prowlarrUrl || '') : '',
    prowlarrApiKey: body.prowlarrEnabled ? (body.prowlarrApiKey || '') : '',
    torrentioUrl: body.torrentioEnabled ? (body.torrentioUrl || '') : '',
    torrentioEnabled: !!body.torrentioEnabled,
    cometUrl: body.cometEnabled ? (body.cometUrl || '') : '',
    jacredUrl: body.jacredEnabled ? (body.jacredUrl || '') : '',
    jacredApiKey: body.jacredEnabled ? (body.jacredApiKey || '') : '',
    mediafusionUrl: body.mediafusionEnabled ? (body.mediafusionUrl || '') : '',
    torrServerUrl: body.torrServerUrl || '',
    torrServerUser: body.torrServerUser || '',
    torrServerPassword: body.torrServerPassword || '',
    torrServerType: body.torrServerType || 'official',
    saveToDb: !!body.saveToDb,
    providerOrder: Array.isArray(body.providerOrder) ? body.providerOrder : undefined,
    maxResults: body.maxResults || 5,
  };
  const b64 = encodeConfig(cfg);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const manifestUrl = `${baseUrl}/${b64}/manifest.json`;
  const stremioLink = `stremio://${manifestUrl.replace(/^https?:\/\//, '')}`;
  res.json({ manifestUrl, stremioLink });
});

// ---- API: Test Jackett ----
app.get('/api/test/jackett', async (req, res) => {
  try {
    const { url, key } = req.query;
    if (!url || !key) { res.json({ ok: false, message: 'Missing URL or API Key' }); return; }
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(key)}&query=tt0133093`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const count = (data.Results || []).length;
    res.json({ ok: true, message: `✅ Jackett OK — ${count} results for The Matrix` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---- API: Test Prowlarr ----
app.get('/api/test/prowlarr', async (req, res) => {
  try {
    const { url, key } = req.query;
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v1/indexer`, {
      headers: { 'X-Api-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const enabled = Array.isArray(data) ? data.filter(i => i.enable).length : 0;
    res.json({ ok: true, message: `✅ Prowlarr OK — ${enabled} indexers enabled` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---- API: Test Comet ----
app.get('/api/test/comet', async (req, res) => {
  try {
    const { url } = req.query;
    const r = await fetch(`${stripManifestPath(url)}/stream/movie/tt0133093.json`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const count = (data.streams || []).length;
    res.json({ ok: true, message: `✅ Comet OK — ${count} streams for The Matrix` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---- API: Test Jacred ----
app.get('/api/test/jacred', async (req, res) => {
  try {
    const { url, key } = req.query;
    if (!url || !key) { res.json({ ok: false, message: 'Missing URL or API Key' }); return; }
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(key)}&query=tt0133093`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const count = (data.Results || []).length;
    res.json({ ok: true, message: `✅ Jacred OK — ${count} results for The Matrix` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---- API: Test MediaFusion ----
app.get('/api/test/mediafusion', async (req, res) => {
  try {
    const baseUrl = stripManifestPath(req.query.url || '');
    if (!baseUrl) { res.json({ ok: false, message: 'No URL provided' }); return; }
    const r = await fetch(`${baseUrl}/D-/stream/movie/tt0133093.json`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const count = (data.streams || []).length;
    res.json({ ok: true, message: `✅ MediaFusion OK — ${count} streams for The Matrix` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---- Torrentio-style routes (no UUID, just config) ----
app.get('/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  const hasConfig = !!(config.jackettUrl || config.prowlarrUrl || config.torrentioUrl || config.cometUrl || config.jacredUrl || config.mediafusionUrl);
  res.json(getManifest(!hasConfig));
});
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  const result = await handleStream(config, req.params.type, req.params.id);
  res.json(result);
});

// ---- Stremio routes ----
// Dynamic manifest: configurationRequired depends on whether config is embedded
function getManifest(configRequired) {
  return {
    ...MANIFEST,
    behaviorHints: {
      configurable: true,
      configurationRequired: configRequired,
    },
  };
}

app.get('/stremio/:uuid/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  const hasConfig = !!(config.jackettUrl || config.prowlarrUrl || config.torrentioUrl || config.cometUrl || config.jacredUrl || config.mediafusionUrl);
  res.json(getManifest(!hasConfig));
});

app.get('/stremio/:uuid/:config/stream/:type/:id.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  const { type, id } = req.params;
  const result = await handleStream(config, type, id);
  res.json(result);
});

// ============================================================================
// 7. STARTUP
// ============================================================================
const PORT = parseInt(process.env.PORT || '7860', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('  UniTorrent — Multi-Provider Stremio Addon');
  console.log('='.repeat(50));
  console.log(`  Server:   http://0.0.0.0:${PORT}`);
  console.log(`  Web UI:   http://0.0.0.0:${PORT}/configure`);
  console.log(`  Manifest: http://0.0.0.0:${PORT}/:config/manifest.json`);
  console.log(`  Example:  http://0.0.0.0:${PORT}/eyJ0Ijp7InUiOiJodHRwczovL3RvcnJlbnRpby5zdHJlbS5mdW4iLCJjIjoiIn0sIm0iOjV9/manifest.json`);
  console.log(`  Providers: Jackett / Prowlarr / Torrentio / Comet / Jacred / MediaFusion`);
  console.log('='.repeat(50));
});
