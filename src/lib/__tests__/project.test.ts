import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProjectName, inferProjectName } from '../workspace.js';

test('default project name is deterministic', () => {
  const name = defaultProjectName(new Date('2026-02-01T12:00:00Z'));
  assert.equal(name, 'scratch-20260201');
});

test('infer project name from message', () => {
  const name = inferProjectName('Create a project called sparrow-telegram for a bot');
  assert.equal(name, 'sparrow-telegram');
});
