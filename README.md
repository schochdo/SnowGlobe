# Snow Globe

[![Deploy to GitHub Pages](https://github.com/schochdo/SnowGlobe/actions/workflows/deploy.yml/badge.svg)](https://github.com/schochdo/SnowGlobe/actions/workflows/deploy.yml)
[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://schochdo.github.io/SnowGlobe/)

An open-source, client-side alpine terrain atlas and 3D flight engine covering **5,905 ski areas worldwide**. Built with authentic cartographic rigor, 30-meter global elevation modeling, live summit-calibrated meteorology, and deterministic trail network topology.

**[Explore the Live Atlas →](https://schochdo.github.io/SnowGlobe/)**

---

## What Is Snow Globe?

Snow Globe is an interactive cartographic atlas designed on an **editorial, anti-SaaS standard**: no generic software version badges, no decorative pulsing status dots, and no synthetic tech-jargon padding. Every elevation contour, vector line, summit forecast, and trail grade reflects verifiable real-world domain truth.

- **3D Global Hypsometry**: Global spherical perspective globe with continuous 30-meter DEM elevation modeling down to terrain level.
- **60 FPS Keyboard Flight Engine**: Low-altitude alpine flight across peaks, ridges, and bowls with predictive terrain obstacle clearance.
- **5,905 Ski Resorts**: Complete catalog covering North America, the European Alps, Scandinavia, Japan, the Andes, Australia, and New Zealand.
- **Full Trail & Lift Cartography**: 299,000+ vector features classified deterministically into downhill runs (191k+), Nordic cross-country trails (99k+), and backcountry touring routes (8.5k+).
- **Summit-Calibrated Live Meteorology**: Real-time 7-day snowfall forecasts, freezing level heights, and wind gusts from Open-Meteo, evaluated at each mountain's surveyed summit elevation to eliminate valley temperature distortion.
- **Historic Fire Lookouts & Alpine Summits**: Integrated overlays of 1,843 historic wildfire watchtowers (NHLR/FFLA) and 1,093 prominent alpine peaks (GNIS / Natural Earth).
- **Zero Backend**: 100% client-side architecture running directly in the browser with zero server dependencies or runtime databases.

---

## Interactive Controls & Navigation

Snow Globe features a multi-tiered input system supporting full 60fps keyboard flight, native macOS trackpad gestures, multi-touch tablets/phones, and standard mouse navigation.

### 60 FPS Keyboard Flight Engine

Activate flight at any time using navigation keys (no modifier keys required):

| Key | Action | Kinematics |
|---|---|---|
| **`↑` / `↓`** | Forward / Backward | Horizontal surface cruising along camera heading |
| **`←` / `→`** | Strafe Left / Right | Lateral horizontal cruising perpendicular to heading |
| **`W` / `S`** | Pitch Tilt | Tilts camera eye up toward 3D horizon / down toward nadir |
| **`A` / `D`** | Heading Rotate | Spins camera azimuth bearing left / right |
| **`Q` / `E`** *(or `PgDn`/`PgUp`)* | Vertical Altitude | Pure vertical "helicopter elevator" straight up/down without lateral drift |
| **`Z` / `X`** *(or `-`/`+`)* | Zoom In / Out | Adjusts focal magnification along view vector |
| **`Shift`** *(hold)* | Sprint | 2.0×–2.5× speed multiplier across all flight axes |
| **`Esc`** | Deselect | Clears active trail selection or selected resort |

*Ground collision clearance is enforced continuously: predictive terrain lookahead checks 0.6 seconds ahead along your flight vector to ensure the camera never clips through mountain surfaces.*

### Trackpad & Mouse Gestures

- **Safari Trackpad Twist**: Two-finger twist rotates camera azimuth heading.
- **Safari Trackpad Pinch**: Two-finger pinch zooms focal center cleanly without double-zoom stutter.
- **Chrome / Brave Pinch**: Trackpad pinch zooms centered without browser tab scaling.
- **`Shift` + Scroll**: Tilts 3D camera pitch angle directly.
- **`Option` / `Alt` + Scroll**: Rotates camera azimuth bearing.
- **Left-Click Drag**: Pans terrain (retaining linear momentum).
- **Right-Click Drag**: Rotates bearing and tilts pitch around viewport center.

### Touchscreen & Tablet Arbiter

- **Two-Finger Vertical Drag**: Dedicated gesture arbiter locks into pitch tilt when vertical movement dominates (`|dy| > 1.5 · |dd|`), preventing accidental zoom shifts.
- **Two-Finger Pinch / Rotate**: Smoothly scales zoom and rotates heading around the touch midpoint.
- **Touch-Lift Jerk Suppression**: 120ms single-finger suppression when lifting from two fingers prevents touch-off snaps.

---

## Technical Stack & Frameworks

| Layer | Technology | Role |
|---|---|---|
| **UI Framework** | [React 19](https://react.dev/) | Modular component orchestration, reactive sidebar & HUD |
| **Language** | [TypeScript](https://www.typescriptlang.org/) | Strict domain typing (`SkiResort`, `TopologyFeature`, `CameraMode`) |
| **Mapping Engine** | [MapLibre GL JS v6](https://maplibre.org/) | 3D globe projection, raster-DEM elevation, custom protocols, WebGL2 vector styling |
| **Build Tool** | [Vite 8](https://vite.dev/) | Lightning-fast HMR, asset hashing, and client production bundling |
| **Styling** | [Tailwind CSS v4](https://tailwindcss.com/) | Low-overhead utility styling with custom editorial typography |
| **Typography** | Newsreader, JetBrains Mono, Plus Jakarta Sans | Classic Swiss / cartographic editorial hierarchy |
| **Icons** | [Lucide React](https://lucide.dev/) | Crisp, lightweight interface icons |
| **Elevation Protocols** | Custom Protocol Handlers (`src/utils/terrainAnalysis.ts`) | On-the-fly client-side DEM 3×3 Sobel/Horn convolution for real-time slope and aspect angle overlays |

---

## Key Architectural Decisions

### 1. Mapterhorn DEM Over AWS Terrarium
Earlier iterations using AWS Terrarium DEM encountered vertex spikes and geometry tearing in steep vertical mountain canyons (e.g. Chamonix, Yosemite, Dolomites). Snow Globe standardizes on **Mapterhorn DEM** (Terrarium RGB encoding), providing stable, void-free worldwide 30-meter ground sample hypsometry calibrated to 0.70× vertical exaggeration to preserve true mountain geometry.

### 2. 3-Tier Deterministic Topological Classifier
OpenStreetMap pistes often lack relational resort boundaries, feature mapper gaps across cliff bands, or mislabel summer hiking paths as ski runs. Rather than relying on fragile runtime distance heuristics:
- **Tier 1 (Strict Discipline Segregation)**: Segregates Nordic cross-country and uphill ski tours before downhill evaluation. Nordic trails never become downhill runs simply by passing under a lift.
- **Tier 2 (Universal Physical Gradient Law)**: Enforces physical kinematics. Trails $\ge 1,200\text{m}$ with average slope $\le 4.5^\circ$ ($< 8\%$ grade) lacking machine grooming cannot sustain skiing; they are demoted to `ignore` or `touring`. Untagged resort ski-outs with novice/easy difficulty are protected. Boundary polygons (`landuse=winter_sports`) are verified via point-in-polygon ray-casting.
- **Tier 3 (Directed Downhill BFS & Gravity Sink Law)**: Seeds graph exploration only from upper lift terminals (upper 70% of elevation span), enforces downhill elevation monotonicity (`nextMinZ <= currentMaxZ + 15m`), widens snapping to ~65m ($\pm 3$ cells) to bridge cliff bands, indexes polygon perimeters and centroids, and demotes runs dropping into unserviced backcountry drainages (e.g., Mt. Baker Blueberry Chutes) to `touring`.

### 3. Summit Elevation Meteorologic Correction
Standard weather APIs default to low-elevation valley weather stations, causing false rain predictions and miscalculated snow totals for alpine summits. Snow Globe passes each resort's authentic surveyed summit elevation (`elevation={summitElevM}`) directly to Open-Meteo's high-resolution ensemble (ECMWF, HRRR, GFS), providing true alpine summit forecasts.

### 4. Zero-Backend Static Distribution
Snow Globe requires no backend servers, API keys for visitors, or runtime databases. All 5,905 resort GeoJSON datasets are pre-baked, pre-classified, and served as static assets over GitHub Pages via Vite with sub-path routing (`BASE_URL=/SnowGlobe/`).

---

## Repository Structure

```
SnowGlobe/
├── src/
│   ├── App.tsx                    ← Core orchestrator & map viewport
│   ├── camera/                    ← Camera Subsystem (FSM, keyboard flight, kinematics)
│   ├── components/                ← Modular UI components (TopNavBar, LeftDock, MountainProfile, Legend)
│   ├── data/                      ← Static curated flagship ski atlas & heli/cat operators
│   ├── layers/                    ← Vector Layers Subsystem (pistes, lifts, boundaries, peaks, lookouts)
│   ├── services/                  ← Ingestion pipeline, deduplication, Open-Meteo weather service
│   ├── types/                     ← TypeScript domain interfaces
│   └── utils/                     ← Formatters, classification, map styles, piste topology graph
├── data_pipeline/                 ← Offline SQLite ingestion & extraction tools
├── public/
│   ├── data/trails/*.json         ← Pre-baked resort GeoJSON with immutable atlas_category tags
│   └── data/global_ski_areas.json ← Global resort catalog with verified metadata
├── scripts/
│   ├── apply_piste_topology.cjs   ← Offline batch script: applies topology classifier to 5,905 datasets
│   └── verify_topology_canary.cjs ← Fast headless CLI test suite asserting edge case classifications
├── ARCHITECTURE.md                ← Deep-dive system design, gotchas, and invariants
├── DATA_SOURCES.md                ← Provenance & licensing for all cartographic datasets
├── CHANGELOG.md                   ← Chronological log of all commits, features, and fixes
├── vite.config.ts                 ← Build configuration & trails dev plugin
└── package.json
```

---

## Getting Started

### Prerequisites
- Node.js 22 LTS or newer

### Installation
```bash
# Clone repository
git clone https://github.com/schochdo/SnowGlobe.git
cd SnowGlobe

# Install dependencies
npm install

# Start local dev server (port 3000)
npm run dev

# Run TypeScript typecheck
npm run lint

# Run headless topology canary verification suite
node scripts/verify_topology_canary.cjs

# Build production bundle
npm run build
```

---

## Documentation Index

- **[ARCHITECTURE.md](./ARCHITECTURE.md)**: Exhaustive architectural reference, camera state machine invariants, data flow, developer guardrails, and gotchas.
- **[DATA_SOURCES.md](./DATA_SOURCES.md)**: Complete cartographic provenance, survey benchmarks, data licensing, and coordinate reference systems.
- **[CHANGELOG.md](./CHANGELOG.md)**: Reverse-chronological record of every feature, fix, and commit.

---

## License

Code is licensed under the [MIT License](LICENSE). Cartographic and elevation data retains respective upstream Open Data licenses (ODbL, CC-BY 4.0, Public Domain). See [DATA_SOURCES.md](./DATA_SOURCES.md) for full licensing attribution.
