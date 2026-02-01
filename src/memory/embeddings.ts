import crypto from 'node:crypto';

export const DEFAULT_EMBED_DIM = 128;

function normalize(vec: number[]) {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  if (sumSq === 0) return vec;
  const norm = Math.sqrt(sumSq);
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

export function embedText(text: string, dims: number = DEFAULT_EMBED_DIM): number[] {
  const vec = new Array(dims).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
  for (const token of tokens) {
    const hash = crypto.createHash('sha256').update(token).digest();
    const idx = hash.readUInt32BE(0) % dims;
    const sign = (hash[4] ?? 0) % 2 === 0 ? 1 : -1;
    const magnitude = ((hash[5] ?? 0) % 3) + 1;
    vec[idx] += sign * magnitude;
  }
  return normalize(vec);
}
