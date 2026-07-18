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
    cfg.bitmagnetUrl,
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
  description: 'Multi-provider Stremio addon: Jackett + Prowlarr + Torrentio + Comet + Peerflix + Jacred + MediaFusion + bitmagnet + Torznab → TorrServer streaming',
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
  if (config.bitmagnetUrl) c.b = { u: config.bitmagnetUrl.replace(/\/$/, '') };
  if (config.torznabUrl) c.n = { u: config.torznabUrl.replace(/\/$/, ''), k: config.torznabApiKey || '' };
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
  if (config.providerOrder) c.r = config.providerOrder;
  // Store priority values (only non-default to save space)
  const pv = {};
  const priorityCodeMap = [['j','jackettPriority'],['p','prowlarrPriority'],['t','torrentioPriority'],['o','cometPriority'],['e','peerflixPriority'],['a','jacredPriority'],['f','mediafusionPriority'],['z','magnetzPriority'],['b','bitmagnetPriority'],['n','torznabPriority']];
  for (const [code, key] of priorityCodeMap) {
    if (config[key] && config[key] !== 3) pv[code] = config[key];
  }
  if (Object.keys(pv).length) c.v = pv;
  c.m = Math.max(parseInt(config.maxResults || '5', 10) || 5, 1);
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
    if (d.b && d.b.u) { cfg.bitmagnetUrl = d.b.u; }
    if (d.n && d.n.u) { cfg.torznabUrl = d.n.u; cfg.torznabApiKey = d.n.k || ''; }
    // Restore priority values from stored config
    if (d.v) {
      const pvMap = { j: 'jackettPriority', p: 'prowlarrPriority', t: 'torrentioPriority', o: 'cometPriority', e: 'peerflixPriority', a: 'jacredPriority', f: 'mediafusionPriority', z: 'magnetzPriority', b: 'bitmagnetPriority', n: 'torznabPriority' };
      for (const [code, val] of Object.entries(d.v)) {
        if (pvMap[code]) cfg[pvMap[code]] = val;
      }
    }
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
      bitmagnetUrl: process.env.BITMAGNET_URL || '',
      torznabUrl: process.env.TORZNAB_URL || '',
      torznabApiKey: process.env.TORZNAB_API_KEY || '',
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
  const map = { Jackett: 'j', Prowlarr: 'p', Torrentio: 't', Comet: 'o', Peerflix: 'e', Jacred: 'a', MediaFusion: 'f', Magnetz: 'z', bitmagnet: 'b' };
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

// ---- bitmagnet (Torznab-compatible API) ----
async function searchBitmagnet(cfg, type, imdbId) {
  const base = cfg.bitmagnetUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ t: 'search', cat: '', q: imdbId, extended: '1' });
  const url = `${base}/torznab/api?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) return [];
  const parsed = torznabParser.parse(await res.text());
  const items = parseTorznabItems(parsed?.rss?.channel?.item, 'bitmagnet');
  return items.sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));
}

// ---- Torznab (generic Torznab-compatible endpoint) ----
async function searchTorznab(cfg, type, imdbId) {
  const base = cfg.torznabUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ t: 'search', cat: '', q: imdbId, extended: '1' });
  if (cfg.torznabApiKey) params.set('apikey', cfg.torznabApiKey);
  const url = `${base}?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) return [];
  const parsed = torznabParser.parse(await res.text());
  const items = parseTorznabItems(parsed?.rss?.channel?.item, 'Torznab');
  return items.sort((a, b) => (b.Seeders || 0) - (a.Seeders || 0));
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
    if (config.bitmagnetUrl) { log(`  + bitmagnet: ${config.bitmagnetUrl}`); promises.push(searchBitmagnet(config, type, imdbId).catch(() => [])); }
    if (config.torznabUrl) { log(`  + Torznab: ${config.torznabUrl}`); promises.push(searchTorznab(config, type, imdbId).catch(() => [])); }

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
    const order = config.providerOrder || ['j','p','t','o','e','a','f','z','b'];
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
  <p>Jackett + Prowlarr + Torrentio + Comet + Peerflix + Jacred + MediaFusion + bitmagnet → TorrServer</p>
</div>

<div class="tab-content">
  <div class="tab-pane active" id="tab-providers">
    <div id="providerList"></div>
    <div style="padding:8px 0">
      <div class="form-group">
        <select id="addProviderSelect" style="width:100%;padding:12px;border:1px dashed var(--border);border-radius:10px;background:rgba(0,0,0,.2);color:var(--text-dim);font-size:13px;cursor:pointer;appearance:none;text-align:center">
          <option value="">+ Add Provider</option>
          <option value="jackett">Jackett</option>
          <option value="prowlarr">Prowlarr</option>
          <option value="torrentio">Torrentio</option>
          <option value="comet">Comet</option>
          <option value="peerflix">Peerflix</option>
          <option value="jacred">Jacred</option>
          <option value="mediafusion">MediaFusion</option>
          <option value="magnetz">Magnetz</option>
          <option value="bitmagnet">bitmagnet</option>
          <option value="torznab">Torznab</option>
        </select>
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

// --- Provider Type Registry ---
var PROVIDER_DEFS = {
  jackett:    { name: 'Jackett',    code: 'j', fields: [{id:'url',label:'Jackett URL',placeholder:'http://192.168.1.100:9117'},{id:'apiKey',label:'API Key',placeholder:'API Key from Jackett'}] },
  prowlarr:   { name: 'Prowlarr',   code: 'p', fields: [{id:'url',label:'Prowlarr URL',placeholder:'http://192.168.1.100:9696'},{id:'apiKey',label:'API Key',placeholder:'API Key from Prowlarr'}] },
  torrentio:  { name: 'Torrentio',  code: 't', fields: [{id:'url',label:'Manifest URL',placeholder:'https://torrentio.strem.fun/manifest.json'}], defaultPriority: 2 },
  comet:      { name: 'Comet',      code: 'o', fields: [{id:'url',label:'Manifest URL',placeholder:'https://comet.feels.legal/manifest.json'}] },
  peerflix:   { name: 'Peerflix',   code: 'e', fields: [{id:'url',label:'Manifest URL',placeholder:'https://peerflix.mov/manifest.json'}] },
  jacred:     { name: 'Jacred',     code: 'a', fields: [{id:'url',label:'Jacred URL',placeholder:'http://192.168.1.100:9120'},{id:'apiKey',label:'API Key',placeholder:'Optional \u2014 REST API used if empty',optional:true}] },
  mediafusion:{ name: 'MediaFusion',code: 'f', fields: [{id:'url',label:'Manifest URL',placeholder:'https://mediafusion.elfhosted.com/manifest.json'}] },
  magnetz:    { name: 'Magnetz',    code: 'z', fields: [{id:'url',label:'Magnetz URL',placeholder:'https://magnetz.eu'}] },
  bitmagnet:  { name: 'bitmagnet',  code: 'b', fields: [{id:'url',label:'bitmagnet URL',placeholder:'http://localhost:3333'}] },
  torznab:    { name: 'Torznab',    code: 'n', fields: [{id:'url',label:'Torznab API URL',placeholder:'http://localhost:8080/torznab/api'},{id:'apiKey',label:'API Key',placeholder:'Optional — leave empty if public',optional:true}] },
};

// --- State ---
var addedProviders = []; // Array of { type, url, apiKey, priority, enabled }

// --- Rendering ---
function renderProviders() {
  var list = document.getElementById('providerList');
  list.innerHTML = '';
  addedProviders.forEach(function(p, idx) {
    var def = PROVIDER_DEFS[p.type];
    if (!def) return;
    var card = document.createElement('div');
    card.className = 'card';
    var html = '';
    html += '<div class="card-header" style="cursor:pointer" onclick="toggleProviderCard(' + idx + ')">';
    html += '<span>' + def.name + '</span>';
    html += '<div style="display:flex;align-items:center;gap:8px">';
    html += '<span class="badge" id="badge-' + idx + '">' + (p.enabled ? 'On' : 'Off') + '</span>';
    html += '<button class="btn btn-sm" style="color:var(--error);background:none;border:none;font-size:16px;padding:0 4px" onclick="event.stopPropagation();removeProvider(' + idx + ')">\u2715</button>';
    html += '</div></div>';
    html += '<div class="provider-card" id="card-body-' + idx + '" style="display:' + (p._expanded !== false ? 'block' : 'none') + '">';
    html += '<div class="provider-header">';
    html += '<span class="provider-name">' + def.name + '</span>';
    html += '<label class="toggle ' + (p.enabled ? 'active' : '') + '" id="toggle-' + idx + '" onclick="toggleProvider(' + idx + ')"></label>';
    html += '</div>';
    def.fields.forEach(function(f) {
      html += '<div class="form-group">';
      html += '<label>' + f.label + (f.optional ? ' <span style="color:var(--text-dim);font-weight:400">(optional)</span>' : '') + '</label>';
      html += '<input type="' + (f.id === 'apiKey' ? 'text' : 'url') + '" id="' + p.type + '_' + f.id + '-' + idx + '" placeholder="' + f.placeholder + '" value="' + (p[f.id] || '') + '" oninput="updateProviderField(' + idx + ',\\\'' + f.id + '\\\',this.value)">';
      html += '</div>';
    });
    html += '<div style="display:flex;gap:8px;align-items:center">';
    html += '<button class="btn btn-secondary btn-sm" onclick="testProvider(\\'' + p.type + '\\',' + idx + ')">Test</button>';
    html += '<div style="margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">';
    html += 'Priority <input type="number" min="1" max="20" value="' + p.priority + '" style="width:40px;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;text-align:center" oninput="updateProviderField(' + idx + ',\\'priority\\',parseInt(this.value)||3)">';
    html += '</div></div>';
    html += '<div class="test-result" id="testResult-' + idx + '"></div>';
    html += '</div>';
    card.innerHTML = html;
    list.appendChild(card);
  });
  updateBadge();
  // Disable already-added types in dropdown
  document.querySelectorAll('#addProviderSelect option').forEach(function(opt) {
    if (opt.value && addedProviders.some(function(p) { return p.type === opt.value; })) {
      opt.disabled = true;
      opt.textContent = opt.textContent.replace(/ \\(added\\)/g, '') + ' (added)';
    } else {
      opt.disabled = false;
      opt.textContent = opt.textContent.replace(/ \\(added\\)/g, '');
    }
  });
}

// --- Provider Management ---
function addProvider(type) {
  if (addedProviders.some(function(p) { return p.type === type; })) return;
  var def = PROVIDER_DEFS[type];
  addedProviders.push({ type: type, url: '', apiKey: '', priority: def.defaultPriority || 3, enabled: true, _expanded: true });
  renderProviders();
  document.getElementById('addProviderSelect').value = '';
}

function removeProvider(idx) {
  addedProviders.splice(idx, 1);
  renderProviders();
}

function toggleProviderCard(idx) {
  var body = document.getElementById('card-body-' + idx);
  if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
}

function toggleProvider(idx) {
  addedProviders[idx].enabled = !addedProviders[idx].enabled;
  renderProviders();
}

function updateProviderField(idx, field, value) {
  addedProviders[idx][field] = value;
  updateBadge();
}

function updateBadge() {
  addedProviders.forEach(function(p, idx) {
    var badge = document.getElementById('badge-' + idx);
    if (badge) {
      var hasUrl = p.url && p.url.trim();
      badge.textContent = p.enabled && hasUrl ? 'On' : 'Off';
      badge.className = 'badge' + (p.enabled && hasUrl ? ' success' : '');
    }
  });
}

function testProvider(type, idx) {
  var p = addedProviders[idx];
  var el = document.getElementById('testResult-' + idx);
  var testUrls = {
    jackett: '/api/test/jackett?url=' + encodeURIComponent(p.url) + '&key=' + encodeURIComponent(p.apiKey||''),
    prowlarr: '/api/test/prowlarr?url=' + encodeURIComponent(p.url) + '&key=' + encodeURIComponent(p.apiKey||''),
    torrentio: '/api/test/torrentio?url=' + encodeURIComponent(p.url),
    comet: '/api/test/comet?url=' + encodeURIComponent(p.url),
    peerflix: '/api/test/peerflix?url=' + encodeURIComponent(p.url),
    jacred: '/api/test/jacred?url=' + encodeURIComponent(p.url) + '&key=' + encodeURIComponent(p.apiKey||''),
    mediafusion: '/api/test/mediafusion?url=' + encodeURIComponent(p.url),
    magnetz: '/api/test/magnetz?url=' + encodeURIComponent(p.url),
    bitmagnet: '/api/test/bitmagnet?url=' + encodeURIComponent(p.url),
    torznab: '/api/test/torznab?url=' + encodeURIComponent(p.url) + '&key=' + encodeURIComponent(p.apiKey||''),
  };
  if (!p.url) { el.className = 'test-result show error'; el.textContent = 'Enter URL'; return; }
  el.className = 'test-result'; el.textContent = 'Testing...';
  fetch(testUrls[type]).then(function(r) { return r.json(); }).then(function(d) {
    el.className = 'test-result show ' + (d.ok ? 'success' : 'error');
    el.textContent = d.message;
  }).catch(function(e) { el.className = 'test-result show error'; el.textContent = e.message; });
}

// --- Config Collection ---
function collectConfig() {
  var providerCodeMap = { jackett:'j', prowlarr:'p', torrentio:'t', comet:'o', peerflix:'e', jacred:'a', mediafusion:'f', magnetz:'z', bitmagnet:'b', torznab:'n' };
  var priorities = {};
  addedProviders.forEach(function(p) {
    var code = providerCodeMap[p.type];
    if (code) priorities[code] = p.priority || 3;
  });
  var providerOrder = Object.entries(priorities).sort(function(a, b) { return a[1] - b[1]; }).map(function(e) { return e[0]; });

  var cfg = {
    jackettUrl: '', jackettApiKey: '', jackettEnabled: false,
    prowlarrUrl: '', prowlarrApiKey: '', prowlarrEnabled: false,
    torrentioUrl: '', torrentioEnabled: false,
    cometUrl: '', cometEnabled: false,
    peerflixUrl: '', peerflixEnabled: false,
    jacredUrl: '', jacredApiKey: '', jacredEnabled: false,
    mediafusionUrl: '', mediafusionEnabled: false,
    magnetzUrl: '', magnetzEnabled: false,
    bitmagnetUrl: '', bitmagnetEnabled: false,
    torrServerUrl: document.getElementById('torrServerUrl').value,
    torrServerUser: document.getElementById('torrServerUser').value,
    torrServerPassword: document.getElementById('torrServerPassword').value,
    torrServerType: document.getElementById('torrServerType').value,
    saveToDb: document.getElementById('saveToDb').checked,
    maxResults: document.getElementById('maxResults').value || 5,
    providerOrder: providerOrder,
  };

  addedProviders.forEach(function(p) {
    cfg[p.type + 'Url'] = p.url || '';
    cfg[p.type + 'Enabled'] = p.enabled;
    if (p.apiKey) cfg[p.type + 'ApiKey'] = p.apiKey;
    cfg[p.type + 'Priority'] = p.priority || 3;
  });

  return cfg;
}

// --- URL Generation ---
function generateUrl() {
  var cfg = collectConfig();
  // Check at least one provider is enabled with a URL
  var hasAny = addedProviders.some(function(p) { return p.enabled && p.url && p.url.trim(); });
  if (!hasAny) {
    showToast('Add and enable at least 1 provider');
    return;
  }
  fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  }).then(function(resp) {
    if (!resp.ok) { showToast('Server error'); return; }
    return resp.json();
  }).then(function(data) {
    if (!data) return;
    document.getElementById('resultUrl').textContent = data.manifestUrl;
    document.getElementById('stremioLink').href = data.stremioLink;
    document.getElementById('resultBox').style.display = 'block';
    switchTab('url');
  }).catch(function(e) { showToast('Error: ' + e.message); });
}

function copyUrl() {
  var text = document.getElementById('resultUrl').textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() { showToast('URL copied!'); });
  } else {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    document.body.removeChild(ta); showToast('URL copied!');
  }
}

// --- Init from config ---
(function() {
  // Wire up dropdown
  document.getElementById('addProviderSelect').addEventListener('change', function() {
    if (this.value) addProvider(this.value);
  });

  if (!window.__CONFIG__) return;
  var c = window.__CONFIG__;
  var urlMap = { jackett:'jackettUrl', prowlarr:'prowlarrUrl', torrentio:'torrentioUrl', comet:'cometUrl', peerflix:'peerflixUrl', jacred:'jacredUrl', mediafusion:'mediafusionUrl', magnetz:'magnetzUrl', bitmagnet:'bitmagnetUrl', torznab:'torznabUrl' };
  var keyMap = { jackett:'jackettApiKey', prowlarr:'prowlarrApiKey', jacred:'jacredApiKey', torznab:'torznabApiKey' };
  var prioMap = { jackett:'jackettPriority', prowlarr:'prowlarrPriority', torrentio:'torrentioPriority', comet:'cometPriority', peerflix:'peerflixPriority', jacred:'jacredPriority', mediafusion:'mediafusionPriority', magnetz:'magnetzPriority', bitmagnet:'bitmagnetPriority', torznab:'torznabPriority' };

  var types = ['jackett','prowlarr','torrentio','comet','peerflix','jacred','mediafusion','magnetz','bitmagnet','torznab'];
  types.forEach(function(type) {
    var url = c[urlMap[type]];
    if (url) {
      var def = PROVIDER_DEFS[type];
      addedProviders.push({
        type: type,
        url: url,
        apiKey: c[keyMap[type]] || '',
        priority: c[prioMap[type]] || def.defaultPriority || 3,
        enabled: true,
      });
    }
  });

  // Pre-fill TorrServer fields
  if (c.torrServerUrl) document.getElementById('torrServerUrl').value = c.torrServerUrl;
  if (c.torrServerUser) document.getElementById('torrServerUser').value = c.torrServerUser;
  if (c.torrServerPassword) document.getElementById('torrServerPassword').value = c.torrServerPassword;
  if (c.torrServerType) document.getElementById('torrServerType').value = c.torrServerType;
  if (c.saveToDb) document.getElementById('saveToDb').checked = true;
  if (c.maxResults) document.getElementById('maxResults').value = c.maxResults;

  renderProviders();
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
    bitmagnetUrl: q.bitmagnetUrl || '',
    torznabUrl: q.torznabUrl || '',
    torznabApiKey: q.torznabApiKey || '',
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
    bitmagnetUrl: body.bitmagnetEnabled ? (body.bitmagnetUrl || '') : '',
    bitmagnetPriority: parseInt(body.bitmagnetPriority) || 3,
    torznabUrl: body.torznabEnabled ? (body.torznabUrl || '') : '',
    torznabApiKey: body.torznabEnabled ? (body.torznabApiKey || '') : '',
    torznabPriority: parseInt(body.torznabPriority) || 3,
    torrServerUrl: body.torrServerUrl || '',
    torrServerUser: body.torrServerUser || '',
    torrServerPassword: body.torrServerPassword || '',
    torrServerType: body.torrServerType || 'official',
    saveToDb: !!body.saveToDb,
    providerOrder: Array.isArray(body.providerOrder) ? body.providerOrder : undefined,
    jackettPriority: parseInt(body.jackettPriority) || 3,
    prowlarrPriority: parseInt(body.prowlarrPriority) || 3,
    torrentioPriority: parseInt(body.torrentioPriority) || 3,
    cometPriority: parseInt(body.cometPriority) || 3,
    peerflixPriority: parseInt(body.peerflixPriority) || 3,
    jacredPriority: parseInt(body.jacredPriority) || 3,
    mediafusionPriority: parseInt(body.mediafusionPriority) || 3,
    magnetzPriority: parseInt(body.magnetzPriority) || 3,
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

app.get('/api/test/bitmagnet', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) { res.json({ ok: false, message: 'Missing URL' }); return; }
    const r = await fetch(`${url.replace(/\/+$/, '')}/torznab/api?t=search&q=tt0133093&extended=1`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const parsed = torznabParser.parse(await r.text());
    const items = parseTorznabItems(parsed?.rss?.channel?.item, 'bitmagnet');
    res.json({ ok: true, message: `✅ bitmagnet OK — ${items.length} results for The Matrix` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

app.get('/api/test/torznab', async (req, res) => {
  try {
    const { url, key } = req.query;
    if (!url) { res.json({ ok: false, message: 'Missing URL' }); return; }
    const base = url.replace(/\/+$/, '');
    const params = new URLSearchParams({ t: 'search', cat: '', q: 'tt0133093', extended: '1' });
    if (key) params.set('apikey', key);
    const r = await fetch(`${base}?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) { res.json({ ok: false, message: `HTTP ${r.status}` }); return; }
    const parsed = torznabParser.parse(await r.text());
    const items = parseTorznabItems(parsed?.rss?.channel?.item, 'Torznab');
    res.json({ ok: true, message: `✅ Torznab OK — ${items.length} results for The Matrix` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---- Torrentio-style routes (no UUID, just config) ----
app.get('/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  const hasConfig = !!(config.jackettUrl || config.prowlarrUrl || config.torrentioUrl || config.cometUrl || config.peerflixUrl || config.jacredUrl || config.mediafusionUrl || config.magnetzUrl || config.bitmagnetUrl || config.torznabUrl);
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
  const hasConfig = !!(config.jackettUrl || config.prowlarrUrl || config.torrentioUrl || config.cometUrl || config.peerflixUrl || config.jacredUrl || config.mediafusionUrl || config.magnetzUrl || config.bitmagnetUrl || config.torznabUrl);
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
  console.log(`  Providers: Jackett / Prowlarr / Torrentio / Comet / Jacred / MediaFusion / bitmagnet / Torznab`);
  console.log('='.repeat(50));
});
