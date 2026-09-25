// Geographic helpers: Web Mercator (EPSG:3857) projection and tile maths.

export const EARTH_RADIUS = 6378137; // metres, WGS84 / Web Mercator sphere
export const WORLD_SIZE = 2 * Math.PI * EARTH_RADIUS; // Mercator world width in metres
export const TILE_SIZE = 256;

const D2R = Math.PI / 180;

/** Longitude/latitude in degrees -> Web Mercator metres. */
export function lonLatToMerc(lon, lat) {
  return {
    x: EARTH_RADIUS * lon * D2R,
    y: EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)),
  };
}

/** Web Mercator metres -> fractional tile coordinates at zoom z. */
export function mercToTile(x, y, z) {
  const n = 2 ** z;
  return {
    tx: ((x + WORLD_SIZE / 2) / WORLD_SIZE) * n,
    ty: ((WORLD_SIZE / 2 - y) / WORLD_SIZE) * n,
  };
}

/** Width of a Mercator distance in pixels at zoom z. */
export function mercToPixels(d, z) {
  return (d / WORLD_SIZE) * 2 ** z * TILE_SIZE;
}

/** Great-circle distance between two {lat, lon} points in metres. */
export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Local ground frame centred on a Mercator point.
 *
 * Web Mercator stretches distances by 1/cos(latitude); multiplying by
 * cos(lat0) turns Mercator metres back into (approximately) true ground
 * metres, so horizontal and vertical units in the scene match.
 * Scene axes: +x east, +y up, -z north.
 */
export class LocalFrame {
  constructor(centerX, centerY, centerLat) {
    this.cx = centerX;
    this.cy = centerY;
    this.scale = Math.cos(centerLat * D2R);
  }

  toLocal(mx, my) {
    return { x: (mx - this.cx) * this.scale, z: -(my - this.cy) * this.scale };
  }

  toMerc(x, z) {
    return { x: this.cx + x / this.scale, y: this.cy - z / this.scale };
  }
}
