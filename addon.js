#!/usr/bin/env node
// ============================================================================
// UniTorrent — Multi-Provider Stremio Addon
// ============================================================================
// Providers: Jackett, Prowlarr, Torrentio, Comet, Meteor, Jacred, MediaFusion
// Config embedded in URL (base64) — TorrServer HTTP streaming support
// ============================================================================

const crypto = require('crypto');
const express = require('express');

// ============================================================================
// 1. MANIFEST
// ============================================================================
const MANIFEST = {
  id: 'com.jackett.prowlarr.torrentio',
  version: '2.0.0',
  name: 'UniTorrent',
  description: 'Multi-provider torrent addon: Jackett + Prowlarr + Torrentio',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {},
};

// ============================================================================
// 2. CONFIG ENCODING
// ============================================================================
// Compact format to keep base64 short:
// {
//   j: { u: "jackettUrl", k: "jackettApiKey" },
//   p: { u: "prowlarrUrl", k: "prowlarrApiKey" },
//   t: { u: "torrentioUrl", c: "torrentioConfigString" },
//   o: { u: "cometUrl" },
//   r: { u: "meteorUrl" },
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
  if (config.meteorUrl) c.r = { u: config.meteorUrl.replace(/\/$/, '') };
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
    const cfg = { maxResults: d.m || 5 };
    if (d.j) { cfg.jackettUrl = d.j.u; cfg.jackettApiKey = d.j.k; }
    if (d.p) { cfg.prowlarrUrl = d.p.u; cfg.prowlarrApiKey = d.p.k; }
    // Torrentio: old format { e, c } or new format { u, c }
    if (d.t) {
      if (d.t.u) { cfg.torrentioUrl = d.t.u; cfg.torrentioConfig = d.t.c || ''; }
      else if (d.t.e) { cfg.torrentioUrl = 'https://torrentio.strem.fun'; cfg.torrentioConfig = d.t.c || ''; }
    }
    if (d.o && d.o.u) { cfg.cometUrl = d.o.u; }
    // Meteor: old format { e } or new format { u }
    if (d.r) {
      if (d.r.u) { cfg.meteorUrl = d.r.u; }
      else if (d.r.e) { cfg.meteorUrl = 'https://meteorfortheweebs.midnightignite.me'; }
    }
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
      meteorUrl: process.env.METEOR_URL || 'https://meteorfortheweebs.midnightignite.me',
      jacredUrl: process.env.JACRED_URL || '',
      jacredApiKey: process.env.JACRED_API_KEY || '',
      mediafusionUrl: process.env.MEDIAFUSION_URL || '',
      torrServerUrl: process.env.TORRSERVER_URL || '',
      torrServerUser: process.env.TORRSERVER_USER || '',
      torrServerPassword: process.env.TORRSERVER_PASSWORD || '',
      maxResults: 5,
    };
  }
}

function generateUUID() { return crypto.randomUUID(); }

// ============================================================================
// 3. PROVIDER SEARCHERS
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
    stream.url = `${baseUrl}/stream?link=${encodeURIComponent(torrentLink)}&index=1&play`;
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

// ---- Torrentio (HTTP proxy) ----
async function searchTorrentio(cfg, type, id) {
  if (!cfg.torrentioUrl) return [];
  const baseUrl = cfg.torrentioUrl.replace(/\/+$/, '');
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
  const url = `${cfg.cometUrl.replace(/\/+$/, '')}/stream/${type}/${id}.json`;
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

// ---- Meteor (public or custom instance) ----
async function searchMeteor(cfg, type, id) {
  if (!cfg.meteorUrl) return [];
  const url = `${cfg.meteorUrl.replace(/\/+$/, '')}/stream/${type}/${id}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Meteor HTTP ${res.status}`);
  const data = await res.json();
  return (data.streams || []).filter(s => s.infoHash || s.url).map(s => ({
    Title: (s.title || s.name || '').replace(/\n/g, ' ').trim(),
    Seeders: parseInt((s.name || '').match(/👤\s*(\d+)/)?.[1] || '0', 10),
    Size: s.behaviorHints?.videoSize || 0,
    InfoHash: s.infoHash || '',
    MagnetUri: '',
    CategoryDesc: '',
    _provider: 'Meteor',
    _rawStream: s,
  }));
}

// ---- MediaFusion ----
async function searchMediaFusion(cfg, type, id) {
  if (!cfg.mediafusionUrl) return [];
  const url = `${cfg.mediafusionUrl.replace(/\/+$/, '')}/D-/stream/${type}/${id}.json`;
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
// 4. STREAM HANDLER (multi-provider)
// ============================================================================
async function handleStream(config, type, id) {
  try {
    const imdbId = extractIMDbId(id);
    if (!imdbId) return { streams: [] };
    console.log(`[Stream] ${type} ${imdbId}`);

    // Query all providers in parallel
    const promises = [];
    if (config.jackettUrl) promises.push(searchJackett(config, imdbId));
    if (config.prowlarrUrl) promises.push(searchProwlarr(config, imdbId, type));
    if (config.torrentioUrl) promises.push(searchTorrentio(config, type, id));
    if (config.cometUrl) promises.push(searchComet(config, type, id));
    if (config.meteorUrl) promises.push(searchMeteor(config, type, id));
    if (config.jacredUrl) promises.push(searchJacred(config, imdbId));
    if (config.mediafusionUrl) promises.push(searchMediaFusion(config, type, id));

    if (promises.length === 0) return { streams: [] };

    const results = (await Promise.allSettled(promises))
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);

    if (results.length === 0) return { streams: [] };

    // Dedup by infoHash
    const seen = new Set();
    const unique = results.filter(r => {
      if (!r.InfoHash) return true;
      if (seen.has(r.InfoHash)) return false;
      seen.add(r.InfoHash);
      return true;
    });

    // Sort by seeders
    unique.sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));

    const maxResults = config.maxResults || 5;
    const streams = unique.slice(0, maxResults).map(r => {
      // If TorrServer configured, route EVERYTHING through TorrServer
      if (config.torrServerUrl) {
        return buildStreamEntry(r, config);
      }
      // Proxy-style providers (Torrentio, Comet, Meteor, MediaFusion) — pass through raw stream format
      if ((r._provider === 'Torrentio' || r._provider === 'Comet' || r._provider === 'Meteor' || r._provider === 'MediaFusion') && r._rawStream) {
        const s = { ...r._rawStream };
        s.name = `[${r._provider}] ${s.name || ''}`;
        return s;
      }
      return buildStreamEntry(r, config);
    });

    console.log(`[Stream] → ${streams.length} streams (from ${results.length} total, ${unique.length} unique)`);
    return { streams, cacheMaxAge: 600 };
  } catch (err) {
    console.error('[Stream] Error:', err.message);
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
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* ===== CSS Variables / Theme ===== */
  :root {
    --bg: #0a0a0f;
    --bg-card: #12121a;
    --bg-card-hover: #1a1a28;
    --bg-sidebar: #0d0d15;
    --border: #1e1e30;
    --border-light: #2a2a40;
    --text: #e0e0e8;
    --text-muted: #8888a0;
    --text-dim: #555570;
    --primary: #7c3aed;
    --primary-glow: rgba(124, 58, 237, 0.15);
    --primary-hover: #8b5cf6;
    --accent: #f59e0b;
    --accent-glow: rgba(245, 158, 11, 0.15);
    --success: #10b981;
    --error: #ef4444;
    --radius: 12px;
    --radius-sm: 8px;
    --sidebar-w: 240px;
    --font-heading: 'Outfit', sans-serif;
    --font-body: 'Plus Jakarta Sans', sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font-body);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    position: relative;
    overflow-x: hidden;
  }

  /* Film grain overlay */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    opacity: 0.03;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 9999;
  }

  /* Gradient orbs in background */
  .orb {
    position: fixed;
    border-radius: 50%;
    filter: blur(120px);
    pointer-events: none;
    z-index: 0;
  }
  .orb-1 { width: 600px; height: 600px; background: rgba(124, 58, 237, 0.08); top: -200px; right: -200px; }
  .orb-2 { width: 500px; height: 500px; background: rgba(245, 158, 11, 0.06); bottom: -150px; left: -150px; }

  /* ===== Sidebar ===== */
  .sidebar {
    position: fixed;
    top: 0; left: 0;
    width: var(--sidebar-w);
    height: 100vh;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border);
    z-index: 100;
    display: flex;
    flex-direction: column;
    padding: 20px 16px;
  }
  .sidebar-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px 24px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-brand .logo {
    width: 36px; height: 36px;
    background: linear-gradient(135deg, var(--primary), var(--accent));
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 700;
    color: #fff;
  }
  .sidebar-brand h1 {
    font-family: var(--font-heading);
    font-size: 18px;
    font-weight: 700;
    background: linear-gradient(135deg, #c4b5fd, #fde68a);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .sidebar-brand small { font-size: 10px; color: var(--text-dim); display: block; -webkit-text-fill-color: var(--text-dim); }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    margin-bottom: 2px;
    border: none;
    background: none;
    width: 100%;
    text-align: left;
  }
  .nav-item:hover { background: var(--bg-card); color: var(--text); }
  .nav-item.active { background: var(--primary-glow); color: var(--primary); font-weight: 600; }
  .nav-item .icon { font-size: 18px; width: 24px; text-align: center; }
  .nav-divider { height: 1px; background: var(--border); margin: 12px 0; }
  .sidebar-footer {
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-dim);
    text-align: center;
  }

  /* ===== Main ===== */
  .main {
    margin-left: var(--sidebar-w);
    flex: 1;
    padding: 32px 40px;
    position: relative;
    z-index: 1;
    min-height: 100vh;
  }
  .page-header { margin-bottom: 32px; }
  .page-header h2 {
    font-family: var(--font-heading);
    font-size: 28px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .page-header p { color: var(--text-muted); font-size: 14px; }

  /* ===== Cards ===== */
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    margin-bottom: 20px;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: var(--border-light); }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }
  .card-header h3 {
    font-family: var(--font-heading);
    font-size: 16px;
    font-weight: 600;
  }
  .card-header .badge {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 20px;
    background: var(--primary-glow);
    color: var(--primary);
    font-weight: 500;
  }
  .card-header .badge.success { background: rgba(16, 185, 129, 0.12); color: var(--success); }
  .card-header .badge.error { background: rgba(239, 68, 68, 0.12); color: var(--error); }

  /* ===== Form ===== */
  .form-group { margin-bottom: 16px; }
  .form-group label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
  }
  .form-group label .required { color: var(--error); margin-left: 2px; }
  .form-row {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .form-row .form-group { flex: 1; margin-bottom: 0; }
  input, select {
    width: 100%;
    padding: 10px 14px;
    background: #0a0a12;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 14px;
    font-family: var(--font-body);
    transition: border-color 0.2s;
  }
  input:focus, select:focus { border-color: var(--primary); outline: none; box-shadow: 0 0 0 3px var(--primary-glow); }
  input::placeholder { color: var(--text-dim); }
  .hint { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
  .hint.success { color: var(--success); }
  .hint.error { color: var(--error); }

  /* ===== Toggle ===== */
  .toggle-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
  }
  .toggle {
    width: 44px; height: 24px;
    background: #2a2a3a;
    border-radius: 12px;
    cursor: pointer;
    position: relative;
    transition: background 0.2s;
    border: none;
    flex-shrink: 0;
  }
  .toggle.active { background: var(--primary); }
  .toggle::after {
    content: '';
    position: absolute;
    width: 18px; height: 18px;
    background: #fff;
    border-radius: 50%;
    top: 3px; left: 3px;
    transition: transform 0.2s;
  }
  .toggle.active::after { transform: translateX(20px); }
  .toggle-label { font-size: 14px; color: var(--text); }

  /* ===== Button ===== */
  .btn {
    padding: 10px 20px;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); box-shadow: 0 4px 15px var(--primary-glow); }
  .btn-secondary { background: var(--bg-card-hover); color: var(--text); border: 1px solid var(--border); }
  .btn-secondary:hover { border-color: var(--border-light); }
  .btn-success { background: var(--success); color: #fff; }
  .btn-success:hover { opacity: 0.9; transform: translateY(-1px); }
  .btn-danger { background: var(--error); color: #fff; }
  .btn-sm { padding: 6px 12px; font-size: 12px; }
  button:disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; }

  /* ===== Result URL ===== */
  .result-box {
    background: linear-gradient(135deg, rgba(16, 185, 129, 0.05), rgba(124, 58, 237, 0.05));
    border: 1px solid rgba(16, 185, 129, 0.2);
    border-radius: var(--radius);
    padding: 24px;
    margin-top: 20px;
  }
  .result-box h4 { color: var(--success); font-size: 15px; margin-bottom: 8px; }
  .result-box p { color: var(--text-muted); font-size: 13px; margin-bottom: 12px; }
  .result-url {
    background: #0a0a12;
    border: 1px solid var(--border-light);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    font-size: 12px;
    color: var(--primary);
    word-break: break-all;
    user-select: all;
    margin-bottom: 12px;
  }
  .result-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .status-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 6px;
  }
  .status-dot.green { background: var(--success); }
  .status-dot.red { background: var(--error); }
  .status-dot.gray { background: var(--text-dim); }

  /* ===== Provider Cards inside Indexers ===== */
  .provider-card {
    background: #0a0a12;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 16px;
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .provider-card .provider-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .provider-card .provider-name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 14px;
  }
  .provider-card .provider-name .icon { font-size: 20px; }

  /* ===== Test result ===== */
  .test-result {
    font-size: 13px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    margin-top: 8px;
    display: none;
  }
  .test-result.show { display: block; }
  .test-result.success { background: rgba(16, 185, 129, 0.08); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.15); }
  .test-result.error { background: rgba(239, 68, 68, 0.08); color: var(--error); border: 1px solid rgba(239, 68, 68, 0.15); }

  /* ===== Tab content ===== */
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* ===== Responsive ===== */
  @media (max-width: 768px) {
    .sidebar { transform: translateX(-100%); }
    .sidebar.open { transform: translateX(0); }
    .main { margin-left: 0; padding: 20px; }
    .form-row { flex-direction: column; }
    .form-row .form-group { margin-bottom: 12px; }
    .mobile-menu-btn {
      display: flex !important;
      position: fixed;
      top: 16px; left: 16px;
      z-index: 200;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 8px;
      cursor: pointer;
      color: var(--text);
    }
  }
  .mobile-menu-btn { display: none; }

  .toast {
    position: fixed;
    bottom: 24px; right: 24px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 20px;
    font-size: 14px;
    z-index: 99999;
    opacity: 0;
    transform: translateY(10px);
    transition: all 0.3s;
    pointer-events: none;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.success { border-color: rgba(16, 185, 129, 0.3); }
  .toast.error { border-color: rgba(239, 68, 68, 0.3); }
</style>
</head>
<body>

<div class="orb orb-1"></div>
<div class="orb orb-2"></div>

<button class="mobile-menu-btn" id="mobileMenuBtn">☰</button>

<!-- Sidebar -->
<nav class="sidebar" id="sidebar">
  <div class="sidebar-brand">
    <div class="logo">U</div>
    <div>
      <h1>UniTorrent</h1>
      <small>Multi-Provider Addon</small>
    </div>
  </div>
  <button class="nav-item active" data-tab="indexers"><span class="icon">🔍</span> Indexers</button>
  <button class="nav-item" data-tab="preferences"><span class="icon">⚙️</span> Preferences</button>
  <div class="nav-divider"></div>
  <button class="nav-item" data-tab="install"><span class="icon">📦</span> Install</button>
  <div class="sidebar-footer">UniTorrent v2.0.0</div>
</nav>

<!-- Main -->
<div class="main">
  <!-- Tab: Indexers -->
  <div class="tab-content active" id="tab-indexers">
    <div class="page-header">
      <h2>🔍 Indexers</h2>
      <p>Configure torrent sources — enable at least 1 provider</p>
    </div>

    <!-- Jackett -->
    <div class="card">
      <div class="card-header">
        <h3>🃏 Jackett</h3>
        <span class="badge" id="jackettBadge">Not configured</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name"><span class="icon">🃏</span> Jackett Server</span>
          <label class="toggle" id="jackettToggle">
            <input type="checkbox" hidden id="jackettEnabled">
          </label>
        </div>
        <div class="form-group">
          <label>Server URL <span class="required">*</span></label>
          <input type="url" id="jackettUrl" placeholder="http://192.168.1.100:9117">
        </div>
        <div class="form-group">
          <label>API Key <span class="required">*</span></label>
          <input type="text" id="jackettApiKey" placeholder="API key from Jackett Dashboard">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" onclick="testJackett()">🔄 Test</button>
        </div>
        <div class="test-result" id="jackettTestResult"></div>
      </div>
    </div>

    <!-- Prowlarr -->
    <div class="card">
      <div class="card-header">
        <h3>🐟 Prowlarr</h3>
        <span class="badge" id="prowlarrBadge">Not configured</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name"><span class="icon">🐟</span> Prowlarr Server</span>
          <label class="toggle" id="prowlarrToggle">
            <input type="checkbox" hidden id="prowlarrEnabled">
          </label>
        </div>
        <div class="form-group">
          <label>Server URL <span class="required">*</span></label>
          <input type="url" id="prowlarrUrl" placeholder="http://192.168.1.100:9696">
        </div>
        <div class="form-group">
          <label>API Key <span class="required">*</span></label>
          <input type="text" id="prowlarrApiKey" placeholder="Settings → General → API Key">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" onclick="testProwlarr()">🔄 Test</button>
        </div>
        <div class="test-result" id="prowlarrTestResult"></div>
      </div>
    </div>

    <!-- Torrentio -->
    <div class="card">
      <div class="card-header">
        <h3>⚡ Torrentio</h3>
        <span class="badge" id="torrentioBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name"><span class="icon">⚡</span> Torrentio (Proxy)</span>
          <label class="toggle" id="torrentioToggle">
            <input type="checkbox" hidden id="torrentioEnabled">
          </label>
        </div>
        <div class="form-group">
          <label>Torrentio URL <span class="required">*</span></label>
          <input type="url" id="torrentioUrl" value="https://torrentio.strem.fun">
          <div class="hint"><code>https://torrentio.strem.fun</code> — Torrentio manifest link. Use self-hosted or ElfHosted instance.</div>
        </div>
        <div class="form-group">
          <label>Torrentio Config String (optional)</label>
          <input type="text" id="torrentioConfig" placeholder="realdebrid=KEY|providers=yts,eztv|limit=5">
          <div class="hint">Leave empty for default. Format: <code>realdebrid=KEY|providers=...|limit=5</code></div>
        </div>
      </div>
    </div>

    <!-- Comet -->
    <div class="card">
      <div class="card-header">
        <h3>☄️ Comet</h3>
        <span class="badge" id="cometBadge">Not configured</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name"><span class="icon">☄️</span> Comet Instance</span>
          <label class="toggle" id="cometToggle">
            <input type="checkbox" hidden id="cometEnabled">
          </label>
        </div>
        <div class="form-group">
          <label>Comet URL <span class="required">*</span></label>
          <input type="url" id="cometUrl" placeholder="https://comet.feels.legal">
          <div class="hint">Public instances: <code>https://comet.feels.legal</code>, <code>https://comet.elfhosted.com</code>. Or self-host.</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" onclick="testComet()">🔄 Test</button>
        </div>
        <div class="test-result" id="cometTestResult"></div>
      </div>
    </div>

    <!-- Meteor -->
    <div class="card">
      <div class="card-header">
        <h3>🌠 Meteor</h3>
        <span class="badge" id="meteorBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name"><span class="icon">🌠</span> Meteor Instance</span>
          <label class="toggle" id="meteorToggle">
            <input type="checkbox" hidden id="meteorEnabled">
          </label>
        </div>
        <div class="form-group">
          <label>Meteor URL <span class="required">*</span></label>
          <input type="url" id="meteorUrl" value="https://meteorfortheweebs.midnightignite.me">
          <div class="hint"><code>https://meteorfortheweebs.midnightignite.me</code> — Meteor manifest link</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" onclick="testMeteor()">🔄 Test</button>
        </div>
        <div class="test-result" id="meteorTestResult"></div>
      </div>
    </div>

    <!-- Jacred -->
    <div class="card">
      <div class="card-header">
        <h3>💎 Jacred</h3>
        <span class="badge" id="jacredBadge">Not configured</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name"><span class="icon">💎</span> Jacred (Jackett-compatible)</span>
          <label class="toggle" id="jacredToggle">
            <input type="checkbox" hidden id="jacredEnabled">
          </label>
        </div>
        <div class="form-group">
          <label>Server URL <span class="required">*</span></label>
          <input type="url" id="jacredUrl" placeholder="http://192.168.1.100:9120">
        </div>
        <div class="form-group">
          <label>API Key <span class="required">*</span></label>
          <input type="text" id="jacredApiKey" placeholder="API Key from config">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" onclick="testJacred()">🔄 Test</button>
        </div>
        <div class="test-result" id="jacredTestResult"></div>
      </div>
    </div>

    <!-- MediaFusion -->
    <div class="card">
      <div class="card-header">
        <h3>🎬 MediaFusion</h3>
        <span class="badge" id="mediafusionBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name"><span class="icon">🎬</span> MediaFusion Instance</span>
          <label class="toggle" id="mediafusionToggle">
            <input type="checkbox" hidden id="mediafusionEnabled">
          </label>
        </div>
        <div class="form-group">
          <label>MediaFusion URL <span class="required">*</span></label>
          <input type="url" id="mediafusionUrl" value="https://mediafusion.elfhosted.com">
          <div class="hint"><code>https://mediafusion.elfhosted.com</code> — MediaFusion manifest link. Or <a href="https://github.com/mhdzumair/MediaFusion" target="_blank">self-host</a>.</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" onclick="testMediaFusion()">🔄 Test</button>
        </div>
        <div class="test-result" id="mediafusionTestResult"></div>
      </div>
    </div>
  </div>

  <!-- Tab: Preferences -->
  <div class="tab-content" id="tab-preferences">
    <div class="page-header">
      <h2>⚙️ Preferences</h2>
      <p>Customize search results</p>
    </div>
    <div class="card">
      <div class="card-header"><h3>🎯 Search</h3></div>
      <div class="form-row">
        <div class="form-group">
          <label>Max Results</label>
          <input type="number" id="maxResults" value="5" min="1" max="20">
        </div>
      </div>
      <div class="form-group" style="margin-top:16px">
        <label>TorrServer URL (optional)</label>
        <input type="url" id="torrServerUrl" placeholder="http://192.168.1.100:8090">
        <div class="hint">Your TorrServer address. Select version below (Official vs Fork 9000000)</div>
      </div>
      <div class="form-group" style="margin-top:16px">
        <label>TorrServer Version</label>
        <select id="torrServerType">
          <option value="official">Official — /stream?link=...</option>
          <option value="fork">9000000 Fork — /stream?link=... (series handling differs)</option>
        </select>
        <div class="hint">Fork 9000000 processes TV series differently from official. Choose <strong>Fork</strong> if you run <code>github.com/9000000/TorrServer</code></div>
      </div>
      <div class="form-group" style="margin-top:16px">
        <label>TorrServer Username (if auth enabled)</label>
        <input type="text" id="torrServerUser" placeholder="admin">
      </div>
      <div class="form-group" style="margin-top:16px">
        <label>TorrServer Password (if auth enabled)</label>
        <input type="password" id="torrServerPassword" placeholder="Enter password">
        <div class="hint">HTTP Basic Auth. Enable on TorrServer with <code>--httpauth</code> flag. <br>Credentials stored in <code>accs.db</code>: <code>{"user":"pass"}</code></div>
      </div>
    </div>
  </div>

  <!-- Tab: Install -->
  <div class="tab-content" id="tab-install">
    <div class="page-header">
      <h2>📦 Install</h2>
      <p>Generate your personal URL and add it to Stremio</p>
    </div>
    <div class="card">
      <div class="card-header"><h3>🔗 Generate Install URL</h3></div>
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:16px">
        Click the button below to create a URL containing your full configuration.
      </p>
      <button class="btn btn-primary" onclick="generateUrl()">🔗 Generate Personal URL</button>
      <div id="resultContainer"></div>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
// === Sidebar Navigation ===
document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    document.getElementById('sidebar').classList.remove('open');
  });
});
document.getElementById('mobileMenuBtn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// === Toggle switches ===
function setupToggle(id) {
  const el = document.getElementById(id);
  el.addEventListener('click', (e) => {
    e.preventDefault();
    el.classList.toggle('active');
  });
}
setupToggle('jackettToggle');
setupToggle('prowlarrToggle');
setupToggle('torrentioToggle');
setupToggle('cometToggle');
setupToggle('meteorToggle');
setupToggle('jacredToggle');
setupToggle('mediafusionToggle');

// === Toast ===
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 3000);
}

// === Copy helper ===
function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('✅ URL copied!'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('✅ URL copied!');
  }
}

// === Collect form data ===
function collectConfig() {
  return {
    jackettUrl: document.getElementById('jackettUrl').value,
    jackettApiKey: document.getElementById('jackettApiKey').value,
    jackettEnabled: document.getElementById('jackettToggle').classList.contains('active'),
    prowlarrUrl: document.getElementById('prowlarrUrl').value,
    prowlarrApiKey: document.getElementById('prowlarrApiKey').value,
    prowlarrEnabled: document.getElementById('prowlarrToggle').classList.contains('active'),
    torrentioUrl: document.getElementById('torrentioUrl').value,
    torrentioEnabled: document.getElementById('torrentioToggle').classList.contains('active'),
    torrentioConfig: document.getElementById('torrentioConfig').value,
    cometUrl: document.getElementById('cometUrl').value,
    cometEnabled: document.getElementById('cometToggle').classList.contains('active'),
    meteorUrl: document.getElementById('meteorUrl').value,
    meteorEnabled: document.getElementById('meteorToggle').classList.contains('active'),
    jacredUrl: document.getElementById('jacredUrl').value,
    jacredApiKey: document.getElementById('jacredApiKey').value,
    jacredEnabled: document.getElementById('jacredToggle').classList.contains('active'),
    mediafusionUrl: document.getElementById('mediafusionUrl').value,
    mediafusionEnabled: document.getElementById('mediafusionToggle').classList.contains('active'),
    torrServerUrl: document.getElementById('torrServerUrl').value,
    torrServerUser: document.getElementById('torrServerUser').value,
    torrServerPassword: document.getElementById('torrServerPassword').value,
    torrServerType: document.getElementById('torrServerType').value,
    maxResults: document.getElementById('maxResults').value,
  };
}

// === Generate URL ===
async function generateUrl() {
  const cfg = collectConfig();
  const hasJackett = cfg.jackettEnabled && cfg.jackettUrl && cfg.jackettApiKey;
  const hasProwlarr = cfg.prowlarrEnabled && cfg.prowlarrUrl && cfg.prowlarrApiKey;
  const hasTorrentio = cfg.torrentioEnabled && cfg.torrentioUrl;
  const hasComet = cfg.cometEnabled && cfg.cometUrl;
  const hasMeteor = cfg.meteorEnabled && cfg.meteorUrl;
  const hasJacred = cfg.jacredEnabled && cfg.jacredUrl && cfg.jacredApiKey;
  const hasMediaFusion = cfg.mediafusionEnabled && cfg.mediafusionUrl;
  if (!hasJackett && !hasProwlarr && !hasTorrentio && !hasComet && !hasMeteor && !hasJacred && !hasMediaFusion) {
    showToast('⚠️ Enable at least 1 provider (Jackett/Prowlarr/Torrentio/Comet/Meteor/Jacred/MediaFusion)', 'error');
    return;
  }

  try {
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await resp.json();
    const container = document.getElementById('resultContainer');
    container.innerHTML = \`
      <div class="result-box">
        <h4>✅ URL is Ready!</h4>
        <p>Copy this URL into Stremio → Addons → Install from URL</p>
        <div class="result-url">\${data.manifestUrl}</div>
        <div class="result-actions">
          <button class="btn btn-success btn-sm" onclick="copyText('\${data.manifestUrl}')">📋 Copy URL</button>
          <a class="btn btn-primary btn-sm" href="\${data.stremioLink}" target="_blank">🚀 Open in Stremio</a>
          <button class="btn btn-secondary btn-sm" onclick="window.location.href='/configure'">🔄 Regenerate</button>
        </div>
      </div>
    \`;
    container.scrollIntoView({ behavior: 'smooth' });
    showToast('✅ URL generated!');
  } catch (e) {
    showToast('⚠️ Error: ' + e.message, 'error');
  }
}

// === Test Jackett ===
async function testJackett() {
  const url = document.getElementById('jackettUrl').value;
  const key = document.getElementById('jackettApiKey').value;
  const el = document.getElementById('jackettTestResult');
  if (!url || !key) { el.className = 'test-result show error'; el.textContent = '⚠️ Enter URL and API Key first'; return; }
  try {
    el.className = 'test-result show'; el.textContent = '🔄 Testing...';
    const r = await fetch('/api/test/jackett?url=' + encodeURIComponent(url) + '&key=' + encodeURIComponent(key));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? '✅ ' + d.message : '❌ ' + d.message;
    document.getElementById('jackettBadge').textContent = d.ok ? '✅ OK' : '❌ Error';
    document.getElementById('jackettBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) {
    el.className = 'test-result show error'; el.textContent = '❌ ' + e.message;
  }
}

// === Test Comet ===
async function testComet() {
  const url = document.getElementById('cometUrl').value;
  const el = document.getElementById('cometTestResult');
  if (!url) { el.className = 'test-result show error'; el.textContent = '⚠️ Enter Comet URL first'; return; }
  try {
    el.className = 'test-result show'; el.textContent = '🔄 Testing...';
    const r = await fetch('/api/test/comet?url=' + encodeURIComponent(url));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? '✅ ' + d.message : '❌ ' + d.message;
    document.getElementById('cometBadge').textContent = d.ok ? '✅ OK' : '❌ Error';
    document.getElementById('cometBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) {
    el.className = 'test-result show error'; el.textContent = '❌ ' + e.message;
  }
}

// === Test Meteor ===
async function testMeteor() {
  const url = document.getElementById('meteorUrl').value;
  const el = document.getElementById('meteorTestResult');
  if (!url) { el.className = 'test-result show error'; el.textContent = '⚠️ Enter Meteor URL first'; return; }
  try {
    el.className = 'test-result show'; el.textContent = '🔄 Testing...';
    const r = await fetch('/api/test/meteor?url=' + encodeURIComponent(url));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? '✅ ' + d.message : '❌ ' + d.message;
    document.getElementById('meteorBadge').textContent = d.ok ? '✅ OK' : '❌ Error';
    document.getElementById('meteorBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) {
    el.className = 'test-result show error'; el.textContent = '❌ ' + e.message;
  }
}

// === Test Jacred ===
async function testJacred() {
  const url = document.getElementById('jacredUrl').value;
  const key = document.getElementById('jacredApiKey').value;
  const el = document.getElementById('jacredTestResult');
  if (!url || !key) { el.className = 'test-result show error'; el.textContent = '⚠️ Enter URL and API Key first'; return; }
  try {
    el.className = 'test-result show'; el.textContent = '🔄 Testing...';
    const r = await fetch('/api/test/jacred?url=' + encodeURIComponent(url) + '&key=' + encodeURIComponent(key));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? '✅ ' + d.message : '❌ ' + d.message;
    document.getElementById('jacredBadge').textContent = d.ok ? '✅ OK' : '❌ Error';
    document.getElementById('jacredBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) {
    el.className = 'test-result show error'; el.textContent = '❌ ' + e.message;
  }
}

// === Test Prowlarr ===
async function testProwlarr() {
  const url = document.getElementById('prowlarrUrl').value;
  const key = document.getElementById('prowlarrApiKey').value;
  const el = document.getElementById('prowlarrTestResult');
  if (!url || !key) { el.className = 'test-result show error'; el.textContent = '⚠️ Enter URL and API Key first'; return; }
  try {
    el.className = 'test-result show'; el.textContent = '🔄 Testing...';
    const r = await fetch('/api/test/prowlarr?url=' + encodeURIComponent(url) + '&key=' + encodeURIComponent(key));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? '✅ ' + d.message : '❌ ' + d.message;
    document.getElementById('prowlarrBadge').textContent = d.ok ? '✅ OK' : '❌ Error';
    document.getElementById('prowlarrBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) {
    el.className = 'test-result show error'; el.textContent = '❌ ' + e.message;
  }
}

// === Test MediaFusion ===
async function testMediaFusion() {
  const url = document.getElementById('mediafusionUrl').value;
  const el = document.getElementById('mediafusionTestResult');
  if (!url) { el.className = 'test-result show error'; el.textContent = '⚠️ Enter MediaFusion URL first'; return; }
  try {
    el.className = 'test-result show'; el.textContent = '🔄 Testing...';
    const r = await fetch('/api/test/mediafusion?url=' + encodeURIComponent(url));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? '✅ ' + d.message : '❌ ' + d.message;
    document.getElementById('mediafusionBadge').textContent = d.ok ? '✅ OK' : '❌ Error';
    document.getElementById('mediafusionBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) {
    el.className = 'test-result show error'; el.textContent = '❌ ' + e.message;
  }
}
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

// ---- Config page ----
app.get('/configure', (req, res) => {
  res.type('html').send(WEB_HTML);
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
    torrentioConfig: body.torrentioConfig || '',
    torrentioEnabled: !!body.torrentioEnabled,
    cometUrl: body.cometEnabled ? (body.cometUrl || '') : '',
    meteorUrl: body.meteorEnabled ? (body.meteorUrl || '') : '',
    meteorEnabled: !!body.meteorEnabled,
    jacredUrl: body.jacredEnabled ? (body.jacredUrl || '') : '',
    jacredApiKey: body.jacredEnabled ? (body.jacredApiKey || '') : '',
    mediafusionUrl: body.mediafusionEnabled ? (body.mediafusionUrl || '') : '',
    torrServerUrl: body.torrServerUrl || '',
    torrServerUser: body.torrServerUser || '',
    torrServerPassword: body.torrServerPassword || '',
    torrServerType: body.torrServerType || 'official',
    maxResults: body.maxResults || 5,
  };
  const uuid = generateUUID();
  const b64 = encodeConfig(cfg);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const manifestUrl = `${baseUrl}/stremio/${uuid}/${b64}/manifest.json`;
  const stremioLink = `stremio://${manifestUrl.replace(/^https?:\/\//, '')}`;
  res.json({ manifestUrl, stremioLink, uuid });
});

// ---- API: Test Jackett ----
app.get('/api/test/jackett', async (req, res) => {
  try {
    const { url, key } = req.query;
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v2.0/indexers?configured=true`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const configured = Array.isArray(data) ? data.filter(i => i.configured).length : 0;
    res.json({ ok: true, message: `✅ Jackett OK — ${configured} indexers configured` });
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
    const r = await fetch(`${url.replace(/\/+$/, '')}/stream/movie/tt0133093.json`, {
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

// ---- API: Test Meteor ----
app.get('/api/test/meteor', async (req, res) => {
  try {
    const baseUrl = (req.query.url || 'https://meteorfortheweebs.midnightignite.me').replace(/\/+$/, '');
    const r = await fetch(`${baseUrl}/stream/movie/tt0133093.json`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const count = (data.streams || []).length;
    res.json({ ok: true, message: `✅ Meteor OK — ${count} streams for The Matrix` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---- API: Test Jacred ----
app.get('/api/test/jacred', async (req, res) => {
  try {
    const { url, key } = req.query;
    const r = await fetch(`${url.replace(/\/$/, '')}/api/v2.0/indexers?configured=true`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const configured = Array.isArray(data) ? data.filter(i => i.configured).length : 0;
    res.json({ ok: true, message: `✅ Jacred OK — ${configured} indexers configured` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---- API: Test MediaFusion ----
app.get('/api/test/mediafusion', async (req, res) => {
  try {
    const baseUrl = (req.query.url || '').replace(/\/+$/, '');
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

// ---- Stremio routes ----
app.get('/stremio/:uuid/:config/manifest.json', (req, res) => {
  res.json(MANIFEST);
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
  console.log(`  Manifest: http://0.0.0.0:${PORT}/stremio/:uuid/:config/manifest.json`);
  console.log(`  Providers: Jackett / Prowlarr / Torrentio / Comet / Meteor / Jacred / MediaFusion`);
  console.log('='.repeat(50));
});
