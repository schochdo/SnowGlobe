import type { DailyForecast, ResortWeatherData, SkiResort } from '../types';

/* =========================================================================
   REAL WEATHER ENGINE (OPEN-METEO) WITH 24-HOUR CACHING & CIRCUIT BREAKER
   - 24-hour cache TTL: Once a day is more than enough; never hammer the API.
   - Genuine Data Guarantee: ONLY successful Open-Meteo API responses are
     cached as fresh 24h forecasts. Fallback estimates never poison the cache.
   - Automatic 24-hour circuit breaker: If HTTP 429 or daily limit is hit,
     all network requests to Open-Meteo are suspended immediately for 24h.
   ========================================================================= */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (once per day)
const CACHE_PREFIX = 'snowglobe_wx_v3_'; // v3: only genuine Open-Meteo responses are cached as fresh
const CIRCUIT_BREAKER_KEY = 'snowglobe_wx_circuit_tripped_until';
const CIRCUIT_TRIP_MS = 24 * 60 * 60 * 1000; // Suspend for 24 hours on limit

interface CachePayload {
  timestamp: number;
  isRealApi: boolean;
  data: ResortWeatherData;
}

export function isWeatherCircuitTripped(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    const raw = window.localStorage.getItem(CIRCUIT_BREAKER_KEY);
    if (!raw) return false;
    const until = parseInt(raw, 10);
    if (isNaN(until)) return false;
    if (Date.now() < until) {
      return true;
    }
    // Expired; clear it
    window.localStorage.removeItem(CIRCUIT_BREAKER_KEY);
    return false;
  } catch {
    return false;
  }
}

export function tripWeatherCircuit(durationMs: number = CIRCUIT_TRIP_MS): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const until = Date.now() + durationMs;
    window.localStorage.setItem(CIRCUIT_BREAKER_KEY, until.toString());
    console.warn(
      `[Snow Globe Weather] Circuit breaker tripped until ${new Date(until).toISOString()}. Network queries to Open-Meteo suspended to protect API quotas.`
    );
  } catch {
    // Quota limits or private browsing
  }
}

export function getCachedWeather(resortId: string): ResortWeatherData | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + resortId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachePayload;
    if (!parsed || !parsed.data) return null;
    return parsed.data as ResortWeatherData;
  } catch {
    return null;
  }
}

export function isCachedWeatherFresh(resortId: string): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + resortId);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as CachePayload;
    // Only real API responses are treated as fresh daily cache
    if (!parsed || !parsed.isRealApi || typeof parsed.timestamp !== 'number') return false;
    return Date.now() - parsed.timestamp < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

export function saveCachedWeather(resortId: string, data: ResortWeatherData, isRealApi: boolean = false): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const payload: CachePayload = {
      timestamp: Date.now(),
      isRealApi,
      data,
    };
    window.localStorage.setItem(
      CACHE_PREFIX + resortId,
      JSON.stringify(payload)
    );
  } catch {
    // Quota limits or private browsing
  }
}

export function getNeutralWeather(resort: SkiResort, statusText: string = 'Checking Open-Meteo...'): ResortWeatherData {
  const elev = resort.summit_elev_ft || 8000;
  const baseTempF = Math.round(30 - (elev / 1000) * 1.5);
  return {
    snowfall_72h_in: 0,
    snowfall_7d_in: 0,
    snowfall_72h_cm: 0,
    snowfall_7d_cm: 0,
    current_temp_f: baseTempF,
    current_temp_c: Math.round(((baseTempF - 32) * 5) / 9),
    summit_wind_gust_mph: 0,
    freezing_level_ft: Math.max(0, elev - 2500),
    rain_to_base_risk: false,
    daily_forecast: [],
    is_live: false,
    last_updated: statusText,
  };
}

/**
 * Returns initial weather data on startup:
 * Uses fresh real Open-Meteo cache if present, otherwise neutral placeholder
 * so resort cards render cleanly while background prefetch loads authentic data.
 */
export function getInitialWeather(resort: SkiResort): ResortWeatherData {
  const cached = getCachedWeather(resort.id);
  if (cached && cached.is_live) {
    return cached;
  }
  return getNeutralWeather(resort);
}

export async function fetchLiveWeather(resort: SkiResort): Promise<ResortWeatherData | null> {
  // 1. If fresh real Open-Meteo cache exists (< 24 hours), return it immediately without network request
  if (isCachedWeatherFresh(resort.id)) {
    const cached = getCachedWeather(resort.id);
    if (cached) return cached;
  }

  // 2. If circuit breaker is active, do not hit network at all
  if (isWeatherCircuitTripped()) {
    const cached = getCachedWeather(resort.id);
    if (cached && cached.is_live) return cached;
    return getNeutralWeather(resort, 'Weather unavailable');
  }

  // 3. Attempt live satellite & model forecast from Open-Meteo
  try {
    const summitElevFt = resort.summit_elev_ft || (resort.base_elev_ft ? resort.base_elev_ft + 2000 : 3000);
    const summitElevM = Math.round(summitElevFt * 0.3048);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${resort.lat}&longitude=${resort.lng}&elevation=${summitElevM}&current=temperature_2m,wind_gusts_10m&hourly=snowfall,freezing_level_height,wind_gusts_10m,temperature_2m&daily=snowfall_sum,temperature_2m_max,temperature_2m_min&timezone=auto`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.status === 429) {
      // Rate limit hit: Trip circuit breaker immediately for 24h to avoid hammering
      tripWeatherCircuit();
      const cached = getCachedWeather(resort.id);
      if (cached && cached.is_live) return cached;
      return getNeutralWeather(resort, 'Weather unavailable');
    }

    if (!res.ok) {
      try {
        const errJson = await res.json();
        if (errJson?.error && (errJson?.reason?.toLowerCase().includes('limit') || errJson?.reason?.toLowerCase().includes('tomorrow'))) {
          tripWeatherCircuit();
        }
      } catch {}
      const cached = getCachedWeather(resort.id);
      if (cached && cached.is_live) return cached;
      return getNeutralWeather(resort, 'Weather unavailable');
    }

    const data = await res.json();
    if (data?.error) {
      if (data?.reason?.toLowerCase().includes('limit')) {
        tripWeatherCircuit();
      }
      const cached = getCachedWeather(resort.id);
      if (cached && cached.is_live) return cached;
      return getNeutralWeather(resort, 'Weather unavailable');
    }

    const hourlySnow: number[] = data?.hourly?.snowfall || [];
    const nowHourIdx = Math.max(0, Math.min((hourlySnow.length || 1) - 1, new Date().getHours()));
    let snow72cm = 0;
    const endIdx = Math.min(nowHourIdx + 72, hourlySnow.length);
    for (let i = nowHourIdx; i < endIdx; i++) {
      snow72cm += hourlySnow[i] || 0;
    }
    const snow72in = Math.round((snow72cm / 2.54) * 10) / 10;

    const dailySnow: number[] = data?.daily?.snowfall_sum || [];
    const snow7dCm = dailySnow.reduce((a, b) => a + (b || 0), 0);
    const snow7dIn = Math.round((snow7dCm / 2.54) * 10) / 10;

    const daily_forecast: DailyForecast[] = (data?.daily?.time || []).map((t: string, idx: number) => {
      const cm = Math.round((data.daily.snowfall_sum?.[idx] || 0) * 10) / 10;
      const inches = Math.round((cm / 2.54) * 10) / 10;
      const tMaxC = Math.round(data.daily.temperature_2m_max?.[idx] || 0);
      const tMinC = Math.round(data.daily.temperature_2m_min?.[idx] || 0);
      return {
        date: t,
        snowfall_in: inches,
        snowfall_cm: cm,
        temp_max_f: Math.round((tMaxC * 9) / 5 + 32),
        temp_min_f: Math.round((tMinC * 9) / 5 + 32),
        temp_max_c: tMaxC,
        temp_min_c: tMinC,
      };
    });

    const curTempC = Math.round(data?.current?.temperature_2m ?? data?.hourly?.temperature_2m?.[nowHourIdx] ?? 0);
    const curTempF = Math.round((curTempC * 9) / 5 + 32);
    const curWindKmh = data?.current?.wind_gusts_10m ?? data?.hourly?.wind_gusts_10m?.[nowHourIdx] ?? 0;
    const curFreezingM = data?.hourly?.freezing_level_height?.[nowHourIdx] ?? 2500;

    const liveData: ResortWeatherData = {
      snowfall_72h_in: snow72in,
      snowfall_7d_in: snow7dIn,
      snowfall_72h_cm: Math.round(snow72cm * 10) / 10,
      snowfall_7d_cm: Math.round(snow7dCm * 10) / 10,
      current_temp_f: curTempF,
      current_temp_c: curTempC,
      summit_wind_gust_mph: Math.round(curWindKmh * 0.621371),
      freezing_level_ft: Math.round(curFreezingM * 3.28084),
      rain_to_base_risk: Boolean(curTempC > 1.5 && (hourlySnow[nowHourIdx] || 0) > 0),
      daily_forecast,
      is_live: true,
      last_updated: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    // ONLY cache as fresh when it is genuine Open-Meteo data!
    saveCachedWeather(resort.id, liveData, true);
    return liveData;
  } catch {
    // Network failure, timeout, or abort
    const cached = getCachedWeather(resort.id);
    if (cached && cached.is_live) return cached;
    return getNeutralWeather(resort, 'Weather unavailable');
  }
}
