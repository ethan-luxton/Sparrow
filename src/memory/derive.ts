import type { MemoryKind } from './ledger.js';

export interface DerivedFact {
  kind: MemoryKind;
  text: string;
}

export function deriveFactsFromMessage(message: string): DerivedFact[] {
  const facts: DerivedFact[] = [];
  const prefMatch = message.match(/(?:i\s+prefer|my\s+preference\s+is)\s+([^.\n]+)/i);
  if (prefMatch?.[1]) {
    facts.push({ kind: 'preference', text: `Preference: ${prefMatch[1].trim()}` });
  }
  const tzMatch = message.match(/my\s+(?:timezone|time\s*zone)\s+is\s+([^.\n]+)/i);
  if (tzMatch?.[1]) {
    facts.push({ kind: 'preference', text: `Timezone: ${tzMatch[1].trim()}` });
  }
  const nameMatch = message.match(/call\s+me\s+([^.\n]+)/i);
  if (nameMatch?.[1]) {
    facts.push({ kind: 'preference', text: `Preferred name: ${nameMatch[1].trim()}` });
  }
  return facts;
}
