import { ToolDefinition } from './registry.js';

interface WeatherArgs {
  action: 'summary';
  location: string;
}

interface CurrentBlock {
  temperature_2m?: number;
  apparent_temperature?: number;
  precipitation?: number;
  time?: string;
}

interface HourlyBlock {
  time?: string[];
  temperature_2m?: number[];
  precipitation_probability?: number[];
  precipitation?: number[];
}

interface GeocodeResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

const US_STATES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
};

function parseLocationParts(input: string) {
  const parts = input
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return { city: parts[0] };
  const city = parts[0];
  const region = parts[1];
  const country = parts.length > 2 ? parts.slice(2).join(', ') : undefined;
  return { city, region, country };
}

function normalizeAdmin1(region?: string | null) {
  if (!region) return { value: null, isUsState: false };
  const trimmed = region.trim();
  if (!trimmed) return { value: null, isUsState: false };
  const upper = trimmed.toUpperCase();
  if (US_STATES[upper]) return { value: US_STATES[upper], isUsState: true };
  const match = Object.values(US_STATES).find((state) => state.toLowerCase() === trimmed.toLowerCase());
  if (match) return { value: match, isUsState: true };
  return { value: trimmed, isUsState: false };
}

function normalizeCountry(country?: string | null) {
  if (!country) return null;
  const upper = country.trim().toUpperCase();
  if (!upper) return null;
  if (upper === 'UK') return 'GB';
  if (upper === 'USA' || upper === 'US' || upper === 'UNITED STATES' || upper === 'UNITED STATES OF AMERICA') {
    return 'US';
  }
  return upper.length === 2 ? upper : null;
}

function looksLikeZip(input: string) {
  return /^\d{5}(-\d{4})?$/.test(input.trim());
}

function looksLikeCoords(input: string) {
  const match = input.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

async function geocodeSearch(query: string, country?: string): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({
    name: query,
    count: '10',
    language: 'en',
    format: 'json',
  });
  if (country) params.set('country', country);
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const json = (await res.json()) as { results?: GeocodeResult[] };
  return json.results ?? [];
}

async function geocodeLocation(query: string): Promise<GeocodeResult> {
  const trimmed = query.trim();
  const attempts: Array<{ name: string; country?: string; admin1?: string }> = [];
  attempts.push({ name: trimmed });
  const normalized = trimmed.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized && normalized !== trimmed) attempts.push({ name: normalized });
  const hint = parseLocationParts(trimmed);
  if (hint?.city) {
    const admin1Meta = normalizeAdmin1(hint.region ?? null);
    const country = normalizeCountry(hint.country ?? null) ?? (admin1Meta.isUsState ? 'US' : undefined);
    if (country || admin1Meta.value) {
      attempts.push({ name: hint.city, country, admin1: admin1Meta.value ?? undefined });
    }
    if (hint.region && !hint.country) {
      const maybeCountry = normalizeCountry(hint.region);
      if (maybeCountry && maybeCountry !== country) {
        attempts.push({ name: hint.city, country: maybeCountry });
      }
    }
    const combined = [hint.city, hint.region, hint.country].filter(Boolean).join(' ');
    if (combined && combined !== trimmed) attempts.push({ name: combined });
    if (hint.country && !country) {
      const combinedCountry = [hint.city, hint.country].filter(Boolean).join(' ');
      if (combinedCountry && combinedCountry !== combined) attempts.push({ name: combinedCountry });
    }
  } else {
    const tailCode = trimmed.match(/^(.*?)[\s]+([A-Za-z]{2})$/);
    if (tailCode) {
      const city = tailCode[1].trim();
      const code = normalizeCountry(tailCode[2]);
      if (city && code) attempts.push({ name: city, country: code });
    }
  }
  if (looksLikeZip(trimmed)) attempts.push({ name: trimmed, country: 'US' });

  const seen = new Set<string>();
  for (const attempt of attempts) {
    const key = `${attempt.name}|${attempt.country ?? ''}|${attempt.admin1 ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let results: GeocodeResult[] = [];
    try {
      results = await geocodeSearch(attempt.name, attempt.country);
    } catch {
      continue;
    }
    if (!results.length) continue;
    if (attempt.admin1) {
      const match = results.find((r) => (r.admin1 ?? '').toLowerCase() === attempt.admin1!.toLowerCase());
      if (match) return match;
      continue;
    }
    return results[0];
  }

  throw new Error(`No location match for "${query}". Try a ZIP code or "City, Region, Country".`);
}

async function fetchCityByCoords(name: string, lat: number, lon: number) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,apparent_temperature,precipitation' +
    '&hourly=temperature_2m,precipitation_probability,precipitation' +
    '&forecast_hours=24&timezone=auto' +
    '&temperature_unit=fahrenheit&precipitation_unit=inch';

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather fetch failed for ${name}: ${res.status}`);
  const json = (await res.json()) as {
    current?: CurrentBlock;
    hourly?: HourlyBlock;
  };
  return { name, ...json };
}

function summarizeCity(current: CurrentBlock | undefined, hourly: HourlyBlock | undefined, name: string) {
  const temp = current?.temperature_2m;
  const feels = current?.apparent_temperature;
  const precipNow = current?.precipitation ?? 0;

  let maxProb = 0;
  let totalPrecip = 0;
  if (hourly?.precipitation_probability && hourly.precipitation_probability.length) {
    maxProb = Math.max(...hourly.precipitation_probability.slice(0, 12)); // next ~12h
  }
  if (hourly?.precipitation && hourly.precipitation.length) {
    totalPrecip = hourly.precipitation.slice(0, 12).reduce((a, b) => a + (b ?? 0), 0);
  }

  const parts = [];
  if (typeof temp === 'number') parts.push(`now ${temp.toFixed(0)}°F`);
  if (typeof feels === 'number') parts.push(`feels ${feels.toFixed(0)}°F`);
  parts.push(`precip now ${precipNow.toFixed(2)} in/hr`);
  parts.push(`next 12h precip chance ${maxProb}%`);
  parts.push(`12h total precip ${totalPrecip.toFixed(2)} in`);

  return `${name}: ${parts.join(', ')}`;
}

export function weatherTool(): ToolDefinition {
  return {
    name: 'weather',
    description: 'Summarize current and near-term weather for any location.',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['summary'] },
        location: { type: 'string' },
      },
      required: ['action', 'location'],
      additionalProperties: false,
    },
    handler: async (args: WeatherArgs) => {
      if (args.action !== 'summary') throw new Error('Unsupported action');
      const coords = looksLikeCoords(args.location);
      if (coords) {
        const name = `Coordinates ${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`;
        const result = await fetchCityByCoords(name, coords.lat, coords.lon);
        return summarizeCity(result.current, result.hourly, name);
      }
      const geo = await geocodeLocation(args.location);
      const name = [geo.name, geo.admin1, geo.country].filter(Boolean).join(', ');
      const result = await fetchCityByCoords(name, geo.latitude, geo.longitude);
      return summarizeCity(result.current, result.hourly, name);
    },
  };
}
