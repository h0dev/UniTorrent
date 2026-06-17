#!/usr/bin/env node
// ============================================================================
// UniTorrent — Multi-Provider Stremio Addon
// ============================================================================
// Providers: Jackett, Prowlarr, Torrentio, Comet, Jacred, MediaFusion
// Config embedded in URL (base64) — TorrServer HTTP streaming support
// ============================================================================

const crypto = require('crypto');
const express = require('express');
const { XMLParser } = require('fast-xml-parser');

// ============================================================================
// 1. DEBUG & CONFIG
// ============================================================================
const DEBUG = process.env.DEBUG === 'true';
const log = (...args) => { if (DEBUG) console.log('[UniTorrent]', ...args); };
const err = (...args) => console.error('[UniTorrent:ERR]', ...args);

// ---- Torrent file cache for TorrServer (.torrent download) ----
const torrentCache = new Map();
const TORRENT_CACHE_TTL = 30 * 60 * 1000; // 30 min

// ---- Stream result cache (per-config isolation) ----
const streamCache = new Map();
const STREAM_CACHE_TTL = 5 * 60 * 1000; // 5 min

// Cache key includes ALL config values → unique per user, no cross-config sharing
function streamCacheKey(type, id, cfg) {
  const parts = [
    cfg.jackettUrl, cfg.jackettApiKey,
    cfg.prowlarrUrl, cfg.prowlarrApiKey,
    cfg.torrentioUrl, cfg.torrentioConfig,
    cfg.cometUrl,
    cfg.jacredUrl, cfg.jacredApiKey,
    cfg.peerflixUrl,
    cfg.mediafusionUrl,
    cfg.magnetzUrl,
    cfg.torrServerUrl, cfg.torrServerUser, cfg.torrServerPassword, cfg.torrServerType,
    cfg.maxResults, cfg.providerOrder?.join(','),
    cfg.saveToDb,
  ];
  const sig = parts.filter(Boolean).join('|');
  let hash = 0;
  for (let i = 0; i < sig.length; i++) { hash = ((hash << 5) - hash) + sig.charCodeAt(i); hash |= 0; }
  return `${hash.toString(36)}:${type}:${id}`;
}
function streamCacheGet(key) {
  const entry = streamCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > STREAM_CACHE_TTL) { streamCache.delete(key); return null; }
  return entry.data;
}
function streamCacheSet(key, data) { streamCache.set(key, { ts: Date.now(), data }); }

// ============================================================================
// 2. MANIFEST
// ============================================================================
const MANIFEST = {
  id: 'com.unitorrent.addon',
  version: '2.0.0',
  name: 'UniTorrent',
  description: 'Multi-provider: Jackett + Prowlarr + Torrentio + Comet + Peerflix + Jacred + MediaFusion → TorrServer',
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
//   e: { u: "peerflixUrl" },
//   a: { u: "jacredUrl", k: "jacredApiKey" }, // k optional
//   f: { u: "mediafusionUrl" },
//   z: { u: "magnetzUrl" },   // Magnetz search API
//   s: { u: "torrServerUrl", a: "user:pass", t: "official|fork" },
//   m: 5  // maxResults
// }
function encodeConfig(config) {
  const c = {};
  if (config.jackettUrl) c.j = { u: config.jackettUrl.replace(/\/$/, ''), k: config.jackettApiKey || '' };
  if (config.prowlarrUrl) c.p = { u: config.prowlarrUrl.replace(/\/$/, ''), k: config.prowlarrApiKey || '' };
  if (config.torrentioEnabled && config.torrentioUrl) c.t = { u: config.torrentioUrl.replace(/\/$/, ''), c: config.torrentioConfig || '' };
  if (config.cometUrl) c.o = { u: config.cometUrl.replace(/\/$/, '') };
  if (config.peerflixUrl) c.e = { u: config.peerflixUrl.replace(/\/$/, '') };
  if (config.jacredUrl) c.a = { u: config.jacredUrl.replace(/\/$/, ''), k: config.jacredApiKey || '' };
  if (config.mediafusionUrl) c.f = { u: config.mediafusionUrl.replace(/\/$/, '') };
  if (config.magnetzUrl) c.z = { u: config.magnetzUrl.replace(/\/$/, '') };
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
    if (d.e && d.e.u) { cfg.peerflixUrl = d.e.u; }
    if (d.a && d.a.u) { cfg.jacredUrl = d.a.u; cfg.jacredApiKey = d.a.k || ''; }
    if (d.f && d.f.u) { cfg.mediafusionUrl = d.f.u; }
    if (d.z && d.z.u) { cfg.magnetzUrl = d.z.u; }
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
      magnetzUrl: process.env.MAGNETZ_URL || '',
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

// Extract quality label from release title (Torrentio-style)
function guessQuality(title) {
  if (!title) return 'Unknown';
  const parts = [];
  const resMatch = title.match(/\b(4K|2160p|1080p|1080i|720p|576p|540p|480p|360p)\b/i);
  if (resMatch) parts.push(resMatch[1].toUpperCase());
  if (/WEB-DL|WEBRip/i.test(title)) parts.push('WEB-DL');
  else if (/BluRay|BRRip|BDRip/i.test(title)) parts.push('BluRay');
  else if (/HDTV/i.test(title)) parts.push('HDTV');
  else if (/DVDRip|DVD/i.test(title)) parts.push('DVD');
  else if (/CAM|TS|TC|TeleSync/i.test(title)) parts.push('CAM');
  if (/HEVC|x265|h265/i.test(title)) parts.push('HEVC');
  else if (/x264|h264|AVC/i.test(title)) parts.push('h264');
  return parts.length ? parts.join('|') : 'Unknown';
}

function buildStreamEntry(r, cfg) {
  const sizeLabel = r.Size ? ` [${(r.Size / 1e9).toFixed(1)}GB]` : '';
  const label = `⬆${r.Seeders || 0} ${r.Title}${sizeLabel}`;
  const name = `${r._provider ? '[' + r._provider.toUpperCase() + '] ' : ''}${label}`;
  if (cfg.torrServerUrl) {
    // TorrServer mode: minimal stream entry — just name + url
    let baseUrl = cfg.torrServerUrl.replace(/\/$/, '');
    if (cfg.torrServerUser || cfg.torrServerPassword) {
      const u = encodeURIComponent(cfg.torrServerUser || '');
      const p = encodeURIComponent(cfg.torrServerPassword || '');
      baseUrl = baseUrl.replace(/^(https?:\/\/)/i, `$1${u}:${p}@`);
    }
    let torrentLink;
    if (r.InfoHash) {
      const cached = torrentCache.get(r.InfoHash);
      if (cached && cfg._addonBase) {
        torrentLink = `${cfg._addonBase}/api/torrent/${r.InfoHash}.torrent`;
      } else {
        torrentLink = `magnet:?xt=urn:btih:${r.InfoHash}`;
        if (r._trackers?.length) torrentLink += '&' + r._trackers.map(t => `tr=${t}`).join('&');
      }
    } else if (r.MagnetUri && !r.MagnetUri.startsWith('magnet:')) {
      torrentLink = r.MagnetUri;
    } else {
      return null;
    }
    return {
      name,
      title: label,
      infoHash: r.InfoHash,
      url: `${baseUrl}/stream?link=${encodeURIComponent(torrentLink)}&index=1&play${cfg.saveToDb ? '&save=true' : ''}`,
      behaviorHints: {
        videoSize: r.Size || 0,
        filename: r.Title
          ? `${r.Title.replace(/[^a-zA-Z0-9._ -]/g, '')}.${guessExtension(r.CategoryDesc)}`
          : 'video.mkv',
      },
    };
  }
  // Non-TorrServer: Torrentio-format (name\nquality, title with emoji)
  const quality = guessQuality(r.Title);
  const provName = r._provider || 'Unknown';
  const trackerName = r._trackerName || provName;
  const entry = {
    name: `${provName}\n${quality}`,
    title: `${r.Title}\n👤 ${r.Seeders || 0} 💾 ${r.Size ? (r.Size / 1e9).toFixed(2) + ' GB' : '?'} ⚙️ ${trackerName}`,
    infoHash: r.InfoHash,
    fileIdx: 0,
    behaviorHints: {
      bingeGroup: `${provName.toLowerCase()}|${quality}`,
      videoSize: r.Size || 0,
      filename: r.Title
        ? `${r.Title.replace(/[^a-zA-Z0-9._ -]/g, '')}.${guessExtension(r.CategoryDesc)}`
        : 'video.mkv',
    },
  };
  if (r._trackers?.length) {
    entry.sources = r._trackers.map(t => `tracker:${t}`);
    // Clean magnet URI (no tracker: prefix) for Stremio "Copy magnet" / TorrServer
    entry.url = `magnet:?xt=urn:btih:${r.InfoHash}&dn=${encodeURIComponent(r.Title || provName)}&tr=${r._trackers.join('&tr=')}`;
  } else if (r.InfoHash) {
    entry.url = `magnet:?xt=urn:btih:${r.InfoHash}&dn=${encodeURIComponent(r.Title || provName)}`;
  }
  return entry;
}

// ---- Jackett (Torznab API) ----
const torznabParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function parseTorznabItems(items, provider) {
  if (!items) return [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map(item => {
    const attrs = {};
    (Array.isArray(item['torznab:attr']) ? item['torznab:attr'] : [item['torznab:attr']]).filter(Boolean).forEach(a => { attrs[a['@_name']] = a['@_value']; });
    const rawSize = item.size || attrs.size || '0';
    const rawTracker = item.jackettindexer || item.indexer || '';
    return {
      Title: item.title || '',
      Seeders: parseInt(attrs.seeders || '0', 10),
      Size: parseInt(typeof rawSize === 'object' ? (rawSize['#text'] || '0') : rawSize, 10),
      InfoHash: (attrs.infohash || '').toLowerCase(),
      MagnetUri: attrs.magneturl || item.link || '',
      CategoryDesc: attrs.category || '',
      _provider: provider,
      _trackerName: typeof rawTracker === 'object' ? (rawTracker['#text'] || '') : rawTracker,
    };
  }).filter(r => r.MagnetUri || r.InfoHash);
}

// Parse .torrent buffer → infoHash + announceUrls
function parseTorrentFile(buf) {
  try {
    const s = buf.toString('binary');
    const urls = [];
    // extract announce URL (single tracker)
    const annMatch = s.match(/8:announce(\d+):/);
    if (annMatch) {
      const len = parseInt(annMatch[1], 10);
      const start = annMatch.index + annMatch[0].length;
      urls.push(s.slice(start, start + len));
    }
    // extract announce-list (multi-tracker tiers)
    const alIdx = s.indexOf('13:announce-list');
    if (alIdx !== -1) {
      let i = alIdx + 17; // skip "13:announce-list"
      if (s[i] === 'l') i++; // skip outer list start
      let depth = 1; // inside outer list
      while (i < s.length && depth > 0) {
        if (s[i] === 'l') { i++; continue; } // inner list start
        if (s[i] === 'e') { depth--; i++; continue; } // end of list
        // string: <digits>:<data>
        const colon = s.indexOf(':', i);
        if (colon === -1) break;
        const len = parseInt(s.slice(i, colon), 10);
        if (isNaN(len)) break;
        i = colon + 1;
        const url = s.slice(i, i + len);
        if (url && !urls.includes(url)) urls.push(url);
        i += len;
      }
    }
    // extract infoHash
    const infoIdx = s.indexOf('4:info');
    if (infoIdx === -1) return null;
    let i = infoIdx + 6;
    if (s[i] !== 'd') return null;
    let depth = 1; i++;
    while (depth > 0 && i < s.length) {
      const ch = s[i];
      if (ch === 'e') { depth--; i++; continue; }
      if (ch === 'd' || ch === 'l') { depth++; i++; continue; }
      if (ch === 'i') { while (i < s.length && s[i] !== 'e') i++; i++; continue; }
      if (ch >= '0' && ch <= '9') { const colon = s.indexOf(':', i); if (colon === -1) return null; i = colon + 1 + parseInt(s.slice(i, colon), 10); continue; }
      i++;
    }
    return { infoHash: crypto.createHash('sha1').update(buf.slice(infoIdx + 6, i)).digest('hex').toLowerCase(), announceUrls: urls };
  } catch { return null; }
}

// Follow Jackett proxy → get infoHash (+ announce URLs via .torrent parse)
async function resolveProxyToMagnet(r) {
  if (!r.MagnetUri || r.MagnetUri.startsWith('magnet:') || r.InfoHash) return;
  try {
    const resp = await fetch(r.MagnetUri, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    log(`resolve ${r._provider} ${r.Title?.slice(0,30)}: HTTP ${resp.status} ct=${resp.headers.get('content-type')?.slice(0,20)}`);
    if ((resp.status === 302 || resp.status === 301) && resp.headers.get('location')?.startsWith('magnet:')) {
      const loc = resp.headers.get('location');
      r.MagnetUri = loc;
      const m = loc.match(/urn:btih:([a-f0-9]{40})/i);
      if (m) r.InfoHash = m[1].toLowerCase();
      try { const usp = new URLSearchParams(loc.slice(loc.indexOf('?') + 1)); usp.forEach((v, k) => { if (k === 'tr') { if (!r._trackers) r._trackers = []; r._trackers.push(v); } }); } catch {}
      log(`  → magnet: ${r.InfoHash?.slice(0,16)} trackers:${r._trackers?.length || 0}`);
    } else if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!buf.length) { log(`  → empty body`); return; }
      const meta = parseTorrentFile(buf);
      if (meta) {
        r.InfoHash = meta.infoHash;
        if (meta.announceUrls?.length) r._trackers = meta.announceUrls;
        r.MagnetUri = `magnet:?xt=urn:btih:${meta.infoHash}&dn=${r.Title || ''}`;
        if (meta.announceUrls?.length) r.MagnetUri += '&' + meta.announceUrls.map(u => `tr=${u}`).join('&');
        log(`  → parsed: ${r.InfoHash?.slice(0,16)} trackers:${meta.announceUrls?.length}`);
        // Cache .torrent buffer for TorrServer direct download
        torrentCache.set(r.InfoHash, { buf, time: Date.now() });
      } else log(`  → parseTorrentFile returned null`);
    } else log(`  → unexpected HTTP ${resp.status}`);
  } catch(e) { log(`resolve error ${r._provider} ${r.Title?.slice(0,20)}: ${e.message?.slice(0,60)}`); }
}

async function searchJackett(cfg, type, imdbId) {
  if (!cfg.jackettUrl || !cfg.jackettApiKey) return [];
  const params = new URLSearchParams({ apikey: cfg.jackettApiKey, t: 'search', cat: '', q: imdbId, extended: '1' });
  const url = `${cfg.jackettUrl.replace(/\/+$/, '')}/api/v2.0/indexers/all/results/torznab/api?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Jackett HTTP ${res.status}`);
  const parsed = torznabParser.parse(await res.text());
  const results = parseTorznabItems(parsed?.rss?.channel?.item, 'Jackett').sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));
  // Live check: resolve proxy → magnet for top 10 (max 8s total)
  await Promise.race([
    Promise.allSettled(results.slice(0, 10).map(r => resolveProxyToMagnet(r))),
    new Promise(r => setTimeout(r, 8000)),
  ]);
  return results;
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
    signal: AbortSignal.timeout(12000),
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
      _trackerName: r.indexer || '',
    }))
    .sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));
}

// ---- Helper: strip /manifest.json suffix and trailing slash ----
function stripManifestPath(url) {
  return url.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
}

// Provider name → config code for priority ordering
function codeOf(provider) {
  const map = { Jackett: 'j', Prowlarr: 'p', Torrentio: 't', Comet: 'o', Peerflix: 'e', Jacred: 'a', MediaFusion: 'f', Magnetz: 'z' };
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
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
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
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
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
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
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

// ---- Peerflix (Comet-compatible) ----
async function searchPeerflix(cfg, type, id) {
  if (!cfg.peerflixUrl) return [];
  const url = `${stripManifestPath(cfg.peerflixUrl)}/stream/${type}/${id}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Peerflix HTTP ${res.status}`);
  const data = await res.json();
  return (data.streams || []).filter(s => s.infoHash || s.url).map(s => ({
    Title: s.title || s.name || '',
    Seeders: parseInt((s.name || '').match(/(\d+)\s*Seeders?/i)?.[1] || '0', 10),
    Size: s.behaviorHints?.videoSize || 0,
    InfoHash: s.infoHash || '',
    MagnetUri: '',
    CategoryDesc: '',
    _provider: 'Peerflix',
    _rawStream: s,
  }));
}

// ---- Magnetz (search API: /api/magnets/search?query=) ----
async function searchMagnetz(cfg, type, imdbId) {
  if (!cfg.magnetzUrl) return [];
  const base = cfg.magnetzUrl.replace(/\/+$/, '');
  const url = `${base}/api/magnets/search?query=${encodeURIComponent(imdbId)}&page=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Magnetz HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).map(r => ({
    Title: r.name || '',
    Seeders: r.seeders || 0,
    Size: r.size || 0,
    InfoHash: (r.info_hash || '').toLowerCase(),
    MagnetUri: r.magnet_link || '',
    CategoryDesc: '',
    _provider: 'Magnetz',
  }));
}

// ---- Jacred (Jackett-compatible + REST API) ----
// Tries REST API (/api/v1.0/torrents) first when no API key (jacred-go format).
// Falls back to Torznab (/api/v2.0/...) when API key is set or REST fails.
async function searchJacred(cfg, type, imdbId) {
  if (!cfg.jacredUrl) return [];
  const base = cfg.jacredUrl.replace(/\/+$/, '');
  let results = null;

  // Try REST API first (no API key needed, bypasses Cloudflare)
  if (!cfg.jacredApiKey) {
    try {
      const restUrl = `${base}/api/v1.0/torrents?search=${encodeURIComponent(imdbId)}`;
      const restRes = await fetch(restUrl, { signal: AbortSignal.timeout(10000) });
      if (restRes.ok) {
        const data = await restRes.json();
        if (Array.isArray(data) && data.length > 0) {
          results = data.map(r => ({
            Title: r.title || '',
            Seeders: r.sid || 0,
            Size: r.size || 0,
            InfoHash: (r.magnet || '').match(/btih:([a-f0-9]+)/i)?.[1]?.toLowerCase() || '',
            MagnetUri: r.magnet || '',
            CategoryDesc: '',
            _provider: 'Jacred',
            _trackerName: r.tracker || '',
          }));
          log(`  Jacred REST: ${results.length} results`);
        }
      }
    } catch (e) { /* REST failed, fall through to Torznab */ }
  }

  // Fallback to Torznab (Jackett format) if REST returned nothing
  if (!results) {
    try {
      const params = new URLSearchParams({ t: 'search', cat: '', q: imdbId, extended: '1' });
      if (cfg.jacredApiKey) params.set('apikey', cfg.jacredApiKey);
      const torUrl = `${base}/api/v2.0/indexers/all/results/torznab/api?${params}`;
      const torRes = await fetch(torUrl, { signal: AbortSignal.timeout(12000) });
      if (torRes.ok) {
        const parsed = torznabParser.parse(await torRes.text());
        const items = parseTorznabItems(parsed?.rss?.channel?.item, 'Jacred');
        if (items.length > 0) results = items;
      }
    } catch (e) { err(`  Jacred Torznab failed: ${e.message?.slice(0,60)}`); }
  }

  if (!results) return [];
  results.sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));
  await Promise.race([
    Promise.allSettled(results.slice(0, 10).map(r => resolveProxyToMagnet(r))),
    new Promise(r => setTimeout(r, 8000)),
  ]);
  return results;
}

// ============================================================================
// 5. STREAM HANDLER (multi-provider)
// ============================================================================
async function handleStream(config, type, id) {
  const ck = streamCacheKey(type, id, config);
  const cached = streamCacheGet(ck);
  if (cached) { log(`  Cache hit ${type}:${id}`); return cached; }
  try {
    const imdbId = extractIMDbId(id);
    if (!imdbId) {
      log(`No IMDb ID in ${id}`);
      return { streams: [] };
    }
    log(`Stream request: ${type} ${imdbId} | id=${id}`);

    // Query all providers in parallel
    const promises = [];
    if (config.jackettUrl) { log(`  + Jackett: ${config.jackettUrl}`); promises.push(searchJackett(config, type, imdbId)); }
    if (config.prowlarrUrl) { log(`  + Prowlarr: ${config.prowlarrUrl}`); promises.push(searchProwlarr(config, imdbId, type)); }
    if (config.torrentioUrl) { log(`  + Torrentio: ${config.torrentioUrl}`); promises.push(searchTorrentio(config, type, id)); }
    if (config.cometUrl) { log(`  + Comet: ${config.cometUrl}`); promises.push(searchComet(config, type, id)); }
    if (config.peerflixUrl) { log(`  + Peerflix: ${config.peerflixUrl}`); promises.push(searchPeerflix(config, type, id)); }
    if (config.jacredUrl) { log(`  + Jacred: ${config.jacredUrl}`); promises.push(searchJacred(config, type, imdbId)); }
    if (config.mediafusionUrl) { log(`  + MediaFusion: ${config.mediafusionUrl}`); promises.push(searchMediaFusion(config, type, id)); }
    if (config.magnetzUrl) { log(`  + Magnetz: ${config.magnetzUrl}`); promises.push(searchMagnetz(config, type, imdbId)); }

    if (promises.length === 0) {
      log(`  No providers configured → empty`);
      return { streams: [] };
    }

    const results = [];
    const settled = await Promise.allSettled(promises);
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(...r.value);
        log(`  ✓ ${r.value.length || 0} results from a provider`);
      } else {
        err(`  ✗ Provider error: ${r.reason?.message?.slice(0,60) || r.reason}`);
      }
    }

    if (results.length === 0) {
      log(`  All providers returned 0 results`);
      return { streams: [] };
    }

    // Live check: try to resolve any remaining results without infoHash (max 5s)
    const needCheck = results.filter(r => !r.InfoHash && r.MagnetUri && !r.MagnetUri.startsWith('magnet:')).slice(0, 5);
    if (needCheck.length > 0) {
      log(`  Live check: ${needCheck.length} unverified results`);
      await Promise.race([
        Promise.allSettled(needCheck.map(r => resolveProxyToMagnet(r))),
        new Promise(r => setTimeout(r, 5000)),
      ]);
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
    const order = config.providerOrder || ['j','p','t','o','e','a','f','z'];
    const orderIdx = { j: 0, p: 1, t: 2, o: 3, a: 4, f: 5 };
    unique.sort((a, b) => {
      const pa = order.indexOf(codeOf(a._provider));
      const pb = order.indexOf(codeOf(b._provider));
      if (pa !== pb) return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
      return (b.Seeders || 0) - (a.Seeders || 0);
    });

    const maxResults = config.maxResults || 5;
    const streams = unique.slice(0, maxResults).filter(r => config.torrServerUrl || r.InfoHash).map(r => {
      // If TorrServer configured, route EVERYTHING through TorrServer
      if (config.torrServerUrl) {
        const s = buildStreamEntry(r, config);
        if (s) log(`  → TorrServer: magnet ${r.InfoHash?.slice(0, 12)}...`);
        else log(`  → TorrServer skip: no magnet for ${r._provider} ${r.Title?.slice(0, 30)}`);
        return s;
      }
      // Proxy-style providers (Torrentio, Comet, MediaFusion) — pass through raw stream format
      if ((r._provider === 'Torrentio' || r._provider === 'Comet' || r._provider === 'Peerflix' || r._provider === 'MediaFusion') && r._rawStream) {
        const s = { ...r._rawStream };
        s.name = `[${r._provider}] ${s.name || ''}`;
        log(`  → Proxy pass: ${r._provider} infoHash=${s.infoHash?.slice(0, 12)}...`);
        return s;
      }
      return buildStreamEntry(r, config);
    }).filter(Boolean);

    log(`  → ${streams.length} streams returned (${results.length} raw, ${unique.length} unique)`);
    const out = { streams, cacheMaxAge: 600 };
    streamCacheSet(ck, out);
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
:root{--bg:#080810;--bg-card:#12121e;--border:#1e1e35;--text:#e8e8f0;--text-dim:#7878a0;--primary:#7c3aed;--primary-hover:#8b5cf6;--accent:#f59e0b;--success:#10b981;--error:#ef4444;--radius:14px}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;background-image:radial-gradient(ellipse at 20% 50%,rgba(124,58,237,.06) 0%,transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(245,158,11,.04) 0%,transparent 50%)}
.header{padding:20px;text-align:center;border-bottom:1px solid var(--border);position:relative}
.header::after{content:'';position:absolute;bottom:-1px;left:10%;right:10%;height:1px;background:linear-gradient(90deg,transparent,var(--primary),transparent)}
.header h1{font-size:22px;font-weight:800;background:linear-gradient(135deg,#c084fc,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.header p{font-size:13px;color:var(--text-dim);margin-top:4px}
.tab-content{flex:1;overflow-y:auto;padding:14px}
.tab-content .tab-pane{display:none;animation:fadeIn .25s ease}
.tab-content .tab-pane.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.tab-bar{display:flex;border-top:1px solid var(--border);background:var(--bg-card);position:sticky;bottom:0;backdrop-filter:blur(12px);background:rgba(18,18,30,.85)}
.tab-btn{flex:1;padding:14px;text-align:center;font-size:13px;font-weight:600;cursor:pointer;color:var(--text-dim);border:none;background:none;transition:all .2s;position:relative}
.tab-btn.active{color:var(--accent)}
.tab-btn.active::after{content:'';position:absolute;top:0;left:20%;right:20%;height:2px;background:var(--accent);border-radius:0 0 4px 4px}
.tab-btn:hover{color:var(--text)}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:12px;overflow:hidden;transition:border-color .2s,box-shadow .2s}
.card:focus-within{border-color:var(--primary);box-shadow:0 0 0 1px rgba(124,58,237,.2)}
.card-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:700}
.badge{font-size:10px;padding:3px 10px;border-radius:20px;background:var(--border);color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.badge.success{background:rgba(16,185,129,.15);color:var(--success)}
.badge.error{background:rgba(239,68,68,.15);color:var(--error)}
.provider-card{padding:12px 16px}
.provider-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.provider-name{font-size:14px;font-weight:700}
.toggle{width:42px;height:24px;border-radius:12px;background:var(--border);cursor:pointer;position:relative;transition:background .25s;flex-shrink:0}
.toggle.active{background:var(--primary);box-shadow:0 0 12px rgba(124,58,237,.3)}
.toggle::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .25s cubic-bezier(.4,0,.2,1)}
.toggle.active::after{transform:translateX(18px)}
.form-group{margin-bottom:10px}
.form-group label{display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-dim);letter-spacing:.3px}
.form-group input,.form-group select{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:rgba(0,0,0,.2);color:var(--text);font-size:13px;outline:none;transition:border-color .2s,box-shadow .2s}
.form-group input:focus,.form-group select:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(124,58,237,.15)}
.form-group .hint{font-size:11px;color:var(--text-dim);margin-top:4px;word-break:break-all;line-height:1.4}
.form-group .hint code{background:var(--bg-card);padding:2px 6px;border-radius:4px;font-size:10px;border:1px solid var(--border)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:10px;border:none;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;letter-spacing:.3px}
.btn-primary{background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;box-shadow:0 2px 12px rgba(124,58,237,.25)}
.btn-primary:hover{background:linear-gradient(135deg,#8b5cf6,#7c3aed);transform:translateY(-1px);box-shadow:0 4px 16px rgba(124,58,237,.35)}
.btn-success{background:linear-gradient(135deg,#10b981,#059669);color:#fff;box-shadow:0 2px 10px rgba(16,185,129,.25)}
.btn-success:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(16,185,129,.35)}
.btn-secondary{background:var(--border);color:var(--text)}
.btn-secondary:hover{background:#2a2a44;transform:translateY(-1px)}
.btn-sm{padding:6px 12px;font-size:11px}
.btn-lg{width:100%;justify-content:center;padding:14px;font-size:14px}
.test-result{display:none;margin-top:8px;padding:8px 12px;border-radius:10px;font-size:12px}
.test-result.show{display:block}
.test-result.success{background:rgba(16,185,129,.1);color:var(--success);border:1px solid rgba(16,185,129,.2)}
.test-result.error{background:rgba(239,68,68,.1);color:var(--error);border:1px solid rgba(239,68,68,.2)}
.result-box{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-top:14px;word-break:break-all;border:1px solid var(--primary);box-shadow:0 0 20px rgba(124,58,237,.1)}
.result-url{font-size:11px;color:var(--text-dim);margin-bottom:12px;word-break:break-all;font-family:monospace;background:rgba(0,0,0,.3);padding:8px 10px;border-radius:8px;line-height:1.5}
.result-actions{display:flex;gap:10px;flex-wrap:wrap}
.toast{position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:rgba(18,18,30,.95);backdrop-filter:blur(12px);color:var(--text);padding:12px 24px;border-radius:12px;font-size:13px;border:1px solid var(--border);opacity:0;transition:opacity .3s;pointer-events:none;z-index:100;box-shadow:0 4px 24px rgba(0,0,0,.4)}
.toast.show{opacity:1}
</style>
</head>
<body>
<div class="header">
  <h1>UniTorrent</h1>
  <p>Jackett + Prowlarr + Torrentio + Comet + Peerflix + Jacred + MediaFusion → TorrServer</p>
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
    <!-- Peerflix -->
    <div class="card">
      <div class="card-header">
        Peerflix <span class="badge" id="peerflixBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name">Peerflix</span>
          <label class="toggle" id="peerflixToggle"></label>
        </div>
        <div class="form-group">
          <label>Peerflix Manifest URL</label>
          <input type="url" id="peerflixUrl" placeholder="https://peerflix.mov/manifest.json">
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary btn-sm" onclick="testPeerflix()">Test</button>
          <div style="margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">
            Priority
            <input type="number" id="peerflixPriority" min="1" max="6" value="3" style="width:40px;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;text-align:center">
          </div>
        </div>
        <div class="test-result" id="peerflixTestResult"></div>
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
          <label>Torrentio Manifest URL <span style="color:var(--text-dim);font-weight:400">(default: torrentio.strem.fun)</span></label>
          <input type="url" id="torrentioUrl" placeholder="https://torrentio.strem.fun/manifest.json">
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary btn-sm" onclick="testTorrentio()">Test</button>
          <div style="margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">
            Priority
            <input type="number" id="torrentioPriority" min="1" max="6" value="2" style="width:40px;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;text-align:center">
          </div>
        </div>
        <div class="test-result" id="torrentioTestResult"></div>
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
          <label>API Key <span style="color:var(--text-dim);font-weight:400">(optional — REST API used if empty)</span></label>
          <input type="text" id="jacredApiKey" placeholder="Leave empty if REST API is available">
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
    <!-- Magnetz -->
    <div class="card">
      <div class="card-header">
        Magnetz <span class="badge" id="magnetzBadge">Off</span>
      </div>
      <div class="provider-card">
        <div class="provider-header">
          <span class="provider-name">Magnetz</span>
          <label class="toggle" id="magnetzToggle"></label>
        </div>
        <div class="form-group">
          <label>Magnetz URL</label>
          <input type="url" id="magnetzUrl" placeholder="https://magnetz.eu">
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary btn-sm" onclick="testMagnetz()">Test</button>
          <div style="margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">
            Priority
            <input type="number" id="magnetzPriority" min="1" max="6" value="3" style="width:40px;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;text-align:center">
          </div>
        </div>
        <div class="test-result" id="magnetzTestResult"></div>
      </div>
    </div>
  </div> <!-- /provider tab -->

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
  if (!el) return;
  el.addEventListener('click', (e) => {
    e.preventDefault();
    el.classList.toggle('active');
    // Update badge: On when toggle active + URL filled, else Off
    const badgeId = id.replace('Toggle', 'Badge');
    const urlId = id.replace('Toggle', 'Url').toLowerCase();
    const urlEl = document.getElementById(urlId);
    const badge = document.getElementById(badgeId);
    if (badge) {
      const hasUrl = urlEl && urlEl.value && urlEl.value.trim();
      if (el.classList.contains('active') && hasUrl) {
        badge.textContent = 'On';
        badge.className = 'badge success';
      } else {
        badge.textContent = 'Off';
        badge.className = 'badge';
      }
    }
  });
}
setupToggle('jackettToggle');
setupToggle('prowlarrToggle');
setupToggle('torrentioToggle');
setupToggle('cometToggle');
setupToggle('peerflixToggle');
setupToggle('jacredToggle');
setupToggle('mediafusionToggle');
setupToggle('magnetzToggle');
function collectConfig() {
  const priorities = {
    j: parseInt(document.getElementById('jackettPriority').value) || 3,
    p: parseInt(document.getElementById('prowlarrPriority').value) || 3,
    t: parseInt(document.getElementById('torrentioPriority').value) || 3,
    o: parseInt(document.getElementById('cometPriority').value) || 3,
    e: parseInt(document.getElementById('peerflixPriority').value) || 3,
    a: parseInt(document.getElementById('jacredPriority').value) || 3,
    f: parseInt(document.getElementById('mediafusionPriority').value) || 3,
    z: parseInt(document.getElementById('magnetzPriority').value) || 3,
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
    peerflixUrl: document.getElementById('peerflixUrl').value,
    peerflixEnabled: document.getElementById('peerflixToggle').classList.contains('active'),
    jacredUrl: document.getElementById('jacredUrl').value,
    jacredApiKey: document.getElementById('jacredApiKey').value,
    jacredEnabled: document.getElementById('jacredToggle').classList.contains('active'),
    mediafusionUrl: document.getElementById('mediafusionUrl').value,
    mediafusionEnabled: document.getElementById('mediafusionToggle').classList.contains('active'),
    magnetzUrl: document.getElementById('magnetzUrl').value,
    magnetzEnabled: document.getElementById('magnetzToggle').classList.contains('active'),
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
  const hasPeerflix = cfg.peerflixEnabled && cfg.peerflixUrl;
  const hasJacred = cfg.jacredEnabled && cfg.jacredUrl;
  const hasMediaFusion = cfg.mediafusionEnabled && cfg.mediafusionUrl;
  const hasMagnetz = cfg.magnetzEnabled && cfg.magnetzUrl;
  if (!hasJackett && !hasProwlarr && !hasTorrentio && !hasComet && !hasPeerflix && !hasJacred && !hasMediaFusion && !hasMagnetz) {
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
async function testTorrentio() {
  const url = document.getElementById('torrentioUrl').value || 'https://torrentio.strem.fun/manifest.json';
  const el = document.getElementById('torrentioTestResult');
  try {
    el.className = 'test-result'; el.textContent = 'Testing...';
    const r = await fetch('/api/test/torrentio?url=' + encodeURIComponent(url));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? d.message : d.message;
    document.getElementById('torrentioBadge').textContent = d.ok ? 'OK' : 'Error';
    document.getElementById('torrentioBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) { el.className = 'test-result show error'; el.textContent = e.message; }
}
async function testPeerflix() {
  const url = document.getElementById('peerflixUrl').value;
  const el = document.getElementById('peerflixTestResult');
  if (!url) { el.className = 'test-result show error'; el.textContent = 'Enter URL'; return; }
  try {
    el.className = 'test-result'; el.textContent = 'Testing...';
    const r = await fetch('/api/test/peerflix?url=' + encodeURIComponent(url));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? d.message : d.message;
    document.getElementById('peerflixBadge').textContent = d.ok ? 'OK' : 'Error';
    document.getElementById('peerflixBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
  } catch (e) { el.className = 'test-result show error'; el.textContent = e.message; }
}
async function testJacred() {
  const url = document.getElementById('jacredUrl').value;
  const key = document.getElementById('jacredApiKey').value;
  const el = document.getElementById('jacredTestResult');
  if (!url) { el.className = 'test-result show error'; el.textContent = 'Enter URL'; return; }
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
async function testMagnetz() {
  const url = document.getElementById('magnetzUrl').value;
  const el = document.getElementById('magnetzTestResult');
  if (!url) { el.className = 'test-result show error'; el.textContent = 'Enter URL'; return; }
  try {
    el.className = 'test-result'; el.textContent = 'Testing...';
    const r = await fetch('/api/test/magnetz?url=' + encodeURIComponent(url));
    const d = await r.json();
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.ok ? d.message : d.message;
    document.getElementById('magnetzBadge').textContent = d.ok ? 'OK' : 'Error';
    document.getElementById('magnetzBadge').className = 'badge ' + (d.ok ? 'success' : 'error');
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
    peerflixUrl: c.peerflixUrl,
    jacredUrl: c.jacredUrl, jacredApiKey: c.jacredApiKey,
    mediafusionUrl: c.mediafusionUrl,
    magnetzUrl: c.magnetzUrl,
    torrServerUrl: c.torrServerUrl, torrServerUser: c.torrServerUser,
    torrServerPassword: c.torrServerPassword, torrServerType: c.torrServerType || 'official',
    saveToDb: c.saveToDb || false,
    maxResults: c.maxResults || 5,
    // All priorities equal by default — matches collectConfig defaults
    jackettPriority: 3, prowlarrPriority: 3, torrentioPriority: 3,
    cometPriority: 3, peerflixPriority: 3, jacredPriority: 3, mediafusionPriority: 3, magnetzPriority: 3,
  };
  const toggleMap = {
    jackettUrl: 'jackettToggle', prowlarrUrl: 'prowlarrToggle',
    torrentioUrl: 'torrentioToggle', cometUrl: 'cometToggle',
    peerflixUrl: 'peerflixToggle', jacredUrl: 'jacredToggle', mediafusionUrl: 'mediafusionToggle',
    magnetzUrl: 'magnetzToggle',
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
  // Sync badges after config load
  for (const toggleId of Object.values(toggleMap)) {
    const toggle = document.getElementById(toggleId);
    const badgeId = toggleId.replace('Toggle', 'Badge');
    const urlId = toggleId.replace('Toggle', 'Url').toLowerCase();
    const urlEl = document.getElementById(urlId);
    const badge = document.getElementById(badgeId);
    if (badge && toggle) {
      const hasUrl = urlEl && urlEl.value && urlEl.value.trim();
      if (toggle.classList.contains('active') && hasUrl) {
        badge.textContent = 'On';
        badge.className = 'badge success';
      } else {
        badge.textContent = 'Off';
        badge.className = 'badge';
      }
    }
  }
  // Auto-update badges when URL fields change
  function syncBadge(toggleId) {
    const toggle = document.getElementById(toggleId);
    const badgeId = toggleId.replace('Toggle', 'Badge');
    const urlId = toggleId.replace('Toggle', 'Url').toLowerCase();
    const urlEl = document.getElementById(urlId);
    const badge = document.getElementById(badgeId);
    if (!badge || !toggle) return;
    const hasUrl = urlEl && urlEl.value && urlEl.value.trim();
    if (toggle.classList.contains('active') && hasUrl) {
      badge.textContent = 'On';
      badge.className = 'badge success';
    } else {
      badge.textContent = 'Off';
      badge.className = 'badge';
    }
  }
  for (const [fieldId, toggleId] of Object.entries(toggleMap)) {
    const urlEl = document.getElementById(fieldId);
    if (urlEl) urlEl.addEventListener('input', () => syncBadge(toggleId));
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
// CORS — allow Stremio web + any origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Suppress browser console warnings about Permissions-Policy features
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy',
    'browsing-topics=(), run-ad-auction=(), join-ad-interest-group=(), private-aggregation=()');
  next();
});

// Helper: public-facing URL — checks PUBLIC_URL env, X-Forwarded headers, then request host
function getBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

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
    peerflixUrl: q.peerflixUrl || '',
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
    magnetzUrl: q.magnetzUrl || '',
  };
}

// ---- .torrent file download for TorrServer ----
// TorrServer fetches the .torrent directly instead of using magnet URI
// (needed for private trackers where infoHash alone can't find peers)
app.get('/api/torrent/:hash.torrent', (req, res) => {
  const hash = req.params.hash.toLowerCase();
  const entry = torrentCache.get(hash);
  if (!entry || (Date.now() - entry.time) > TORRENT_CACHE_TTL) {
    torrentCache.delete(hash);
    return res.status(404).send('Torrent not found or expired');
  }
  res.set('Content-Type', 'application/x-bittorrent');
  res.set('Content-Disposition', `attachment; filename="${hash}.torrent"`);
  res.send(entry.buf);
});

// ---- Clean routes for Stremio native config ----
// Manifest (no embedded config — Stremio shows config form)
app.get('/manifest.json', (req, res) => {
  res.json(getManifest(true));
});
// Stream search with config from query params (Stremio passes config values)
app.get('/stream/:type/:id.json', async (req, res) => {
  const cfg = configFromQuery(req.query);
  cfg._addonBase = getBaseUrl(req);
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
    peerflixUrl: body.peerflixEnabled ? (body.peerflixUrl || '') : '',
    jacredUrl: body.jacredEnabled ? (body.jacredUrl || '') : '',
    jacredApiKey: body.jacredEnabled ? (body.jacredApiKey || '') : '',
    mediafusionUrl: body.mediafusionEnabled ? (body.mediafusionUrl || '') : '',
    magnetzUrl: body.magnetzEnabled ? (body.magnetzUrl || '') : '',
    torrServerUrl: body.torrServerUrl || '',
    torrServerUser: body.torrServerUser || '',
    torrServerPassword: body.torrServerPassword || '',
    torrServerType: body.torrServerType || 'official',
    saveToDb: !!body.saveToDb,
    providerOrder: Array.isArray(body.providerOrder) ? body.providerOrder : undefined,
    maxResults: body.maxResults || 5,
  };
  const b64 = encodeConfig(cfg);
  const baseUrl = getBaseUrl(req);
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
      signal: AbortSignal.timeout(25000),
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

// ---- API: Test Torrentio ----
app.get('/api/test/torrentio', async (req, res) => {
  try {
    const { url } = req.query;
    const r = await fetch(`${stripManifestPath(url || 'https://torrentio.strem.fun')}/stream/movie/tt0133093.json`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const count = (data.streams || []).length;
    res.json({ ok: true, message: `✅ Torrentio OK — ${count} streams for The Matrix` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---- API: Test Jacred ----
app.get('/api/test/jacred', async (req, res) => {
  try {
    const { url, key } = req.query;
    if (!url) { res.json({ ok: false, message: 'Missing URL' }); return; }
    const base = url.replace(/\/+$/, '');
    // Try REST API first (no API key needed)
    if (!key) {
      const rr = await fetch(`${base}/api/v1.0/torrents?search=tt0133093`, { signal: AbortSignal.timeout(10000) });
      if (rr.ok) {
        const data = await rr.json();
        const count = Array.isArray(data) ? data.length : 0;
        res.json({ ok: true, message: `✅ Jacred REST OK — ${count} results for The Matrix` });
        return;
      }
    }
    // Fallback to Torznab
    const r = await fetch(`${base}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(key || '')}&query=tt0133093`, {
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

// ---- API: Test Peerflix ----
app.get('/api/test/peerflix', async (req, res) => {
  try {
    const { url } = req.query;
    const r = await fetch(`${stripManifestPath(url)}/stream/movie/tt0133093.json`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const count = (data.streams || []).length;
    res.json({ ok: true, message: `✅ Peerflix OK — ${count} streams for The Matrix` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

app.get('/api/test/magnetz', async (req, res) => {
  try {
    const { url } = req.query;
    const r = await fetch(`${stripManifestPath(url)}/api/magnets/search?query=tt0133093&page=1`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const data = await r.json();
    const count = (data.data || []).length;
    res.json({ ok: true, message: `✅ Magnetz OK — ${count} results for The Matrix` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---- Torrentio-style routes (no UUID, just config) ----
app.get('/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  const hasConfig = !!(config.jackettUrl || config.prowlarrUrl || config.torrentioUrl || config.cometUrl || config.peerflixUrl || config.jacredUrl || config.mediafusionUrl || config.magnetzUrl);
  res.json(getManifest(!hasConfig));
});
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  config._addonBase = getBaseUrl(req);
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
  const hasConfig = !!(config.jackettUrl || config.prowlarrUrl || config.torrentioUrl || config.cometUrl || config.peerflixUrl || config.jacredUrl || config.mediafusionUrl || config.magnetzUrl);
  res.json(getManifest(!hasConfig));
});

app.get('/stremio/:uuid/:config/stream/:type/:id.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  config._addonBase = getBaseUrl(req);
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
