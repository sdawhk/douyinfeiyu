import test from 'node:test';
import assert from 'node:assert/strict';
import { isDailyTaskDue, localDayKey } from '../src/daily-task.mjs';

test('daily task waits for configured local time and runs at most once after success', () => {
  const schedule = { enabled: true, time: '10:00' };
  assert.equal(isDailyTaskDue(schedule, new Date(2026, 9, 24, 9, 59), ''), false);
  assert.equal(isDailyTaskDue(schedule, new Date(2026, 9, 24, 10, 0), ''), true);
  assert.equal(isDailyTaskDue(schedule, new Date(2026, 9, 24, 17, 0), '2026-10-24'), false);
  assert.equal(isDailyTaskDue({ ...schedule, enabled: false }, new Date(2026, 9, 24, 17, 0), ''), false);
  assert.equal(localDayKey(new Date(2026, 9, 24, 17, 0)), '2026-10-24');
});
