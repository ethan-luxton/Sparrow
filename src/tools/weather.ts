import { ToolDefinition } from './registry.js';

type CityKey = 'seattle' | 'bellevue' | 'bothell';

const cities: Record<
  CityKey,
  { name: string; lat: number; lon: number }
> = {
  seattle: { name: 'Seattle, WA', lat: 47.6062, lon: -122.3321 },
  bellevue: { name: 'Bellevue, WA', lat: 47.6104, lon: -122.2007 },
  bothell: { name: 'Bothell, WA', lat: 47.7601, lon: -122.2056 },
};

interface WeatherArgs {
  action: 'metro_summary';
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

async function fetchCity(key: CityKey) {
  const c = cities[key];
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
    '&current=temperature_2m,apparent_temperature,precipitation' +
    '&hourly=temperature_2m,precipitation_probability,precipitation' +
    '&forecast_hours=24&timezone=auto' +
    '&temperature_unit=fahrenheit&precipitation_unit=inch';

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather fetch failed for ${c.name}: ${res.status}`);
  const json = (await res.json()) as {
    current?: CurrentBlock;
    hourly?: HourlyBlock;
  };
  return { meta: c, ...json };
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
    description: 'Summarize current and near-term weather for Seattle/Bellevue/Bothell metro area.',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['metro_summary'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args: WeatherArgs) => {
      if (args.action !== 'metro_summary') throw new Error('Unsupported action');
      const results = await Promise.all([fetchCity('seattle'), fetchCity('bellevue'), fetchCity('bothell')]);
      const lines = results.map((r) => summarizeCity(r.current, r.hourly, r.meta.name));
      return lines.join('\n');
    },
  };
}
