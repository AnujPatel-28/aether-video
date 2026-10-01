import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignTimeMs, normalizeEditOperation } from '@aether/core';

for (const [requestedMs, effectiveMs] of [[0, 0], [1, 0], [19, 0], [20, 0], [21, 40], [39, 40], [40, 40], [60, 40], [61, 80], [1020, 1000]]) {
  test(`nearest-frame alignment ${requestedMs} -> ${effectiveMs}, ties earlier`, () => {
    assert.deepEqual(alignTimeMs(requestedMs), { ok: true, requestedMs, effectiveMs, deltaMs: effectiveMs! - requestedMs! });
  });
}
test('normalization rejects invalid timing and safe-integer rounding overflow', () => {
  for (const time of [-1, 1.2, NaN, Infinity, '40', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER]) {
    const result = alignTimeMs(time);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'timing_alignment');
  }
  assert.deepEqual(alignTimeMs(-0), { ok: true, requestedMs: 0, effectiveMs: 0, deltaMs: 0 });
});
test('trim receipts retain requested/effective ranges and report collapsed alignment', () => {
  const input = { operationId: 'trim', type: 'trim', clipId: 'A', sourceRange: { startMs: 201, endMs: 819 } };
  const result = normalizeEditOperation(input);
  assert.ok(result.ok);
  assert.deepEqual(result.requested, input);
  assert.deepEqual(result.effective, { ...input, sourceRange: { startMs: 200, endMs: 800 } });
  assert.deepEqual(result.alignments, [
    { field: 'sourceRange.startMs', requestedMs: 201, effectiveMs: 200, deltaMs: -1 },
    { field: 'sourceRange.endMs', requestedMs: 819, effectiveMs: 800, deltaMs: -19 },
  ]);
  const collapsed = normalizeEditOperation({ ...input, sourceRange: { startMs: 1, endMs: 19 } });
  assert.ok(!collapsed.ok);
  assert.equal(collapsed.error.code, 'timing_alignment');
  assert.ok(!normalizeEditOperation({ ...input, hidden: 'sentinel' }).ok);
});
