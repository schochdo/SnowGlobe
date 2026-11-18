# Snow Globe — Architecture & Design Reference

> This document is the authoritative reference for AI agents and developers working on this codebase. Read this before making any changes.

---

## 1. What This Is

**Snow Globe** is a cartographic editorial application for exploring ski areas worldwide. It is a **single-page React app** with a MapLibre GL JS map at its core. There is no backend — all data is either bundled at build time or fetched client-side from public APIs.

**Stack:** React 18 · TypeScript · MapLibre GL JS · Tailwind CSS · Vite

---

## 2. Design Principles (Non-Negotiable)

These are permanent constraints. Do not violate them.

1. **No vanity UI** — no version badges, no pulsing status dots, no "System Optimal" indicators, no SaaS chrome.
2. **Editorial cartographic aesthetic** — layout follows the domain (full-bleed map, left dock directory, mountain profile view). Not a dashboard grid.
3. **Strict unit hygiene** — snowfall is always in `in` (imperial) or `cm` (metric). Vertical is `ft` or `m`. Acreage is `ac` or `ha`. Never mix or display without units.
4. **No temperature on resort cards** — snow quantity only on the list. Temperature belongs in the detail mountain profile only.
5. **Metric/imperial toggle** — global `unitsMetric: boolean` state. Always use `formatSnow()`, `formatVert()`, `formatAcres()` helpers — never raw numbers.

---

## 3. File Structure

```
SnowGlobe/
├── src/
│   ├── App.tsx                    ← Core orchestrator & map viewport (~2,800 lines)
│   ├── main.tsx                   ← React root mount
│   ├── index.css                  ← Tailwind base + MapLibre overrides
│   ├── camera/                    ← Camera & Flight Subsystem
│   │   ├── index.ts               ← Unified camera module entry point
│   │   ├── types.ts               ← CameraMode ('idle'|'flight'|'flyto'|'inspect'), kinematics constants
│   │   ├── cameraStateMachine.ts  ← Finite State Machine, safeFlyTo, safeEaseTo
│   │   ├── cameraUtils.ts         ← Geodesic displacement math, terrain sampling, globe fit
│   │   └── useKeyboardFlight.ts   ← 60fps rAF keyboard flight engine (WASD + arrows + QE)
│   ├── layers/                    ← Vector Layers & Styling Subsystem
│   │   ├── index.ts               ← registerAllVectorLayers orchestrator & exports
│   │   ├── types.ts               ← LAYER_IDS, SOURCE_IDS, registration interfaces
│   │   ├── trailLayers.ts         ← Live vector pistes, aerial lifts, and selected trail highlight
│   │   ├── boundaryLayers.ts      ← Natural Earth country/state borders, 4-tier places
│   │   ├── resortLayers.ts        ← Curated flagship markers, selected pin, global clusters
│   │   ├── poiLayers.ts           ← Major mountain peaks and historic fire lookouts
│   │   └── layerThemeManager.ts   ← Reactive basemap theme, visibility, and GPU filter sync
│   ├── types/
│   │   └── index.ts               ← SkiResort, PassNetwork, BasemapMode, SortBy, etc.
│   ├── utils/
│   │   ├── formatters.ts          ← Unit hygiene helpers: formatSnow, formatVert, formatAcres, formatDistance
│   │   ├── camera.ts              ← Forwarding facade to src/camera/
│   │   ├── geometry.ts            ← extractPointCoordinates, haversineDistanceKm
│   │   ├── classification.ts      ← PASS_COLORS, PASS_DISPLAY_NAMES, getResortStats, getCategoryBadge
│   │   ├── mapStyles.ts           ← MapLibre style JSON factory (satellite, osm, topo, Mapterhorn DEM, slope, aspect)
│   │   ├── pisteTopologyGraph.ts  ← Single canonical source of truth for 3-tier piste topology graph classifier
│   │   ├── trailAnalysis.ts       ← Trail elevation profile sampler, grade analysis, connected feature aggregation
│   │   └── terrainAnalysis.ts     ← Client-side 3x3 Sobel/Horn DEM convolution protocols (slope://, aspect://)
│   ├── data/
│   │   ├── resorts.ts             ← Curated flagship ski atlas (GLOBAL_SKI_ATLAS)
│   │   ├── heliCat.ts             ← Curated heli/cat operators (HELI_CAT_OPERATIONS)
│   │   └── curatedTrails.ts       ← Pre-exported OSM piste/lift GeoJSON
│   ├── services/
│   │   ├── weather.ts             ← Open-Meteo live meteorology service & neutral forecast builder
│   │   └── resorts/               ← OpenSkiData & Curated Dataset Pipeline Subsystem
│   │       ├── index.ts           ← Pipeline exports
│   │       ├── types.ts           ← Filter criteria, seed index, result types
│   │       ├── deduplication.ts   ← Spatial & token deduplication, quality filters, URL hygiene
│   │       ├── resortCatalog.ts   ← Ingestion of OpenSkiData, catalog merging, weather state preservation
│   │       └── resortFiltering.ts ← Viewport in-bounds filtering, directory sorting, dynamic GeoJSON sync
│   ├── components/
│   │   ├── header/
│   │   │   ├── TopNavBar.tsx      ← Editorial brand wordmark, extent reset, fullscreen, popover triggers
│   │   │   └── FilterModal.tsx    ← Sliders, unit toggles, pass network filters, projection selector
│   │   ├── sidebar/
│   │   │   ├── LeftDock.tsx       ← Collapsible desktop drawer container with pull tab
│   │   │   ├── DirectoryList.tsx  ← Search input, sort bar, scope tabs, active selection banner, resort list
│   │   │   ├── ResortCard.tsx     ← 3-row editorial resort card with pass chips and 7-day snow chip
│   │   │   ├── ActiveSelectionBanner.tsx ← Sticky selection & quick deselect banner
│   │   │   └── MobileSheet.tsx    ← Mobile bottom drawer (peek, half, full states)
│   │   ├── profile/
│   │   │   └── MountainProfile.tsx← Mountain profile view: lifts/pistes/acres, vertical/summit/base, 7-day meteorology bars
│   │   └── map/
│   │       ├── NavigationControls.tsx ← Vertical [ + ] [ − ] [ ▲ ] zoom and true north snap
│   │       ├── RegionalLocator.tsx    ← Collapsible 2D MapLibre overview inset (Esri World Topo Map)
│   │       ├── BasemapMenu.tsx        ← Basemap selector & 3D terrain exaggeration slider
│   │       ├── CartographicLegend.tsx ← Map key popover & alternating scale bar
│   │       ├── CompassGimbal.tsx      ← Concentric rotary compass heading & 3D tilt horizon gimbal
│   │       ├── AttributionBadge.tsx   ← Collapsible map attribution pill
│   │       └── TrailProfileCard.tsx   ← Interactive trail elevation profile, pitch badge, and stats card
│   └── server/
│       └── trailsPlugin.ts        ← Vite dev plugin: serves local SQLite trails DB via HTTP
├── data_pipeline/
│   ├── trails.db                  ← SQLite: OSM piste + lift geometries keyed by resort bbox
│   ├── build_trails_db.cjs        ← Script: build trails.db from Overpass API
│   ├── export_resort_trails.cjs   ← Script: export per-resort GeoJSON from DB
│   ├── export_all_ski_areas.cjs   ← Script: export all global ski areas from trails.db
│   └── pisteTopologyGraph.cjs     ← CommonJS adapter re-exporting canonical src/utils/pisteTopologyGraph.ts
├── scripts/
│   ├── apply_piste_topology.cjs   ← Offline batch script: applies topology classifier to public/data/trails/
│   └── verify_topology_canary.cjs ← Fast headless CLI test suite asserting topology classifications & edge cases
├── public/                        ← Static assets served as-is (resort GeoJSON, country bounds, peaks, lookouts)
│   └── data/trails/*.json         ← Pre-baked resort GeoJSON with immutable atlas_category tags
├── index.html
├── vite.config.ts
└── CHANGELOG.md                   ← Every feature/fix logged here
```

---

## 4. Architectural Organization & Responsibilities

The codebase follows clean separation of concerns, isolating heavy data sets, domain formatters, network calls, and UI components from the main MapLibre viewport orchestrator.

| Layer / Directory | Primary Files | Responsibilities |
|---|---|---|
| **Camera Subsystem** | `src/camera/` | Finite State Machine (`idle`, `flight`, `flyto`, `inspect`), 60fps rAF keyboard flight engine (`useKeyboardFlight`), terrain obstacle clearance guards, and safe programmatic navigation (`safeFlyTo`, `safeEaseTo`). |
| **Vector Layers Subsystem** | `src/layers/` | Modular source and layer definitions (`trailLayers`, `boundaryLayers`, `resortLayers`, `poiLayers`), central orchestrator (`registerAllVectorLayers`), and reactive theme/filter synchronization (`layerThemeManager`). |
| **Types** | `src/types/index.ts` | Complete TypeScript domain interfaces (`SkiResort`, `PassNetwork`, `DailyForecast`, `ResortWeatherData`, etc.) |
| **Data Modules** | `src/data/resorts.ts`, `src/data/heliCat.ts` | Static curated flagship resorts (~91 global ski areas) and heli/cat operators. Separated from component closures to prevent HMR recompilation slowdowns. |
| **Utilities** | `src/utils/` | Formatters (unit hygiene), camera bounds validation (`safeFlyTo`), geometry math (`haversineDistanceKm`), pass & badge classifications (`classifySkiFeature`), and MapLibre style factories. |
| **Services** | `src/services/weather.ts`, `src/services/resorts/` | Asynchronous Open-Meteo live weather queries, batch prefetch orchestration, OpenSkiData ingestion, spatial & token deduplication, quality filtering, and viewport bounds filtering. |
| **Header Components** | `src/components/header/` | `TopNavBar` (brand crest, global extent reset, display popover triggers) and `FilterModal` (pass toggles, sliders, unit selectors). |
| **Sidebar Components** | `src/components/sidebar/` | `LeftDock`, `DirectoryList`, `ResortCard`, `ActiveSelectionBanner`, and `MobileSheet`. Manages directory search, sorting, and responsive drawer transitions. |
| **Profile Components** | `src/components/profile/` | `MountainProfile` provides deep editorial inspection of selected mountains (elevation profiles, lifts/pistes stats, official website links, and 7-day meteorology bars). |
| **Map Instruments** | `src/components/map/` | `NavigationControls`, `RegionalLocator`, `BasemapMenu`, `CartographicLegend`, `CompassGimbal`, and `AttributionBadge`. Self-contained cartographic instruments with click-outside handlers and independent 2D MapLibre instances. |
| **Core Orchestrator** | `src/App.tsx` | Main application coordinating the primary 3D MapLibre GL map canvas, real-time Overpass SQLite trail streaming, camera gestures, and shared selection state. |

---

## 5. Data Flow

```
GLOBAL_SKI_ATLAS (static)
    │
    ├─→ resorts[] state (initialized with getNeutralWeather placeholders)
    │       │
    │       ├─→ [on mount] prefetch useEffect → fetchLiveWeather() × all resorts
    │       │       └─→ setResorts() patches weather onto each resort as it resolves
    │       │
    │       └─→ [on resort click] handleSelectResort → fetchLiveWeather() (refresh)
    │               └─→ setResorts() patches single resort weather
    │
    ├─→ filteredResorts (memo) — applies pass/vert/acres/category/search filters + sort
    │
    ├─→ inViewResorts (memo) — filteredResorts clipped to map viewport bounds
    │
    └─→ displayedResorts (memo) — either inViewResorts or filteredResorts per directoryScope
            └─→ Resort cards in left dock (sorted by sortBy state)
```

---

## 6. Weather Data

**Source:** [Open-Meteo](https://open-meteo.com/) — free, no API key required.

**Endpoint:** `https://api.open-meteo.com/v1/forecast?latitude=...&longitude=...&elevation=...&hourly=snowfall,freezing_level_height,wind_gusts_10m,temperature_2m&daily=snowfall_sum,temperature_2m_max,temperature_2m_min&timezone=auto`

**What we compute:**
| Field | How |
|---|---|
| `snowfall_72h_in/cm` | Sum of first 72 hourly `snowfall` values |
| `snowfall_7d_in/cm` | Sum of all `daily.snowfall_sum` values (7 days) |
| `daily_forecast[]` | One entry per forecast day with snow + temp |
| `current_temp_f/c` | `hourly.temperature_2m[0]` |
| `summit_wind_gust_mph` | `hourly.wind_gusts_10m[0]` converted from km/h |
| `freezing_level_ft` | `hourly.freezing_level_height[0]` converted from m |
| `is_live` | Always `true` when fetch succeeds |

**Prefetch strategy:** On app mount, all ~91 resorts are fetched in batches of 5 concurrent requests with 200ms between batches. This ensures cards are sorted by real 7-day snow data within ~5-10 seconds.

---

## 7. Map Configuration

**Library:** MapLibre GL JS (open-source fork of Mapbox GL JS)

**Projection modes:**
- `globe` — 3D spherical globe (default on startup, centered on North America)
- `mercator` — flat 2D map

**Terrain:** Mapterhorn global DEM (void-free, replaces AWS Terrarium which caused geometry spikes)
- URL: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
- Encoding: `terrarium`

**Basemap modes:** `satellite` | `osm` | `topo`
- `satellite`: Esri World Imagery (Standard) at `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` (seamless global multi-scale orthoimagery with color-balanced edges up to z19; avoid Clarity due to resort boundary cutoffs and missing fringe tiles).
- 3D Oblique LOD: Calibrated via `map.setSourceTileLodParams(3.5, 6.0, 'satellite-tiles')` to prevent MapLibre from downgrading pitched mountain faces to coarse zoom levels when looking toward the horizon. `raster-fade-duration` set to 0.

**Key layers (in order):**
1. Terrain (DEM source)
2. Hillshade
3. Basemap raster tiles
4. Terrain Analysis Overlays (`overlay-slope`, `overlay-aspect`) — client-side DEM-derived raster tiles
5. Resort clusters (GeoJSON source: `resorts-source`)
6. Piste/lift lines (GeoJSON source: `trails-source`) — streamed per resort on zoom/click
7. Labels (hidden until zoom ≥ 10)

**Globe startup behavior:**
- Initial padding applied **synchronously** before map construction to prevent globe drift
- North-up (`bearing: 0`) by default
- Centered on North America: `[-100, 47]` zoom 3.2

---

## 8. Camera, Flight Engine & Gesture Subsystem

The camera system balances 60fps high-speed keyboard cruising across rugged 3D terrain, native trackpad gestures, precision touchscreens, and programmatic easing without elevation slamming, clipping, or double-zoom artifacts.

### 8.1 Finite State Machine (`src/camera/cameraStateMachine.ts`)

The camera operates under 4 discrete modes:
- `'idle'`: Static viewing or manual mouse pan/orbit.
- `'flight'`: Active 60fps keyboard cruising (`useKeyboardFlight`).
- `'flyto'`: Programmatic eased transition (`safeFlyTo`, `safeEaseTo`) to resorts, lookouts, or home bounds.
- `'inspect'`: Stationary close-up inspection of selected terrain features.

**State Machine Invariants:**
1. **Manual Preemption**: Any manual user interaction (mouse drag, keyboard navigation key, UI zoom button) immediately calls `cameraStateMachine.cancelProgrammaticFlight(map)` to preempt any running `flyTo` animation.
2. **Safe Navigation Wrappers**: Never call `map.flyTo()` or `map.easeTo()` directly from components. Always use `safeFlyTo()` or `safeEaseTo()`. These wrappers validate coordinates (`isFinite`, NaN checks), enforce center ground clamping, and coordinate mode transitions through the state machine.
3. **Zoom Button Coordination**: UI zoom buttons (`+` / `-`) cancel active flight before easing via `safeEaseTo({ zoom, freezeElevation: true })`, preventing frame-fighting with the keyboard loop.

### 8.2 60 FPS Keyboard Flight Engine (`src/camera/useKeyboardFlight.ts`)

Implements smooth, level, momentum-calibrated flight across 3D terrain:

| Input Keys | Action | Behavior |
|---|---|---|
| `ArrowUp` / `ArrowDown` | Forward / Backward | Horizontal surface cruising along camera heading |
| `ArrowLeft` / `ArrowRight` | Strafe Left / Right | Lateral cruising perpendicular to camera heading |
| `KeyW` / `KeyS` | Pitch Tilt | Smoothly tilts camera eye up toward horizon / down toward nadir |
| `KeyA` / `KeyD` | Heading Rotate | Spins camera azimuth bearing left / right |
| `KeyQ` / `KeyE` (or `PgDn` / `PgUp`) | Vertical Altitude | Pure vertical "helicopter elevator" — adjusts altitude straight up/down without lateral drift |
| `KeyZ` / `KeyX` (or `-` / `+`) | Zoom In / Out | Adjusts focal magnification along view vector |
| `Shift` (held) | Sprint | 2.0x–2.5x speed multiplier across all flight axes |

**Flight Kinematics & Gotchas:**
- **Predictive Ground Clearance**: `sampleTerrainObstacle` probes terrain 0.6 seconds ahead along the trajectory, enforcing a minimum 25m clearance floor (`MIN_CAMERA_CLEARANCE_METERS`) so the camera eye never penetrates mountain faces.
- **Elevation Hold During Panning**: During horizontal cruising, elevation is held steady to prevent unpleasant bobbing over peaks and valleys.
- **NEVER Call `releaseElevation` on Key Release**: On flight end (`stopFlight`), **never** invoke private MapLibre elevation re-anchoring APIs (`cam.releaseElevation()` / `cam.putCenterBackOnTerrain()`). These methods execute a synchronous, discontinuous elevation jump that causes visible camera "slamming" or "jerking". MapLibre's native terrain compositor settles center elevation naturally on subsequent frames without intervention.
- **Guard MoveEnd Pitch Corrections**: Never fire synchronous `map.setPitch()` corrections inside `moveend` handlers while `cameraStateMachine.getMode() === 'flight'`.

### 8.3 Trackpad & Wheel Controller (`src/App.tsx`)

- **Safari Trackpad Pinch & Rotate**: Safari fires native `gesturestart`, `gesturechange`, and `gestureend` events for trackpad pinches and twists.
  - **Double-Zoom Prevention**: MapLibre's built-in `scrollZoom` **must be disabled** during active Safari gesture events (`map.scrollZoom.disable()`). Because Safari dispatches both `gesturechange` and `wheel` events for trackpad pinches, leaving `scrollZoom` enabled results in both handlers incrementing zoom simultaneously (2x jerky double-zoom). `scrollZoom` is re-enabled on `gestureend` or a 400ms watchdog timeout.
- **Chrome / Brave Trackpad Pinch**: Dispatched as `wheel` events with `e.ctrlKey === true`. Intercepted with `e.preventDefault()` to prevent Chromium browser tab zoom while allowing MapLibre's centered `scrollZoom` to process the event cleanly.
- **Modifier Scroll Controls**:
  - `Shift + Two-Finger Scroll`: Direct 3D camera pitch tilt.
  - `Option/Alt + Two-Finger Scroll`: Direct camera azimuth rotation.
- **iOS vs. macOS Detection**: iPads report `navigator.platform === 'MacIntel'` with `maxTouchPoints > 1`, identical to MacBook trackpads. Disambiguate by checking `'ontouchend' in document` — true on iOS/iPadOS touchscreens, false on macOS. Real iPads skip trackpad gesture handlers in favor of touch handlers; MacBooks keep custom gesture twist-to-rotate enabled.

### 8.4 Tablet & Mobile Touch Arbiter (`src/App.tsx`)

- **Built-in `touchPitch` Disabled**: MapLibre's default `touchPitch` triggers accidental pitch tilts during two-finger pinch-zooms. It is permanently disabled via `map.touchPitch.disable()`.
- **Two-Finger Intent Arbiter (12px Deadzone)**:
  - If vertical displacement strongly dominates (`|dy| > 1.5 * |dd|` and rotation `< 8°`), the gesture locks to `'pitch'` mode, modifying pitch smoothly and disabling `touchZoomRotate`.
  - Otherwise, the gesture locks to `'zoom-rotate'`, enabling smooth pinch-zoom and rotation around the touch midpoint.
- **Touch-Lift Jerk Suppression**: When releasing from 2 fingers to 1 (`lastTouchCount === 2 && remainingTouches === 1`), single-finger panning is suppressed for 120ms to prevent the remaining finger from jerking the camera.

### 8.5 Progressive Pitch Constraint

At all times, maximum pitch is governed by a continuous progressive ceiling:
$$\text{maxAllowedPitch} = \text{clamp}\left(0, 82, (\text{zoom} - 3.5) \times 18\right)$$
- Zoom $\le 3.5$: pitch locked to $0^\circ$ (keeps the 3D globe centered without dipping below the horizon).
- Zoom $3.5 \to 8.0$: smoothly scales from $0^\circ \to 81^\circ$.
- Zoom $\ge 8.0$: capped at $82^\circ$ for safe oblique mountain viewing.

---

## 9. Resort Cards (Left Dock)

Each card shows:
- Resort name (serif, bold)
- Category badge (downhill/nordic/heli-cat)
- Region, Country · Vertical · Acreage (in selected units)
- **7-day snow chip** (blue, snowflake icon) — shows `snowfall_7d_in` or `snowfall_7d_cm`

**Default sort:** 7-day snow forecast (`sortBy = 'snow'`), descending.

**Sort options:** 7-Day Snow | Vertical | Acreage | Name

**Directory scope tabs:** IN FRAME (viewport-clipped) | ALL MATCHING (full filter results)

---

## 10. Sorting Logic

Located in `filteredResorts` useMemo (not `displayedResorts`).

```ts
if (sortBy === 'snow') {
  // Uses snowfall_7d_in — NOT snowfall_72h_in
  const diff = (a.weather?.snowfall_7d_in ?? 0) - (b.weather?.snowfall_7d_in ?? 0);
  return diff * multiplier;
}
```

> **Important:** The sort key is `snowfall_7d_in`. Do not revert this to `snowfall_72h_in`.

---

## 11. Known Constraints & Gotchas

- **Modular Architecture** — `src/App.tsx` coordinates dedicated sub-components (`src/components/`), services (`src/services/`), data modules (`src/data/`), types (`src/types/`), and utilities (`src/utils/`). Do not re-collapse into a monolithic file.
- **No backend** — all data is client-side. Do not add a server dependency.
- **Open-Meteo rate limits** — the API is free but has limits. Batch size of 5 with 200ms delay is conservative. Do not increase batch size beyond 10.
- **Globe centering** — `setPadding` must be called synchronously before map construction, not in a `useEffect`. This was a hard-won fix; do not change the initialization order.
- **Terrain on globe** — terrain source must be re-added when switching from mercator back to globe. The `useEffect` watching `earthProjection` handles this.
- **`safeFlyTo()`** — always use this instead of `map.flyTo()` directly. It validates coordinates and prevents crashes from NaN/Infinity values.
- **Mobile Touch Controls & Bottom Sheet** — multi-touch pinch-to-zoom must anchor around the touch midpoint (`map.touchZoomRotate.enable()` without `{ around: 'center' }`). Never invert `bearingDelta` on touch rotate; MapLibre natively rotates with the user's fingers. Never monkey-patch `touchPitch` with low vertical pixel thresholds (which hijacks pinch-zooms into pitch tilts). Mobile sheet allows single-tap direct full expansion (`88dvh`) from peek and fluid touch-drag gestures.
- **Cluster counts** — updated dynamically when filters change via a `useEffect` that re-generates GeoJSON source data. Do not bypass this.

---

## 12. Data Pipeline, Upstream Ingestion & Maintenance Procedures

To prevent undoing previous sanitization work or re-introducing upstream bugs, follow these documented procedures when refreshing data:

### Ingestion Cadence
- **Annual Macro Refresh (Late October / Early November)**: Ingest fresh OpenSkiData/OSM exports only once per year ahead of the Northern Hemisphere winter. Frequent pulls re-introduce spam, unverified edits, and classification regressions for minimal trail gain.
- **In-Season Spot Edits (As Needed)**: For landmark new lifts (e.g., replacement gondolas or trams at flagship resorts), edit individual resort trail files in `public/data/trails/<slug>.json` or `src/data/resorts.ts` directly.

### Upstream Ingestion QA Checklist (Run After Any Raw Pull)
1. **Topological Graph Classification (`apply_piste_topology.cjs`)**:
   - Run `node scripts/apply_piste_topology.cjs` after any database rebuild.
   - Executes the 3-Tier Topological Classifier (`pisteTopologyGraph`) to pre-bake deterministic `atlas_category` tags (`downhill`, `nordic`, `touring`, `ignore`) onto all 5,905 resort GeoJSON files.
   - Enforces the **Universal Physical Gradient Law** ($\ge 1,200\text{m}$, $\le 4.5^\circ$ slope, un-groomed $\to$ `ignore`/`touring`) and the **Gravity Sink Law** (lowest terminus $> 350\text{m}$ from lifts without return connectivity $\to$ `touring`).
   - No hardcoded IDs or whack-a-mole overrides allowed.
2. **URL Sanitization & Healing Pipeline**:
   - Run `node scripts/run_url_audit.cjs` followed by `python3 scripts/apply_comprehensive_url_cleanup.py`.
   - **Deep-Path 404 Rescuing**: Automatically heals stale seasonal subpaths back to verified active root portals.
   - **Dead Link Zeroing**: Purges dead domains, NXDOMAINs, discontinued `business.site` links, and spam landers to `""` so the link button cleanly omits itself in `MountainProfile`.
   - **Runtime Firewall**: Never remove the domain filter in `getResortWebsite()` (`src/utils/classification.ts`) or `src/App.tsx`.
3. **Nordic Acreage Hygiene**:
   - Upstream OpenSkiData often assigns entire national park boundary acreage to Nordic centers (e.g. 30,000 acres to Pyhätunturi-Luosto or 19,000 acres to Katahdin).
   - Ensure `category === 'nordic'` entries have `skiable_acres` zeroed out so they do not falsely outrank major alpine downhill resorts. Trail network length (`trail_km` / `trail_mi`) is the metric for Nordic centers.
4. **Geometry Filtering (Piste Casing Lines)**:
   - When importing piste lines, ensure `LineString` and `MultiLineString` geometry filters are preserved on `live-pistes-casing`, `live-pistes-lines`, and `live-pistes-labels` to prevent polygon boundary strokes (3-parallel-line visual glitch).
5. **Resort Name Sanitization**:
   - Verify `cleanResortName()` in `src/utils/classification.ts` runs on ingestion to suppress multilingual script concatenation (e.g., Cyrillic/CJK concatenations when English Latin names exist).

---

## 13. Trail Classification & Topological Engine

To solve the lack of relational resort boundaries and network topology in OpenStreetMap without brittle proximity heuristics, the system uses a **3-Tier Topological Graph Classifier** (`src/utils/pisteTopologyGraph.ts` and `data_pipeline/pisteTopologyGraph.cjs`):

1. **Tier 1 — Strict Discipline Segregation**: Isolates Nordic cross-country (`piste:type=nordic`) and uphill touring (`skitour`) before downhill evaluation. Non-ski clutter without winter attributes is marked `ignore`.
2. **Tier 2 — Universal Physical Gradient Law (Kinematics)**: Evaluates 3D coordinates. If a trail has length $\ge 1,200\text{m}$, average pitch $\le 4.5^\circ$ ($< 8\%$ grade), and lacks machine grooming (`classic`, `skating`, `scooter`), it cannot physically sustain downhill skiing. Demoted to `ignore` or `touring`. Catwalks and ski-outs with novice/easy difficulty are preserved. Features within `landuse=winter_sports` polygons are immediately classified as `downhill`.
3. **Tier 3 — Directed Downhill BFS & Gravity Sink Law**:
   - Builds a ~65m ($\pm 3$ cells) spatial hash grid and propagates `lift_served = true` up to 8,000m from upper lift terminals along connected run segments.
   - Fully indexes perimeter vertices and centroids of polygon glades and bowls.
   - Enforces downhill elevation monotonicity during propagation (`nextMinZ <= currentMaxZ + 15m`) and caps trail-name bridging to 150m.
   - **Gravity Sink Law**: If the lowest elevation terminus of a candidate run terminates $> 350\text{m}$ from any lift and connects to no downstream run returning to a lift, it is an unserviced backcountry descent. Automatically classified as `touring`.
4. **Client-Side Immutability**: The client MapLibre renderer treats pre-baked `atlas_category` as authoritative and never mutates it using client-side radius checks.

---

## 14. AI / Developer Guardrails & Strict Module Boundaries

To ensure fast, isolated, and bug-free development without cross-subsystem drift, all AI agents and developers must observe these hard boundaries:

1. **`public/data/trails/*.json` `atlas_category` Values Are Immutable at Runtime**:
   - The pre-baked `atlas_category` tags (`downhill`, `nordic`, `touring`, `ignore`) generated during offline ingestion are the authoritative ground truth.
   - `src/App.tsx`, `src/layers/`, and all client rendering code must **never** overwrite or mutate `atlas_category` with runtime radius checks (e.g. `isPisteNearLift`), bounding box checks, or proximity heuristics.
   - Any trail with `atlas_category === 'ignore'` must be excluded from downhill/nordic rendering and statistics.

2. **Trail Classification Rules Live Exclusively in `pisteTopologyGraph`**:
   - `src/utils/pisteTopologyGraph.ts` is the single canonical source of truth for all trail classification algorithms and physical gradient/gravity return laws.
   - `data_pipeline/pisteTopologyGraph.cjs` is a thin CommonJS adapter that re-exports `src/utils/pisteTopologyGraph.ts` so Node scripts and Vite/client never diverge.
   - Never duplicate classification rules or introduce localized heuristics into `src/App.tsx`, `src/layers/`, or `data_pipeline/`.

3. **Camera & Navigation Subsystem Invariants**:
   - **Never call raw `map.flyTo()` or `map.easeTo()` directly**: Always use `safeFlyTo()` or `safeEaseTo()` to route through the `CameraStateMachine`.
   - **Never call `releaseElevation()` or `putCenterBackOnTerrain()` on key release**: MapLibre settles terrain elevation smoothly across subsequent rendered frames. Synchronous private API re-anchoring causes camera snapping/slamming.
   - **Always disable `scrollZoom` during Safari `gesturechange`**: Prevents 2x double-zoom accumulation on trackpad pinch.
   - **Always disambiguate iOS from macOS via `'ontouchend' in document`**: Prevents MacBook trackpads from being misclassified as touchscreens.
   - **Never fire synchronous pitch corrections on `moveend` during active flight**: The flight engine enforces progressive pitch per-frame.

4. **Isolated Single-Area Modifications**:
   - Single-area tasks (e.g. tuning UI controls, adjusting camera flight, styling vector layers) must touch only their target modules according to the 1-line-per-file directory map in Section 3.
   - Always run the headless canary verification suite (`node scripts/verify_topology_canary.cjs`) before committing any changes touching trail classification or data pipeline logic.

---

## 15. Parked & Future Initiatives

- **Offline Tile & Elevation Caching (PWA / Airplane Mode)**:
  - *Goal*: Allow offline map browsing for single ski areas or backcountry hiking zones without cellular data.
  - *Data footprint*: ~3–5 MB per ski area across zoom levels 11–15 (imagery ~1.2 MB, Mapterhorn DEM ~1.8 MB, trail GeoJSON ~0.2 MB).
  - *Implementation path*: PWA `manifest.json`, Service Worker (`sw.js`) with `CacheStorage` proxy for tile domains (Esri World Imagery, AWS Terrarium DEM), and a "Save Offline" action button on `MountainProfile`.
  - *Status*: Parked for future consideration (most target areas currently have active cellular coverage).


