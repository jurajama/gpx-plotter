// Application entry: scene setup, GPX loading, UI.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { LocalFrame, lonLatToMerc, mercToPixels } from './geo.js';
import { parseGpx } from './gpx.js';
import { MAP_SOURCES, DEM_SOURCE, renderMap, loadElevation } from './tiles.js';
import { Terrain } from './terrain.js';
import { Track, COLOR_MODES } from './track.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const statusEl = $('status');
const infoEl = $('info');
const legendEl = $('legend');
const attributionEl = $('attribution');
const compassEl = $('compass');
const dropEl = $('drop');

// ---------- Three.js scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#dde6ee');

const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
camera.position.set(0, 1500, 1500);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.02; // stay above the horizon
controls.screenSpacePanning = false; // pan along the ground plane

scene.add(new THREE.HemisphereLight('#ffffff', '#8a8a80', 2.2));
const sun = new THREE.DirectionalLight('#ffffff', 1.4);
sun.position.set(-1, 1.2, -1); // from the north-west, like a classic hillshade
scene.add(sun);

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  current?.track.setResolution(w, h);
}
window.addEventListener('resize', resize);

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (playback.playing) advancePlayback(dt);
  controls.update();
  compassEl.style.transform = `rotate(${controls.getAzimuthalAngle()}rad)`;
  renderer.render(scene, camera);
});

// ---------- State & GUI ----------
const settings = {
  mapSource: 'OpenTopoMap',
  mapZoom: 16,
  exaggeration: 3,
  heightMode: 'Terrain',
  colorMode: 'Speed',
  solidColor: '#e3262b',
  lineWidth: 4,
  onTop: false,
  shaded: true,
  wireframe: false,
  openFile: () => $('file').click(),
  resetView: () => fitCamera(),
  screenshot: () => saveScreenshot(),
};

const gui = new GUI({ title: 'Settings' });
gui.add(settings, 'openFile').name('Open GPX file…');
const mapFolder = gui.addFolder('Map');
mapFolder.add(settings, 'mapSource', Object.keys(MAP_SOURCES)).name('Source').onChange(() => {
  settings.mapZoom = autoZoom();
  zoomCtrl.updateDisplay();
  applyMap();
});
const zoomCtrl = mapFolder.add(settings, 'mapZoom', 10, 18, 1).name('Zoom level').onFinishChange(() => applyMap());
mapFolder.add(settings, 'exaggeration', 1, 10, 0.1).name('Vertical exaggeration').onChange(() => applyExaggeration());
mapFolder.add(settings, 'shaded').name('Hill shading').onChange((v) => current?.terrain.setShaded(v));
mapFolder.add(settings, 'wireframe').name('Wireframe').onChange((v) => current?.terrain.setWireframe(v));
const routeFolder = gui.addFolder('Route');
// Colouring modes that need timestamps; hidden for GPX files without them.
const TIME_COLOR_MODES = ['Speed', 'Elapsed time'];
let preferredColorMode = settings.colorMode; // last mode the user picked
const colorModeCtrl = routeFolder.add(settings, 'colorMode', COLOR_MODES).name('Colour by').onChange((v) => {
  preferredColorMode = v;
  updateTrack();
});
routeFolder.addColor(settings, 'solidColor').name('Solid colour').onChange(() => updateTrack());
routeFolder.add(settings, 'lineWidth', 1, 12, 0.5).name('Line width (px)').onChange(() => updateTrack());
routeFolder.add(settings, 'heightMode', ['Terrain', 'Recorded altitude']).name('Height from').onChange(() => updateTrack());
routeFolder.add(settings, 'onTop').name('Always visible').onChange(() => updateTrack());
const viewFolder = gui.addFolder('View');
viewFolder.add(settings, 'resetView').name('Reset view');
viewFolder.add(settings, 'screenshot').name('Save screenshot');

compassEl.addEventListener('click', () => fitCamera());

// ---------- Loading ----------
let current = null; // { gpx, frame, bbox, elevation, terrain, track, size }
let loadId = 0;

function setStatus(text) {
  statusEl.textContent = text || '';
  statusEl.hidden = !text;
}

// Largest map texture edge we are willing to build.
function maxTexturePx() {
  return Math.min(renderer.capabilities.maxTextureSize, 8192);
}

function autoZoom(bbox = current?.bbox) {
  if (!bbox) return settings.mapZoom;
  const src = MAP_SOURCES[settings.mapSource];
  const span = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  let z = src.maxZoom;
  while (z > 1 && mercToPixels(span, z) > Math.min(maxTexturePx(), 4096)) z--;
  return z;
}

async function loadGpxText(text, filename) {
  const id = ++loadId;
  let gpx;
  try {
    gpx = parseGpx(text);
  } catch (e) {
    setStatus(`Could not read ${filename}: ${e.message}`);
    return;
  }

  // Bounding box in Mercator metres, padded so the route has surroundings.
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let latSum = 0;
  let n = 0;
  for (const p of gpx.segments.flat()) {
    const m = lonLatToMerc(p.lon, p.lat);
    bbox.minX = Math.min(bbox.minX, m.x);
    bbox.maxX = Math.max(bbox.maxX, m.x);
    bbox.minY = Math.min(bbox.minY, m.y);
    bbox.maxY = Math.max(bbox.maxY, m.y);
    latSum += p.lat;
    n++;
  }
  const centerLat = latSum / n;
  const mercPerMetre = 1 / Math.cos((centerLat * Math.PI) / 180);
  const pad = Math.max(0.15 * Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY), 200 * mercPerMetre);
  bbox.minX -= pad;
  bbox.maxX += pad;
  bbox.minY -= pad;
  bbox.maxY += pad;
  const frame = new LocalFrame((bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2, centerLat);

  const next = { gpx, frame, bbox };
  const mapZoom = autoZoom(bbox);

  try {
    const demZoom = Math.min(DEM_SOURCE.maxZoom, mapZoom);
    next.elevation = await loadElevation(demZoom, bbox, (d, t) => setStatus(`Loading elevation ${d}/${t}…`));
    if (id !== loadId) return;

    const groundWidth = (bbox.maxX - bbox.minX) / mercPerMetre;
    next.terrain = new Terrain(frame, bbox, next.elevation, Math.max(3, groundWidth / 500));
    next.size = Math.max(next.terrain.width, next.terrain.depth);
    next.track = new Track(gpx, frame, next.elevation, next.size);
  } catch (e) {
    if (id === loadId) setStatus(`Loading failed: ${e.message}`);
    return;
  }
  if (id !== loadId) return;

  const previous = current;
  current = next;
  settings.mapZoom = mapZoom;
  zoomCtrl.updateDisplay();
  if (previous) {
    scene.remove(previous.terrain.mesh, previous.track.group);
    previous.terrain.dispose();
    previous.track.dispose();
  }
  next.terrain.setShaded(settings.shaded);
  next.terrain.setWireframe(settings.wireframe);
  next.terrain.setExaggeration(settings.exaggeration);
  scene.add(next.terrain.mesh, next.track.group);
  camera.far = next.size * 20;
  resize();
  setColorModes(next.track.hasTime);
  updateTrack();
  fitCamera();
  showInfo(gpx, filename);
  resetTimeline();
  dropEl.hidden = true;
  if (!next.track.hasTime) showNoTimeNotice(filename);

  await applyMap();
}

async function applyMap() {
  if (!current) return;
  const target = current;
  const src = MAP_SOURCES[settings.mapSource];
  let z = Math.min(settings.mapZoom, src.maxZoom);
  const span = Math.max(target.bbox.maxX - target.bbox.minX, target.bbox.maxY - target.bbox.minY);
  while (mercToPixels(span, z) > maxTexturePx()) z--;
  if (z !== settings.mapZoom) {
    settings.mapZoom = z;
    zoomCtrl.updateDisplay();
  }

  const { canvas, failed } = await renderMap(src, z, target.bbox, (d, t) =>
    setStatus(`Loading ${settings.mapSource} tiles ${d}/${t}…`)
  );
  if (current !== target) return;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  target.terrain.setTexture(texture);
  attributionEl.innerHTML = `${src.attribution} | ${DEM_SOURCE.attribution}`;
  setStatus(failed ? `${failed} map tile(s) failed to load` : '');
}

function applyExaggeration() {
  if (!current) return;
  current.terrain.setExaggeration(settings.exaggeration);
  updateTrack();
}

function updateTrack() {
  if (!current) return;
  const legend = current.track.update({ terrain: current.terrain, ...settings });
  showLegend(legend);
  if (current.track.hasTime) setTime(playback.t); // keep the marker on the redrawn line
}

function fitCamera() {
  if (!current) return;
  const { terrain, size } = current;
  const midY = terrain.sceneY((terrain.minHeight + terrain.maxHeight) / 2, settings.exaggeration);
  controls.target.set(0, midY, 0);
  // View from the south, looking north, tilted about 50 degrees.
  const dist = size * 0.95;
  camera.position.set(0, midY + dist * 0.75, dist * 0.65);
  controls.update();
}

// ---------- Info panels ----------
// Clock times are always shown in 24-hour format, whatever the browser locale.
const TIME_FORMAT = { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
const DATE_TIME_FORMAT = { year: 'numeric', month: 'numeric', day: 'numeric', ...TIME_FORMAT };

function formatDuration(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function showInfo(gpx, filename) {
  const s = gpx.stats;
  const rows = [['Distance', `${(s.distance / 1000).toFixed(2)} km`]];
  if (s.startTime !== null) rows.push(['Start', new Date(s.startTime).toLocaleString(undefined, DATE_TIME_FORMAT)]);
  if (s.duration !== null) {
    rows.push(['Duration', formatDuration(s.duration)]);
    if (s.distance > 0) {
      const pace = s.duration / (s.distance / 1000);
      rows.push(['Pace', `${formatDuration(pace).replace(/^0:/, '')} /km`]);
      rows.push(['Avg speed', `${((s.distance / s.duration) * 3.6).toFixed(1)} km/h`]);
    }
  }
  if (s.ascent !== null) rows.push(['Ascent', `${Math.round(s.ascent)} m`]);
  rows.push(['Points', s.points]);
  infoEl.innerHTML =
    `<h1 title="${escapeHtml(filename)}">${escapeHtml(gpx.name)}</h1>` +
    `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(String(v))}</td></tr>`).join('')}</table>`;
  infoEl.hidden = false;
}

function showLegend(legend) {
  if (!legend) {
    legendEl.hidden = true;
    return;
  }
  const digits = legend.max - legend.min < 10 ? 1 : 0;
  legendEl.innerHTML =
    `<div class="legend-title">${settings.colorMode} (${legend.unit})</div>` +
    `<div class="legend-bar" style="background:linear-gradient(to right, ${legend.gradient.join(',')})"></div>` +
    `<div class="legend-labels"><span>${legend.min.toFixed(digits)}</span><span>${legend.max.toFixed(digits)}</span></div>`;
  legendEl.hidden = false;
}

function saveScreenshot() {
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = `${current?.gpx.name || 'gpx-plotter'}.png`;
  a.click();
}

/** Offer only the colouring modes the loaded file has data for. */
function setColorModes(hasTime) {
  const modes = hasTime ? COLOR_MODES : COLOR_MODES.filter((m) => !TIME_COLOR_MODES.includes(m));
  colorModeCtrl.options(modes);
  settings.colorMode = modes.includes(preferredColorMode) ? preferredColorMode : 'Elevation';
  colorModeCtrl.updateDisplay();
}

function showNoTimeNotice(filename) {
  $('notice-file').textContent = filename;
  $('notice').showModal();
}

// ---------- Timeline / playback ----------
const timelineEl = $('timeline');
const playButton = $('play');
const stopButton = $('stop');
const timeSlider = $('time-slider');
const speedSelect = $('play-speed');
const playback = { t: 0, playing: false };

/** Move the marker to `t` seconds from the start and refresh the readout. */
function setTime(t) {
  const track = current?.track;
  if (!track?.hasTime) return;
  playback.t = Math.min(track.duration, Math.max(0, t));
  const s = track.setPosition(playback.t);
  timeSlider.value = playback.t;
  $('time-abs').textContent = new Date(s.time).toLocaleTimeString(undefined, TIME_FORMAT);
  $('time-rel').textContent = formatDuration(s.elapsed);
  $('time-dist').textContent = `${(s.dist / 1000).toFixed(2)} km`;
  $('time-speed').textContent = s.speed !== null ? `${s.speed.toFixed(1)} km/h` : '–';
}

function setPlaying(on) {
  playback.playing = on;
  playButton.disabled = on;
  stopButton.disabled = !on;
}

function advancePlayback(dt) {
  const track = current?.track;
  if (!track?.hasTime) return setPlaying(false);
  setTime(playback.t + dt * Number(speedSelect.value));
  if (playback.t >= track.duration) setPlaying(false);
}

function play() {
  if (!current?.track.hasTime) return;
  if (playback.t >= current.track.duration) setTime(0); // replay from the start
  setPlaying(true);
}

/** Called after a new GPX file has been loaded. */
function resetTimeline() {
  setPlaying(false);
  const track = current.track;
  timelineEl.hidden = !track.hasTime;
  if (!track.hasTime) return;
  timeSlider.max = Math.ceil(track.duration);
  setTime(0);
}

playButton.addEventListener('click', (e) => {
  e.currentTarget.blur();
  play();
});
stopButton.addEventListener('click', (e) => {
  e.currentTarget.blur();
  setPlaying(false);
});
timeSlider.addEventListener('input', () => setTime(Number(timeSlider.value)));

// Space toggles play / stop (except while typing in a form field).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || timelineEl.hidden) return;
  if (e.target.closest?.('input:not([type=range]), select, textarea, button')) return;
  e.preventDefault();
  if (playback.playing) setPlaying(false);
  else play();
});

// ---------- File input ----------
async function openFile(file) {
  setStatus(`Reading ${file.name}…`);
  loadGpxText(await file.text(), file.name);
}

$('file').addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('open-button').addEventListener('click', () => $('file').click());

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) openFile(file);
});

resize();

// Optional: ?gpx=path/to/file.gpx loads a file served by the local web server.
const gpxParam = new URLSearchParams(location.search).get('gpx');
if (gpxParam) {
  setStatus(`Fetching ${gpxParam}…`);
  fetch(gpxParam)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .then((text) => loadGpxText(text, gpxParam))
    .catch((e) => setStatus(`Could not fetch ${gpxParam}: ${e.message}`));
}
