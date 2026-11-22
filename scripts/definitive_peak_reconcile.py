#!/usr/bin/env python3
"""
definitive_peak_reconcile.py — Definitive, global deduplication and topographic
high-point summit snapping for all mountain peaks in public/data/major_peaks.geojson.

1. Fixes corrupted / swapped coordinates (Zanzber Kangri, Mount Emu, Nangkartshang, etc.)
2. Eliminates duplicate summits, minor sub-peak bumps, and alias twins
3. Topographic apex snapping against the local Mapterhorn Copernicus 30m DEM
   so every peak marker mathematically sits at the physical summit in 3D terrain.
"""

import json
import math
import os
import time
import urllib.request
from PIL import Image

GEOJSON_PATH = 'public/data/major_peaks.geojson'
CACHE_DIR = '/tmp/mapterhorn_cache'

ZOOM = 12
N = 2.0 ** ZOOM

def deg2num(lat_deg, lon_deg):
    lat_rad = math.radians(lat_deg)
    xtile = int((lon_deg + 180.0) / 360.0 * N)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * N)
    return (xtile, ytile)

def num2deg(xtile, ytile, px, py, w=512, h=512):
    lon_deg = (xtile + px / float(w)) / N * 360.0 - 180.0
    y_norm = 1.0 - 2.0 * (ytile + py / float(h)) / N
    lat_rad = math.atan(math.sinh(math.pi * y_norm))
    return (round(math.degrees(lat_rad), 6), round(lon_deg, 6))

def is_coarse(lng, lat):
    lat_m = lat * 60
    lng_m = lng * 60
    is_arc = abs(lat_m - round(lat_m)) < 0.005 or abs(lng_m - round(lng_m)) < 0.005
    s_lat = f'{lat:.8f}'.rstrip('0')
    s_lng = f'{lng:.8f}'.rstrip('0')
    dec_lat = len(s_lat.split('.')[1]) if '.' in s_lat else 0
    dec_lng = len(s_lng.split('.')[1]) if '.' in s_lng else 0
    return is_arc or dec_lat < 4 or dec_lng < 4

tile_cache = {}

def get_tile(tx, ty):
    key = (tx, ty)
    if key in tile_cache:
        return tile_cache[key]
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(CACHE_DIR, f'12_{tx}_{ty}.webp')
    if not os.path.exists(cache_path):
        url = f"https://tiles.mapterhorn.com/{ZOOM}/{tx}/{ty}.webp"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SnowGlobe/1.0"})
            with urllib.request.urlopen(req, timeout=8) as resp, open(cache_path, "wb") as f:
                f.write(resp.read())
        except Exception:
            return None
    if os.path.exists(cache_path):
        try:
            img = Image.open(cache_path).convert('RGB')
            tile_cache[key] = img
            return img
        except Exception:
            pass
    return None

# 1. Authoritative ground-truth corrections for corrupted / swapped records
KNOWN_CORRECTIONS = {
    'peak-103': [85.834839, 34.377087],    # Zanzber Kangri (swapped lat/lon -> Tibet)
    'peak-286': [86.833700, 27.904000],    # Nangkartshang Peak (negative lon -> Nepal positive)
    'peak-466': [146.565920, -36.741150],  # Mount Emu (wrong hemisphere -> Victoria Australia)
    'peak-1596': [-115.069444, 50.733333], # Mount Hood AB (was duplicated onto Mount Packenham)
    'peak-1944': [-118.337500, 36.655833], # Mount Tyndall (was duplicated onto Mount Williamson)
    'peak-269': [84.446111, 28.534167],    # Kangguru (was placed at Kusum Kangguru in Khumbu)
    'peak-63': [89.274167, 27.796111],     # Jichu Drake (was placed at Kangchenjunga)
    'peak-296': [86.790000, 27.790000],    # Thamserku (was placed at Ama Dablam)
    'peak-1353': [9.863100, 46.852200],    # Wisshorn (was placed at Platthorn in Zermatt)
    'peak-1163': [-4.817702, 43.200834],   # Naranjo de Bulnes (Picos de Europa)
    'peak-1164': [-4.835779, 43.204535],   # Neveron De Urriellu (Picos de Europa)
    'peak-2815': [-69.436027, -32.841233], # Cerro Colorado (Mendoza, Argentina)
    'peak-2794': [-73.039572, -49.292767], # Aguja De La S (Patagonia)
    'peak-976': [12.062200, 46.291400],    # Tamer (San Sebastiano group, Dolomites)
    'peak-934': [9.991953, 44.410037],     # Orsaro (Apennines)
    'peak-1949': [-118.499870, 37.102913], # Mount Gayley (Sierra Nevada)
    'peak-1109': [14.659000, 46.363921],   # Ojstrica (Kamnik Alps, Slovenia)
    'peak-763': [10.551868, 47.548626],    # Breitenberg (Pfronten, Allgäu Alps)
    'peak-792': [10.295680, 47.299925],    # Mädelegabel (Allgäu Alps)
    'peak-778': [10.292500, 47.297500],    # Hochfrottspitze (Allgäu Alps)
    'peak-1308': [9.796389, 46.833889],    # Weissfluhgipfel (Davos/Parsenn summit, was mislabeled and 50km off)
    'peak-2873': [-70.214138, -33.236821], # El Plomo (Santiago Andes, Chile — snapped to DEM apex 5,437m)
    'peak-2802': [-70.062904, -32.623328], # Cerro Cuerno (Aconcagua region, Argentina — snapped to DEM apex 5,416m)
    'peak-2827': [-69.455051, -33.015717], # Plata / Cerro El Plata (Mendoza, Argentina — snapped to DEM apex 5,950m)
    'peak-2833': [-71.502972, -39.636761], # Volcan Lanin (Neuquén, Argentina / Chile — snapped to DEM apex 3,735m)
    'peak-2876': [-67.737236, -23.368417], # Lascar (Antofagasta, Chile — snapped to DEM apex 5,594m)
    'peak-2881': [-73.094959, -51.000145], # Paine Grande (Torres del Paine, Chile — snapped to DEM apex 2,647m)
    'peak-2858': [-44.843102, -22.428008], # Pedra Da Mina (Mantiqueira, Brazil — snapped to DEM apex 2,790m)
    'peak-1545': [-124.595089, 49.224100], # Mount Arrowsmith (Vancouver Island, BC — snapped to DEM apex 1,746m)
    'peak-2253': [-105.213490, 36.629994], # Mount Baldy (Wheeler Peak Wilderness, NM — snapped to DEM apex 3,792m)
    'peak-2193': [-113.649960, 48.728681], # Mount Siyeh (Glacier NP, MT — snapped to DEM apex 3,049m)
    'peak-1566': [-115.061016, 50.710048], # Mount Burney (Highwood Range, AB — snapped to DEM apex 2,892m)
    'peak-2422': [-104.880123, 31.929729], # Bush Mountain (Guadalupe Mountains, TX — snapped to DEM apex 2,631m)
    'peak-882': [12.420902, 46.342425],    # Cima dei Preti (Friuli Dolomites, Italy — snapped to DEM apex 2,700m)
    'peak-887': [12.402191, 46.228659],    # Col Nudo (Venetian Prealps, Italy — snapped to DEM apex 2,454m)
    'peak-910': [9.488411, 44.550723],     # Monte Maggiorasca (Ligurian Apennines, Italy — snapped to DEM apex 1,777m)
    'peak-666': [17.053699, 43.342034],    # Sveti Jure (Biokovo, Croatia — snapped to DEM apex 1,754m)
    'peak-657': [24.574013, 41.604918],    # Golyam Perelik (Rhodope Mountains, Bulgaria — snapped to DEM apex 2,178m)
    'peak-1653': [-123.838921, 50.313681], # Mount Tinniswood (Coast Mountains, BC — snapped to DEM apex 2,548m)
    'peak-1809': [-146.302872, 63.543888], # McGinnis Peak (Hayes Range, Alaska — snapped to DEM apex 3,556m)
}

# 2. Redundant sub-peaks, subsidiary horns, passes, and non-peak features
REMOVE_IDS = {
    'peak-1501', # Eisenhower Peak (Castle Mountain subsidiary tower in Banff)
    'peak-560',  # Großer Bruder (Großer Weitschartenkopf subsidiary in Berchtesgaden)
    'peak-1307', # Ostspitze (Monte Rosa / Dufourspitze secondary bump 50m away)
    'peak-1267', # Grenzgipfel (Monte Rosa / Dufourspitze secondary bump 98m away)
    'peak-221',  # Peak Chapayev (Khan Tengri west shoulder 70m away)
    'peak-692',  # Grande Rocheuse (Aiguille Verte secondary point)
    'peak-1230', # Aiguille du Jardin (Aiguille Verte secondary point)
    'peak-945',  # Punta Baretti (Mont Brouillard secondary point)
    'peak-2607', # Meulfire (Indecision Peak duplicate 60m away)
    'peak-1956', # Polemonium Peak (North Palisade sub-peak)
    'peak-1966', # Starlight Peak (North Palisade sub-peak)
    'peak-1974', # Thunderbolt Peak (North Palisade sub-peak)
    'peak-2519', # Concord Tower (Liberty Bell rock tower)
    'peak-2588', # Lexington Tower (Liberty Bell rock tower)
    'peak-2676', # North Early Winters Spire (South Early Winters Spire sub-tower)
    'peak-353',  # Marapara West Peak (Marapara Peak sub-peak)
    'peak-957',  # Roc del Boucher (Punta Ciatagnera sub-peak)
    'peak-1346', # Walcherhorn (Gross Fiescherhorn ridge sub-peak)
    'peak-1303', # Nässihorn (Schreckhorn ridge shoulder)
    'peak-817',  # Wilder Mann (Steinschartenkopf ridge spur)
    'peak-1138', # El Prau Del Fontan (Peña Ubiña ridge sub-peak)
    'peak-2839', # Condor Pusthaña (Kollpani ridge sub-peak)
    'peak-319',  # Karakoram Pass (mountain pass, not a peak)
    'peak-2568', # High Hut Lookout (hiking shelter hut)
    'peak-2718', # Snowbowl Hut Overlook (hiking shelter hut)
    'peak-2576', # Ingalls Peak, South Ridge (climbing route ridge)
    'peak-1502', # Elk Thurston Ridge (hiking trail ridge)
}

TILE_SIZE = 512

def get_elevation_at_global_px(gx, gy):
    tx = int(gx // TILE_SIZE)
    ty = int(gy // TILE_SIZE)
    lx = int(gx % TILE_SIZE)
    ly = int(gy % TILE_SIZE)
    img = get_tile(tx, ty)
    if not img:
        return None
    r, g, b = img.getpixel((lx, ly))
    return (r * 256 + g + b / 256.0) - 32768.0

def is_local_summit(gx, gy, center_elev):
    # Must be >= all 8 immediate neighbors in 3x3 window
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            ne = get_elevation_at_global_px(gx + dx, gy + dy)
            if ne is None or ne > center_elev:
                return False
    # Must be at least 2.0m higher than the minimum of its 5x5 window perimeter
    min_perim = center_elev
    for dx in (-2, -1, 0, 1, 2):
        for dy in (-2, -1, 0, 1, 2):
            if abs(dx) < 2 and abs(dy) < 2:
                continue
            pe = get_elevation_at_global_px(gx + dx, gy + dy)
            if pe is not None and pe < min_perim:
                min_perim = pe
    return (center_elev - min_perim) >= 2.0

def global_px_to_deg(gx, gy):
    lon_deg = (gx / (N * TILE_SIZE)) * 360.0 - 180.0
    y_norm = 1.0 - 2.0 * (gy / (N * TILE_SIZE))
    lat_rad = math.atan(math.sinh(math.pi * y_norm))
    return (round(math.degrees(lat_rad), 6), round(lon_deg, 6))

def haversine_m(lon1, lat1, lon2, lat2):
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return 6371000.0 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def main():
    with open(GEOJSON_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)

    features = data['features']
    print(f"Starting reconciliation of {len(features)} peaks from {GEOJSON_PATH}")

    # Step 1: Apply known coordinate fixes
    for feat in features:
        pid = feat['id']
        if pid in KNOWN_CORRECTIONS:
            feat['geometry']['coordinates'] = list(KNOWN_CORRECTIONS[pid])
            feat['properties']['geodetic_reconciled'] = True
            pname = feat['properties'].get('name', '')
            print(f"  Fixed corrupted coordinate for {pname} ({pid}) -> {KNOWN_CORRECTIONS[pid]}")
        if pid == 'peak-1308':
            feat['properties']['name'] = 'Weissfluhgipfel'
            feat['properties']['elevation_ft'] = 9327
            feat['properties']['elevation_m'] = 2843
            feat['properties']['elevation_formatted_ft'] = "9,327'"
            feat['properties']['elevation_formatted_m'] = "2,843 m"
            feat['properties']['label_ft'] = "▲ Weissfluhgipfel · 9,327'"
            feat['properties']['label_m'] = "▲ Weissfluhgipfel · 2,843 m"
            feat['properties']['label_stacked_ft'] = "▲ Weissfluhgipfel\n9,327'"
            feat['properties']['label_stacked_m'] = "▲ Weissfluhgipfel\n2,843 m"
            print("  Corrected peak-1308 name from 'Parsenn' to 'Weissfluhgipfel'")

    # Step 2: Deduplicate
    features = [f for f in features if f['id'] not in REMOVE_IDS]
    print(f"Features after removing duplicate / sub-peak entries: {len(features)}")

    # Step 3: True 2D Local-Maximum Topographic Apex DEM Snapping
    print("\nExecuting global 2D local-maximum DEM apex snapping across all peaks...")
    t0 = time.time()
    snapped_count = 0
    significant_count = 0

    for feat in features:
        lon, lat = feat['geometry']['coordinates']
        stated_ft = feat['properties']['elevation_ft']
        stated_m = stated_ft / 3.28084
        coarse = is_coarse(lon, lat)

        gx0_f = (lon + 180.0) / 360.0 * N * TILE_SIZE
        lat_rad = math.radians(lat)
        gy0_f = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * N * TILE_SIZE
        gx0 = int(round(gx0_f))
        gy0 = int(round(gy0_f))

        curr_elev = get_elevation_at_global_px(gx0, gy0)
        if curr_elev is None:
            continue

        m_per_px = 40075016.686 * math.cos(lat_rad) / (N * TILE_SIZE)
        radius = 45 if coarse else 22
        max_elev_diff = max(180.0, stated_m * 0.08)

        best_cost = float('inf')
        best_gx = None
        best_gy = None
        best_elev = curr_elev

        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                dist_sq = dx * dx + dy * dy
                if dist_sq > radius * radius:
                    continue
                gx = gx0 + dx
                gy = gy0 + dy
                pelev = get_elevation_at_global_px(gx, gy)
                if pelev is None:
                    continue
                if abs(pelev - stated_m) > max_elev_diff:
                    continue
                if not is_local_summit(gx, gy, pelev):
                    continue

                dist_m = math.sqrt(dist_sq) * m_per_px
                cost = abs(pelev - stated_m) + 0.15 * dist_m
                if cost < best_cost:
                    best_cost = cost
                    best_gx = gx
                    best_gy = gy
                    best_elev = pelev

        if best_gx is not None and (best_gx != gx0 or best_gy != gy0):
            new_lat, new_lon = global_px_to_deg(best_gx, best_gy)
            shift_m = haversine_m(lon, lat, new_lon, new_lat)
            feat['geometry']['coordinates'] = [new_lon, new_lat]
            feat['properties']['geodetic_reconciled'] = True
            feat['properties']['dem_elevation_m'] = round(best_elev, 1)
            feat['properties']['dem_elevation_ft'] = round(best_elev * 3.28084)
            snapped_count += 1
            if shift_m >= 50.0:
                significant_count += 1
        else:
            feat['properties']['dem_elevation_m'] = round(curr_elev, 1)
            feat['properties']['dem_elevation_ft'] = round(curr_elev * 3.28084)

    # Step 4: Post-Reconciliation Quality Filter
    # 4a. Drop Tier 2/3 peaks that still mismatch DEM elevation by > 600 ft
    filtered = []
    dropped_mismatch = 0
    for feat in features:
        p = feat['properties']
        tier = p.get('tier', 3)
        dem_ft = p.get('dem_elevation_ft')
        if tier >= 2 and dem_ft is not None and abs(dem_ft - p['elevation_ft']) > 600:
            dropped_mismatch += 1
            continue
        filtered.append(feat)

    # 4b. Drop duplicate sub-peak bumps within 400m of a higher peak
    filtered.sort(key=lambda f: f['properties'].get('elevation_ft', 0), reverse=True)
    kept = []
    dropped_dups = 0
    for feat in filtered:
        lon, lat = feat['geometry']['coordinates']
        is_dup = False
        for k in kept:
            klon, klat = k['geometry']['coordinates']
            if abs(klat - lat) < 0.01 and abs(klon - lon) < 0.015:
                if haversine_m(lon, lat, klon, klat) < 400.0:
                    is_dup = True
                    break
        if is_dup:
            dropped_dups += 1
        else:
            kept.append(feat)

    features = kept

    t1 = time.time()
    print(f"Apex snapping complete in {t1 - t0:.2f}s!")
    print(f"Total peaks snapped onto true 2D local-max summit: {snapped_count} ({significant_count} shifted >= 50m)")
    print(f"Dropped {dropped_mismatch} mismatched Tier 2/3 hillside peaks (>600ft) and {dropped_dups} duplicate sub-peaks (<400m)")

    data['features'] = features
    with open(GEOJSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"Successfully saved updated {GEOJSON_PATH} ({len(features)} clean peaks).")

if __name__ == '__main__':
    main()
