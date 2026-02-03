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

async function geocodeLocation(query: string): Promise<GeocodeResult> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const json = (await res.json()) as { results?: GeocodeResult[] };
  const first = json.results?.[0];
  if (!first) throw new Error(`No location match for "${query}".`);
  return first;
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
      const geo = await geocodeLocation(args.location);
      const name = [geo.name, geo.admin1, geo.country].filter(Boolean).join(', ');
      const result = await fetchCityByCoords(name, geo.latitude, geo.longitude);
      return summarizeCity(result.current, result.hourly, name);
    },
  };
}
