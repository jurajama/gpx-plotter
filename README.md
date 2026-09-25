# GPX Plotter 3D

View a GPX exercise route draped over a 3D map in the browser. Rotate, tilt and
zoom the terrain with the mouse. Runs locally; only map and elevation tiles are
downloaded from the internet. No build step and no API keys.

## Run

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000> and drop a `.gpx` file on the page (or use
*Open GPX file…*). A local web server is needed because browsers do not load
JavaScript modules from `file://` pages.

A GPX file inside this folder can also be opened directly:
<http://localhost:8000/?gpx=my-run.gpx>

## Controls

- Left drag: rotate / tilt
- Right drag: pan
- Scroll: zoom
- Compass (bottom right): shows north; click to reset the view

Timeline (bottom): drag the slider to move the position marker along the route
in time. The readout shows the clock time, time elapsed since the start,
distance and speed at that moment. *Play* / *Stop* (or the space bar) run the
marker automatically; *Speed* sets the playback rate (1×–600× real time).
Shown only for GPX files that contain timestamps. Files without timestamps (for
example a plain GPX route export) still load and show the route, but the app
notes that the "GPX workout" export format is needed for time and speed data.

Settings panel: map source, map zoom level, vertical exaggeration, hill shading,
route colouring (solid, speed, elapsed time, elevation), line width, route height
(terrain model or recorded altitude), screenshot.

## Data sources

| Layer | Source |
|---|---|
| Map | OpenStreetMap, OpenTopoMap, Esri World Imagery |
| Elevation | Mapzen Terrain Tiles (Terrarium) on AWS Open Data, ~30 m resolution in Finland |

Please respect the tile providers' usage policies; this tool is meant for light
personal use.

## Code layout

```
index.html        page, CDN import map, overlays
src/main.js       scene, camera, controls, settings panel, loading
src/gpx.js        GPX parsing, distance / speed / statistics
src/geo.js        Web Mercator projection, tile maths, local metre frame
src/tiles.js      tile download and stitching, elevation decoding
src/terrain.js    terrain mesh
src/track.js      route line and start/finish markers
```

`*.gpx` files are git-ignored so personal workouts are not committed by accident.
