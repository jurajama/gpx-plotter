// Downloading and stitching raster map tiles and Terrarium elevation tiles.

import { TILE_SIZE, mercToTile } from './geo.js';

export const MAP_SOURCES = {
  OpenStreetMap: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 17,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  OpenTopoMap: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxZoom: 17,
    attribution:
      'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | ' +
      'Style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  },
  'Esri World Imagery': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 18,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
};

// Terrarium-encoded elevation: height = R * 256 + G + B / 256 - 32768.
export const DEM_SOURCE = {
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  maxZoom: 15,
  attribution:
    'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen Terrain Tiles</a>',
};

const CONCURRENCY = 6;

function tileUrl(src, z, x, y) {
  let url = src.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  if (src.subdomains) {
    url = url.replace('{s}', src.subdomains[(x + y) % src.subdomains.length]);
  }
  return url;
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Integer tile range covering a Mercator bbox at zoom z. */
function tileRange(bbox, z) {
  const tl = mercToTile(bbox.minX, bbox.maxY, z);
  const br = mercToTile(bbox.maxX, bbox.minY, z);
  return {
    x0: Math.floor(tl.tx),
    y0: Math.floor(tl.ty),
    x1: Math.floor(br.tx),
    y1: Math.floor(br.ty),
    tl,
    br,
  };
}

/**
 * Download all tiles covering bbox and draw them, pixel-aligned, into one canvas.
 * Returns { canvas, range, failed }.
 */
async function mosaic(src, z, bbox, onProgress) {
  const range = tileRange(bbox, z);
  const cols = range.x1 - range.x0 + 1;
  const rows = range.y1 - range.y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE_SIZE;
  canvas.height = rows * TILE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;

  const jobs = [];
  for (let y = range.y0; y <= range.y1; y++) {
    for (let x = range.x0; x <= range.x1; x++) jobs.push({ x, y });
  }

  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (jobs.length) {
      const { x, y } = jobs.shift();
      const img = await loadImage(tileUrl(src, z, x, y));
      if (img) {
        ctx.drawImage(img, (x - range.x0) * TILE_SIZE, (y - range.y0) * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      } else {
        failed++;
      }
      done++;
      onProgress?.(done, cols * rows);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { canvas, ctx, range, failed };
}

/** Render a map source into a canvas covering exactly the Mercator bbox. */
export async function renderMap(src, z, bbox, onProgress) {
  const { canvas: full, range, failed } = await mosaic(src, z, bbox, onProgress);
  const sx = (range.tl.tx - range.x0) * TILE_SIZE;
  const sy = (range.tl.ty - range.y0) * TILE_SIZE;
  const sw = (range.br.tx - range.tl.tx) * TILE_SIZE;
  const sh = (range.br.ty - range.tl.ty) * TILE_SIZE;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ccc';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(full, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return { canvas, failed };
}

/**
 * Load Terrarium elevation covering bbox. Returns a sampler object with
 * heightAt(mercX, mercY) using bilinear interpolation.
 */
export async function loadElevation(z, bbox, onProgress) {
  const { canvas, ctx, range, failed } = await mosaic(DEM_SOURCE, z, bbox, onProgress);
  const w = canvas.width;
  const h = canvas.height;
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const heights = new Float32Array(w * h);

  let sum = 0;
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3];
    if (a === 0) {
      heights[i] = NaN; // tile missing
      continue;
    }
    const v = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
    heights[i] = v;
    sum += v;
    count++;
  }
  if (!count) throw new Error('Could not load any elevation tiles');
  const mean = sum / count;
  for (let i = 0; i < heights.length; i++) if (Number.isNaN(heights[i])) heights[i] = mean;

  const at = (px, py) => {
    px = Math.min(w - 1, Math.max(0, px));
    py = Math.min(h - 1, Math.max(0, py));
    return heights[py * w + px];
  };

  return {
    failed,
    heightAt(mx, my) {
      const t = mercToTile(mx, my, z);
      // Pixel centres sit at +0.5.
      const fx = (t.tx - range.x0) * TILE_SIZE - 0.5;
      const fy = (t.ty - range.y0) * TILE_SIZE - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const dx = fx - x0;
      const dy = fy - y0;
      const top = at(x0, y0) * (1 - dx) + at(x0 + 1, y0) * dx;
      const bottom = at(x0, y0 + 1) * (1 - dx) + at(x0 + 1, y0 + 1) * dx;
      return top * (1 - dy) + bottom * dy;
    },
  };
}
