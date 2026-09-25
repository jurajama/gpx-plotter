// Route line (fat line with per-vertex colours) and start/finish markers.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { lonLatToMerc } from './geo.js';

// Colour stops from low to high value; also used for the CSS legend.
const DEFAULT_GRADIENT = ['#2b50d8', '#1fc0d8', '#3ccf4e', '#f2d21b', '#e3262b'];
// Speed: red = slow, blue = medium, green = fast.
const SPEED_GRADIENT = ['#d61f1f', '#8a3fc0', '#2a62e0', '#139fb0', '#12a82e'];

function gradientColor(stops, t, out) {
  t = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  return out.set(stops[i]).lerp(new THREE.Color(stops[i + 1]), t - i);
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

// Height of the line above the terrain surface, in scene metres.
const LIFT = 1.5;

export const COLOR_MODES = ['Solid', 'Speed', 'Elapsed time', 'Elevation'];

export class Track {
  constructor(gpx, frame, elevation, sceneSize) {
    this.gpx = gpx;
    this.group = new THREE.Group();

    // Horizontal position and terrain height for every point, computed once.
    for (const seg of gpx.segments) {
      for (const p of seg) {
        const m = lonLatToMerc(p.lon, p.lat);
        const l = frame.toLocal(m.x, m.y);
        p.x = l.x;
        p.z = l.z;
        p.ground = elevation.heightAt(m.x, m.y);
      }
    }
    // Recorded (GPS/barometric) altitude is often offset from the terrain
    // model; shift it by the median difference so it sits near the surface.
    const all = gpx.segments.flat();
    this.gpsOffset = median(all.filter((p) => p.ele !== null).map((p) => p.ground - p.ele));

    this.material = new LineMaterial({ linewidth: 4, vertexColors: true, worldUnits: false });
    this.lines = gpx.segments.map(() => {
      const line = new Line2(new LineGeometry(), this.material);
      this.group.add(line);
      return line;
    });

    const r = sceneSize * 0.006;
    this.startMarker = new THREE.Mesh(
      new THREE.ConeGeometry(r * 1.4, r * 2.5, 3),
      new THREE.MeshStandardMaterial({ color: '#b0158c' })
    );
    this.finishMarker = new THREE.Mesh(
      new THREE.TorusGeometry(r, r * 0.3, 12, 32),
      new THREE.MeshStandardMaterial({ color: '#b0158c' })
    );
    this.markerSize = r;
    this.group.add(this.startMarker, this.finishMarker);
  }

  /**
   * Rebuild line geometry.
   * @param opts { terrain, exaggeration, heightMode: 'Terrain'|'Recorded altitude',
   *               colorMode, solidColor, lineWidth, onTop }
   * @returns legend { min, max, unit, gradient } or null for solid colour
   */
  update(opts) {
    const { terrain, exaggeration } = opts;
    const useGps = opts.heightMode === 'Recorded altitude';
    const yOf = (p) => {
      const h = useGps && p.ele !== null ? p.ele + this.gpsOffset : p.ground;
      return terrain.sceneY(h, exaggeration) + LIFT;
    };

    const value = {
      Speed: (p) => p.speed,
      'Elapsed time': (p) => (p.elapsed !== null ? p.elapsed / 60 : null),
      Elevation: (p) => (p.ele !== null ? p.ele : p.ground),
    }[opts.colorMode];

    let legend = null;
    let min = 0;
    let max = 1;
    if (value) {
      const vals = this.gpx.segments.flat().map(value).filter((v) => v !== null && Number.isFinite(v));
      vals.sort((a, b) => a - b);
      if (vals.length) {
        // Clip speed outliers (GPS spikes, standing still at controls).
        const clip = opts.colorMode === 'Speed' ? 0.05 : 0;
        min = percentile(vals, clip);
        max = percentile(vals, 1 - clip);
        if (max - min < 1e-6) max = min + 1;
        const unit = { Speed: 'km/h', 'Elapsed time': 'min', Elevation: 'm' }[opts.colorMode];
        const gradient = opts.colorMode === 'Speed' ? SPEED_GRADIENT : DEFAULT_GRADIENT;
        legend = { min, max, unit, gradient };
      }
    }

    const solid = new THREE.Color(opts.solidColor);
    const c = new THREE.Color();
    this.gpx.segments.forEach((seg, si) => {
      const positions = [];
      const colors = [];
      for (const p of seg) {
        positions.push(p.x, yOf(p), p.z);
        const v = value ? value(p) : null;
        if (legend && v !== null && Number.isFinite(v)) gradientColor(legend.gradient, (v - min) / (max - min), c);
        else c.copy(solid);
        colors.push(c.r, c.g, c.b);
      }
      const old = this.lines[si].geometry;
      const geom = new LineGeometry();
      geom.setPositions(positions);
      geom.setColors(colors);
      this.lines[si].geometry = geom;
      this.lines[si].computeLineDistances();
      old.dispose();
    });

    this.material.linewidth = opts.lineWidth;
    this.material.depthTest = !opts.onTop;
    for (const line of this.lines) line.renderOrder = opts.onTop ? 10 : 0;

    const first = this.gpx.segments[0][0];
    const lastSeg = this.gpx.segments[this.gpx.segments.length - 1];
    const last = lastSeg[lastSeg.length - 1];
    const r = this.markerSize;
    this.startMarker.position.set(first.x, yOf(first) + r * 1.25, first.z);
    this.finishMarker.position.set(last.x, yOf(last) + r * 1.3, last.z);

    return legend;
  }

  setResolution(w, h) {
    this.material.resolution.set(w, h);
  }

  dispose() {
    for (const line of this.lines) line.geometry.dispose();
    this.material.dispose();
    for (const m of [this.startMarker, this.finishMarker]) {
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}
