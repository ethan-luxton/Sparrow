import type Database from 'better-sqlite3';
import { getDbHandle } from '../lib/db.js';
import { initLedger } from './ledger.js';

export interface WorkingState {
  objective: string;
  constraints: string[];
  hypotheses: string[];
  lastObservations: string[];
  nextActions: string[];
}

export function defaultWorkingState(): WorkingState {
  return {
    objective: '',
    constraints: [],
    hypotheses: [],
    lastObservations: [],
    nextActions: [],
  };
}

function normalizeState(input: Partial<WorkingState>): WorkingState {
  const base = defaultWorkingState();
  return {
    objective: input.objective ?? base.objective,
    constraints: Array.isArray(input.constraints) ? input.constraints : base.constraints,
    hypotheses: Array.isArray(input.hypotheses) ? input.hypotheses : base.hypotheses,
    lastObservations: Array.isArray(input.lastObservations) ? input.lastObservations : base.lastObservations,
    nextActions: Array.isArray(input.nextActions) ? input.nextActions : base.nextActions,
  };
}

export function getWorkingState(chatId: number, db: Database.Database = getDbHandle()): WorkingState {
  initLedger(db);
  const row = db.prepare('SELECT state FROM working_state WHERE chatId = ?').get(chatId) as { state: string } | undefined;
  if (!row?.state) return defaultWorkingState();
  try {
    const parsed = JSON.parse(row.state) as Partial<WorkingState>;
    return normalizeState(parsed);
  } catch {
    return defaultWorkingState();
  }
}

export function saveWorkingState(chatId: number, state: WorkingState, db: Database.Database = getDbHandle()) {
  initLedger(db);
  db.prepare(
    'INSERT INTO working_state (chatId, state, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(chatId) DO UPDATE SET state=excluded.state, updatedAt=CURRENT_TIMESTAMP'
  ).run(chatId, JSON.stringify(state));
}

export function mergeWorkingState(
  current: WorkingState,
  patch: Partial<WorkingState>,
  opts?: { maxObservations?: number; maxNextActions?: number; maxHypotheses?: number }
): WorkingState {
  const maxObservations = opts?.maxObservations ?? 6;
  const maxNextActions = opts?.maxNextActions ?? 6;
  const maxHypotheses = opts?.maxHypotheses ?? 6;
  const merged: WorkingState = {
    objective: patch.objective ?? current.objective,
    constraints: patch.constraints ?? current.constraints,
    hypotheses: patch.hypotheses ?? current.hypotheses,
    lastObservations: patch.lastObservations ?? current.lastObservations,
    nextActions: patch.nextActions ?? current.nextActions,
  };
  merged.lastObservations = merged.lastObservations.slice(-maxObservations);
  merged.nextActions = merged.nextActions.slice(-maxNextActions);
  merged.hypotheses = merged.hypotheses.slice(-maxHypotheses);
  return merged;
}
