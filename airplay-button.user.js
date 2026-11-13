// ==UserScript==
// @name         AirPlay Button
// @namespace    https://github.com/thesanefew/airplay-button
// @version      1.1.0
// @description  Adds an AirPlay button to any video player in Safari, including embedded players that hide it, and sends the site's subtitles to the TV.
// @author       thesanefew
// @match        *://*/*
// @run-at       document-start
// @inject-into  content
// @grant        GM.xmlHttpRequest
// @homepageURL  https://github.com/thesanefew/airplay-button
// @updateURL    https://raw.githubusercontent.com/thesanefew/airplay-button/main/airplay-button.user.js
// @downloadURL  https://raw.githubusercontent.com/thesanefew/airplay-button/main/airplay-button.user.js
// ==/UserScript==

/*
 * Safari only (Chrome has no AirPlay API). Runs in every frame, so it also
 * reaches players embedded in iframes from other sites.
 *
 * Subtitles: AirPlay only shows subtitles listed inside the HLS playlist. Sites
 * load a separate .vtt/.srt and draw it themselves, so the TV never sees it.
 * This script builds a new HLS master playlist that includes the subtitle file
 * as a proper subtitle track, packs everything into data: URLs (no server), and
 * plays that instead when you press AirPlay.
 */
(() => {
  'use strict';
  if (window.__airplayButtonLoaded) return;
  window.__airplayButtonLoaded = true;

  if (typeof HTMLVideoElement === 'undefined' ||
      !('webkitShowPlaybackTargetPicker' in HTMLVideoElement.prototype)) return;

  const LOG = (...a) => console.log('[AirPlay Button]', ...a);
  const MIN_W = 200, MIN_H = 120, HIDE_AFTER_MS = 2500;
  const entries = new Map(); // video -> { host, btn, label, available, hideTimer }

  // ---------- 1. Undo the tricks players use to block AirPlay ----------
  function unlock(v) {
    try { v.disableRemotePlayback = false; } catch (_) {}
    if (v.hasAttribute('disableremoteplayback')) v.removeAttribute('disableremoteplayback');
    if (v.getAttribute('x-webkit-airplay') !== 'allow') v.setAttribute('x-webkit-airplay', 'allow');
  }

  // ---------- 2. Network helpers ----------
  // GM.xmlHttpRequest skips CORS, so we can read playlists/subtitles/segments.
  function get(url, binary) {
    const viaFetch = () => fetch(url, { credentials: 'omit' }).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      return binary ? r.arrayBuffer() : r.text();
    });
    if (typeof GM === 'undefined' || !GM.xmlHttpRequest) return viaFetch();
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest({
        url, method: 'GET', responseType: binary ? 'arraybuffer' : 'text',
        onload: r => {
          if (r.status < 200 || r.status >= 300) return reject(new Error('HTTP ' + r.status + ' ' + url));
          if (binary) return r.response instanceof ArrayBuffer ? resolve(r.response) : viaFetch().then(resolve, reject);
          resolve(r.responseText != null ? r.responseText : r.response);
        },
        onerror: () => viaFetch().then(resolve, reject),
      });
    });
  }

  function resources(re) {
    return performance.getEntriesByType('resource').map(e => e.name).filter(n => re.test(n));
  }

  const abs = (u, base) => new URL(u, base).href;

  function b64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const dataUrl = (type, text) => `data:${type};base64,${b64(text)}`;

  // ---------- 3. Find the stream + subtitle the page loaded ----------
  function findHlsUrl() {
    const names = resources(/\.m3u8(\?|#|$)/i);
    if (!names.length) return null;
    return names.find(n => /master|playlist|index/i.test(n)) || names[0];
  }

  // Most recently loaded subtitle = the language currently selected.
  function findSubUrl() {
    const names = resources(/\.(vtt|srt)(\?|#|$)/i);
    return names.length ? names[names.length - 1] : null;
  }

  // ---------- 4. Subtitle conversion ----------
  function toVtt(text) {
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (/^WEBVTT/.test(text)) return text;
    // SRT -> VTT
    return 'WEBVTT\n\n' + text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  }

  // Tell the TV how subtitle times line up with the video's internal clock.
  function addTimestampMap(vtt, pts) {
    if (/X-TIMESTAMP-MAP/.test(vtt)) return vtt;
    const nl = vtt.indexOf('\n');
    const head = nl === -1 ? vtt : vtt.slice(0, nl);
    const rest = nl === -1 ? '' : vtt.slice(nl);
    return `${head}\nX-TIMESTAMP-MAP=MPEGTS:${pts},LOCAL:00:00:00.000${rest}`;
  }

  // First presentation timestamp (90 kHz) of an MPEG-TS segment. Handles
  // segments disguised as images (junk bytes before the first TS packet).
  function firstPts(buf) {
    const b = new Uint8Array(buf);
    let start = -1;
    for (let i = 0; i + 376 < b.length && i < 4096; i++) {
      if (b[i] === 0x47 && b[i + 188] === 0x47 && b[i + 376] === 0x47) { start = i; break; }
    }
    if (start < 0) return null;
    let min = null;
    for (let i = start; i + 188 <= b.length; i += 188) {
      if (b[i] !== 0x47 || !(b[i + 1] & 0x40)) continue; // need payload_unit_start
      const afc = (b[i + 3] >> 4) & 3;
      let p = i + 4;
      if (afc & 2) p += 1 + b[i + 4];
      if (!(afc & 1) || p + 14 > i + 188) continue;
      if (b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) continue;
      const sid = b[p + 3];
      if (!((sid >= 0xC0 && sid <= 0xEF))) continue; // audio/video PES only
      if (!(b[p + 7] & 0x80)) continue; // no PTS
      const q = p + 9;
      const pts = ((b[q] >> 1) & 7) * 1073741824 +
        ((b[q + 1] << 22) | ((b[q + 2] >> 1) << 15) | (b[q + 3] << 7) | (b[q + 4] >> 1));
      if (min === null || pts < min) min = pts;
    }
    return min;
  }

  // ---------- 5. Build an HLS master playlist with a subtitle track ----------
  function absolutizePlaylist(text, base) {
    return text.split(/\r?\n/).map(line => {
      const t = line.trim();
      if (!t) return line;
      if (t[0] !== '#') return abs(t, base);
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u, base)}"`);
    }).join('\n');
  }

  function mediaInfo(text, base) {
    let duration = 0, firstSeg = null;
    const lines = text.split(/\r?\n/);
    for (const l of lines) {
      const m = /^#EXTINF:([\d.]+)/.exec(l);
      if (m) duration += parseFloat(m[1]);
      else if (!firstSeg && l.trim() && l.trim()[0] !== '#') firstSeg = abs(l.trim(), base);
    }
    return {
      duration,
      firstSeg,
      fmp4: /#EXT-X-MAP/.test(text),
      encrypted: /#EXT-X-KEY:METHOD=(?!NONE)/.test(text),
    };
  }

  async function buildPlaylist(hlsUrl, subUrl) {
    const top = await get(hlsUrl);
    let master, mediaUrl;

    if (/#EXT-X-STREAM-INF/.test(top)) {
      // Real master playlist: keep every quality, attach our subtitle group.
      const lines = absolutizePlaylist(top, hlsUrl).split('\n')
        .filter(l => !/^#EXT-X-MEDIA:.*TYPE=SUBTITLES/.test(l));
      master = lines.map(l => /^#EXT-X-STREAM-INF:/.test(l)
        ? l.replace(/,SUBTITLES="[^"]*"/, '') + ',SUBTITLES="apb"'
        : l).join('\n');
      const idx = lines.findIndex(l => /^#EXT-X-STREAM-INF:/.test(l));
      mediaUrl = lines.slice(idx + 1).find(l => l.trim() && l.trim()[0] !== '#');
    } else {
      // Only a media playlist: wrap it in a one-quality master.
      mediaUrl = hlsUrl;
      master = '#EXTM3U\n#EXT-X-VERSION:3\n' +
        `#EXT-X-STREAM-INF:BANDWIDTH=3000000,SUBTITLES="apb"\n${hlsUrl}\n`;
    }

    const mediaText = mediaUrl === hlsUrl ? top : await get(mediaUrl);
    const info = mediaInfo(mediaText, mediaUrl);

    let pts = 0;
    if (!info.fmp4 && !info.encrypted && info.firstSeg) {
      try { pts = firstPts(await get(info.firstSeg, true)) || 0; }
      catch (e) { LOG('could not read first segment, assuming timestamp 0', e); }
    }

    const vtt = addTimestampMap(toVtt(await get(subUrl)), pts);
    const dur = Math.max(1, Math.ceil(info.duration || 10800));
    const subPlaylist = '#EXTM3U\n#EXT-X-VERSION:3\n' +
      `#EXT-X-TARGETDURATION:${dur}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n` +
      `#EXTINF:${dur}.0,\n${dataUrl('text/vtt', vtt)}\n#EXT-X-ENDLIST\n`;

    const lang = (/[._/-](en|eng|english|es|spa|spanish|fr|de|it|pt)[._/-]/i.exec(subUrl) || [])[1] || 'en';
    const media = `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="apb",NAME="Subtitles",LANGUAGE="${lang.slice(0, 2).toLowerCase()}",` +
      `DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="${dataUrl('application/vnd.apple.mpegurl', subPlaylist)}"`;

    master = master.replace(/^#EXTM3U[^\n]*\n(#EXT-X-VERSION:[^\n]*\n)?/, m => m + media + '\n');
    LOG('built subtitle playlist', { hlsUrl, subUrl, pts, duration: info.duration });
    return dataUrl('application/vnd.apple.mpegurl', master);
  }

  // Build ahead of time: the AirPlay picker must open synchronously on click.
  let prepared = null; // { key, url }
  let building = null;
  function prepare() {
    const hls = findHlsUrl(), sub = findSubUrl();
    if (!hls || !sub) { if (!sub) prepared = null; return; }
    const key = hls + '|' + sub;
    if ((prepared && prepared.key === key) || building === key) return;
    building = key;
    buildPlaylist(hls, sub)
      .then(url => { if (building === key) prepared = { key, url }; refreshLabels(); })
      .catch(e => LOG('subtitle playlist failed', e))
      .finally(() => { if (building === key) building = null; });
  }

  // ---------- 6. Hand the video to AirPlay ----------
  function isMse(v) {
    return (v.currentSrc || v.src || '').startsWith('blob:') || (!v.currentSrc && !!v.srcObject);
  }

  function swapSource(v, url) {
    const t = v.currentTime, wasPaused = v.paused;
    v.src = url;
    v.addEventListener('loadedmetadata', () => {
      try { v.currentTime = t; } catch (_) {}
      if (!wasPaused) v.play().catch(() => {});
    }, { once: true });
  }

  function showPicker(v) {
    unlock(v);
    const usingOurs = prepared && v.src === prepared.url;
    if (prepared && !usingOurs) {
      LOG('AirPlay with subtitles');
      swapSource(v, prepared.url);
    } else if (!prepared && isMse(v)) {
      const hls = findHlsUrl();
      if (hls) swapSource(v, hls);
    }
    try { v.webkitShowPlaybackTargetPicker(); } catch (e) { LOG(e); }
  }

  // ---------- 7. Floating button ----------
  const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" ' +
    'd="M6 17H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2"/>' +
    '<path fill="currentColor" d="M12 13.5 17.5 20h-11z"/></svg>';

  function makeButton(v) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;' +
      'pointer-events:none;display:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      button{pointer-events:auto;display:flex;align-items:center;gap:6px;cursor:pointer;
        font:600 13px -apple-system,system-ui,sans-serif;color:#fff;
        background:rgba(20,20,20,.72);border:1px solid rgba(255,255,255,.25);
        border-radius:999px;padding:7px 12px;backdrop-filter:blur(8px);
        -webkit-backdrop-filter:blur(8px);opacity:0;transition:opacity .2s}
      button.on{opacity:1}
      button:hover{background:rgba(0,0,0,.88)}
    </style><button type="button" title="AirPlay this video">${ICON}<span>AirPlay</span></button>`;
    const btn = root.querySelector('button');
    const label = root.querySelector('span');
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'dblclick']) {
      btn.addEventListener(ev, e => e.stopPropagation());
    }
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); showPicker(v); });
    return { host, btn, label };
  }

  function refreshLabels() {
    entries.forEach(e => { e.label.textContent = prepared ? 'AirPlay + CC' : 'AirPlay'; });
  }

  function container() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.documentElement;
  }

  function track(v) {
    if (entries.has(v)) return;
    unlock(v);
    const entry = { ...makeButton(v), available: true, hideTimer: 0 };
    entries.set(v, entry);
    container().appendChild(entry.host);
    refreshLabels();

    v.addEventListener('webkitplaybacktargetavailabilitychanged', e => {
      entry.available = e.availability === 'available';
      position(v, entry);
    });
    new MutationObserver(() => unlock(v))
      .observe(v, { attributes: true, attributeFilter: ['disableremoteplayback', 'x-webkit-airplay'] });
    for (const ev of ['play', 'pause', 'loadedmetadata']) v.addEventListener(ev, () => flash(v));
  }

  function position(v, entry) {
    if (!v.isConnected) { entry.host.remove(); entries.delete(v); return; }
    const r = v.getBoundingClientRect();
    const visible = entry.available && r.width >= MIN_W && r.height >= MIN_H &&
      r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    entry.host.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    const top = Math.max(r.top, 0) + 12;
    const right = Math.min(r.right, innerWidth) - 12;
    entry.host.style.transform =
      `translate(${Math.round(right)}px, ${Math.round(top)}px) translateX(-100%)`;
    const c = container();
    if (entry.host.parentNode !== c) c.appendChild(entry.host);
  }

  function flash(v) {
    const entry = entries.get(v);
    if (!entry) return;
    position(v, entry);
    entry.btn.classList.add('on');
    clearTimeout(entry.hideTimer);
    entry.hideTimer = setTimeout(() => {
      if (!v.paused) entry.btn.classList.remove('on');
    }, HIDE_AFTER_MS);
  }

  document.addEventListener('mousemove', e => {
    for (const v of entries.keys()) {
      const r = v.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom) flash(v);
    }
  }, { capture: true, passive: true });

  // ---------- 8. Find videos, including ones added later ----------
  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.tagName === 'VIDEO') track(node);
    else if (node.querySelectorAll) node.querySelectorAll('video').forEach(track);
  }

  new MutationObserver(muts => {
    for (const m of muts) m.addedNodes.forEach(scan);
  }).observe(document, { childList: true, subtree: true });

  if (document.documentElement) scan(document.documentElement);
  document.addEventListener('DOMContentLoaded', () => scan(document.documentElement));

  const reposition = () => entries.forEach((entry, v) => position(v, entry));
  addEventListener('scroll', reposition, { capture: true, passive: true });
  addEventListener('resize', reposition, { passive: true });
  document.addEventListener('fullscreenchange', reposition);
  document.addEventListener('webkitfullscreenchange', reposition);
  setInterval(() => { reposition(); if (entries.size) prepare(); }, 2000);
})();
