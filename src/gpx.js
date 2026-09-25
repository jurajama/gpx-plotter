// GPX parsing and per-point statistics.

import { haversine } from './geo.js';

function childText(el, name) {
  const c = el.getElementsByTagNameNS('*', name)[0];
  return c ? c.textContent.trim() : null;
}

function parsePoint(el) {
  const ele = childText(el, 'ele');
  const time = childText(el, 'time');
  return {
    lat: parseFloat(el.getAttribute('lat')),
    lon: parseFloat(el.getAttribute('lon')),
    ele: ele !== null && ele !== '' ? parseFloat(ele) : null,
    time: time ? Date.parse(time) : null,
  };
}

/**
 * Parse GPX text into { name, segments: [[point, ...], ...] }.
 * Track segments and routes are both returned as segments.
 */
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('File is not valid XML');
  }

  const segments = [];
  for (const seg of doc.getElementsByTagNameNS('*', 'trkseg')) {
    segments.push([...seg.getElementsByTagNameNS('*', 'trkpt')].map(parsePoint));
  }
  for (const rte of doc.getElementsByTagNameNS('*', 'rte')) {
    segments.push([...rte.getElementsByTagNameNS('*', 'rtept')].map(parsePoint));
  }

  const valid = segments
    .map((s) => s.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)))
    .filter((s) => s.length >= 2);
  if (!valid.length) throw new Error('No track or route points found in GPX file');

  const trk = doc.getElementsByTagNameNS('*', 'trk')[0];
  const metadata = doc.getElementsByTagNameNS('*', 'metadata')[0];
  const name =
    (trk && childText(trk, 'name')) || (metadata && childText(metadata, 'name')) || 'GPX track';

  annotate(valid);
  return { name, segments: valid, stats: computeStats(valid) };
}

/** Add cumulative distance (m), elapsed time (s) and smoothed speed (km/h) to each point. */
function annotate(segments) {
  const t0 = segments[0][0].time;
  let dist = 0;
  for (const seg of segments) {
    for (let i = 0; i < seg.length; i++) {
      const p = seg[i];
      if (i > 0) dist += haversine(seg[i - 1], p);
      p.dist = dist;
      p.elapsed = p.time !== null && t0 !== null ? (p.time - t0) / 1000 : null;
    }
    annotateSpeed(seg);
  }
}

// Speed over a ±SPEED_WINDOW second window to smooth GPS jitter.
const SPEED_WINDOW = 10;

function annotateSpeed(seg) {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < seg.length; i++) {
    const p = seg[i];
    if (p.time === null) {
      p.speed = null;
      continue;
    }
    while (lo < i && seg[lo].time !== null && p.time - seg[lo].time > SPEED_WINDOW * 1000) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < seg.length && seg[hi + 1].time !== null && seg[hi + 1].time - p.time <= SPEED_WINDOW * 1000) hi++;
    const dt = (seg[hi].time - seg[lo].time) / 1000;
    p.speed = dt > 0 ? ((seg[hi].dist - seg[lo].dist) / dt) * 3.6 : 0;
  }
}

function computeStats(segments) {
  const all = segments.flat();
  const first = all[0];
  const last = all[all.length - 1];
  const duration = first.time !== null && last.time !== null ? (last.time - first.time) / 1000 : null;

  // Ascent from recorded elevation, with a small hysteresis to ignore noise.
  let ascent = 0;
  let hasEle = false;
  for (const seg of segments) {
    let ref = null;
    for (const p of seg) {
      if (p.ele === null) continue;
      hasEle = true;
      if (ref === null) ref = p.ele;
      else if (p.ele - ref >= 2) {
        ascent += p.ele - ref;
        ref = p.ele;
      } else if (p.ele < ref) ref = p.ele;
    }
  }

  return {
    distance: last.dist,
    duration,
    startTime: first.time,
    ascent: hasEle ? ascent : null,
    points: all.length,
  };
}
