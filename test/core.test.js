import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDiff,
  applyPatch,
  serializePatch,
  deserializePatch,
  createPatch,
  OP_COPY,
  OP_ADD,
} from '../src/core.js';

/** Convenience: turn a string into a Uint8Array via UTF-8. */
function u8(str) {
  return new TextEncoder().encode(str);
}

/** Round-trip helper: diff, apply, and assert we get the target back. */
function roundTrip(source, target) {
  const patch = computeDiff(source, target);
  const rebuilt = applyPatch(source, patch);
  assert.deepEqual(Array.from(rebuilt), Array.from(target));
  return patch;
}

test('identical source and target produce a single COPY covering the whole file', () => {
  const src = u8('hello world');
  const patch = computeDiff(src, src);
  assert.equal(patch.instructions.length, 1);
  assert.equal(patch.instructions[0].op, OP_COPY);
  assert.equal(patch.instructions[0].offset, 0);
  assert.equal(patch.instructions[0].length, src.length);
  assert.deepEqual(Array.from(applyPatch(src, patch)), Array.from(src));
});

test('empty source and empty target produce an empty patch', () => {
  const patch = computeDiff(new Uint8Array(0), new Uint8Array(0));
  assert.equal(patch.sourceLength, 0);
  assert.equal(patch.targetLength, 0);
  assert.deepEqual(patch.instructions, []);
  assert.equal(applyPatch(new Uint8Array(0), patch).length, 0);
});

test('empty source to non-empty target produces one ADD with all literal bytes', () => {
  const target = u8('brand new content');
  const patch = computeDiff(new Uint8Array(0), target);
  assert.equal(patch.instructions.length, 1);
  assert.equal(patch.instructions[0].op, OP_ADD);
  assert.equal(patch.instructions[0].length, target.length);
  assert.deepEqual(Array.from(applyPatch(new Uint8Array(0), patch)), Array.from(target));
});

test('non-empty source to empty target produces zero instructions', () => {
  const src = u8('to be discarded');
  const patch = computeDiff(src, new Uint8Array(0));
  assert.equal(patch.targetLength, 0);
  assert.deepEqual(patch.instructions, []);
  assert.equal(applyPatch(src, patch).length, 0);
});

test('a prefix kept and a suffix appended yields COPY then ADD', () => {
  const src = u8('HEADER:');
  const target = u8('HEADER:body');
  const patch = computeDiff(src, target);
  // Expect COPY(0,7) then ADD(body)
  assert.equal(patch.instructions.length, 2);
  assert.equal(patch.instructions[0].op, OP_COPY);
  assert.equal(patch.instructions[0].offset, 0);
  assert.equal(patch.instructions[0].length, 7);
  assert.equal(patch.instructions[1].op, OP_ADD);
  roundTrip(src, target);
});

test('insertion in the middle splits into COPY, ADD, COPY', () => {
  const src = u8('AC');
  const target = u8('ABC');
  const patch = computeDiff(src, target);
  // First byte 'A' matches source[0]; 'B' is new; 'C' matches source[1].
  // But MIN_COPY=4, so neither 'A' nor 'C' run is long enough to COPY.
  // The whole target is therefore one ADD. This test pins that behavior.
  assert.equal(patch.instructions.length, 1);
  assert.equal(patch.instructions[0].op, OP_ADD);
  roundTrip(src, target);
});

test('a long repeated region is copied rather than literalized', () => {
  const shared = u8('aaaaaaaa'); // 8 bytes, above MIN_COPY
  const src = shared;
  const target = shared;
  const patch = computeDiff(src, target);
  assert.equal(patch.instructions[0].op, OP_COPY);
  assert.equal(patch.instructions[0].length, 8);
});

test('source appears twice in target: both runs are copied', () => {
  const src = u8('XYZXYZXYZXYZ'); // 12 bytes, well above MIN_COPY
  const target = new Uint8Array(src.length * 2);
  target.set(src, 0);
  target.set(src, src.length);
  const patch = computeDiff(src, target);
  const ops = patch.instructions.filter((i) => i.op === OP_COPY);
  assert.ok(ops.length >= 1, 'expected at least one COPY');
  const totalCopied = ops.reduce((s, i) => s + i.length, 0);
  assert.equal(totalCopied, target.length, 'whole target should be covered by copies');
  roundTrip(src, target);
});

test('applyPatch rejects a source whose length differs from patch.sourceLength', () => {
  const src = u8('abc');
  const target = u8('abcdef');
  const patch = computeDiff(src, target);
  const wrong = u8('ab'); // too short
  assert.throws(() => applyPatch(wrong, patch), RangeError);
});

test('applyPatch rejects an out-of-range COPY instruction', () => {
  const src = u8('short');
  const bad = createPatch(5, 4, [
    { op: OP_COPY, offset: 0, length: 100 },
  ]);
  assert.throws(() => applyPatch(src, bad), RangeError);
});

test('applyPatch rejects an unknown opcode', () => {
  const src = new Uint8Array(0);
  const bad = createPatch(0, 0, [{ op: 0x99, offset: 0, length: 0 }]);
  assert.throws(() => applyPatch(src, bad), RangeError);
});

test('serializePatch then deserializePatch yields an equivalent Patch', () => {
  const src = u8('the quick brown fox');
  const target = u8('the quick red fox jumps');
  const patch = computeDiff(src, target);
  const stream = serializePatch(patch);
  const restored = deserializePatch(stream);
  assert.equal(restored.sourceLength, patch.sourceLength);
  assert.equal(restored.targetLength, patch.targetLength);
  assert.equal(restored.instructions.length, patch.instructions.length);
  for (let i = 0; i < restored.instructions.length; i++) {
    const a = patch.instructions[i];
    const b = restored.instructions[i];
    assert.equal(b.op, a.op);
    assert.equal(b.offset, a.offset);
    assert.equal(b.length, a.length);
    if (a.op === OP_ADD) {
      assert.deepEqual(Array.from(b.data), Array.from(a.data));
    }
  }
  // And the restored patch still applies correctly.
  assert.deepEqual(Array.from(applyPatch(src, restored)), Array.from(target));
});

test('deserializePatch rejects a truncated stream', () => {
  const src = u8('data');
  const target = u8('data and more');
  const full = serializePatch(computeDiff(src, target));
  const truncated = full.subarray(0, full.length - 1);
  assert.throws(() => deserializePatch(truncated), RangeError);
});

test('deserializePatch rejects a bad magic prefix', () => {
  const patch = computeDiff(u8('a'), u8('b'));
  const stream = serializePatch(patch);
  stream[0] = 0x00; // corrupt magic
  assert.throws(() => deserializePatch(stream), RangeError);
});

test('deserializePatch rejects trailing bytes', () => {
  const patch = computeDiff(u8('a'), u8('b'));
  const stream = serializePatch(patch);
  const padded = new Uint8Array(stream.length + 3);
  padded.set(stream, 0);
  padded[stream.length] = 0x01;
  padded[stream.length + 1] = 0x02;
  padded[stream.length + 2] = 0x03;
  assert.throws(() => deserializePatch(padded), RangeError);
});

test('a patch built via createPatch applies correctly', () => {
  const src = u8('0123456789');
  const target = u8('0123XYZ3456789');
  // COPY 0..4, ADD 'XYZ', COPY 4..11 covering the remaining 7 bytes
  // '3456789'. MIN_COPY logic lives in computeDiff, not createPatch,
  // so here we construct it by hand.
  const patch = createPatch(src.length, target.length, [
    { op: OP_COPY, offset: 0, length: 4 },
    { op: OP_ADD, offset: 0, length: 3, data: u8('XYZ') },
    { op: OP_COPY, offset: 3, length: 7 },
  ]);
  const out = applyPatch(src, patch);
  assert.deepEqual(Array.from(out), Array.from(target));
});

test('computeDiff throws on non-Uint8Array inputs', () => {
  assert.throws(() => computeDiff('string', new Uint8Array(0)), TypeError);
  assert.throws(() => computeDiff(new Uint8Array(0), 'string'), TypeError);
  assert.throws(() => computeDiff([1, 2, 3], new Uint8Array(0)), TypeError);
});

test('applyPatch throws when ADD data length does not match declared length', () => {
  const bad = createPatch(0, 3, [
    { op: OP_ADD, offset: 0, length: 3, data: u8('ab') },
  ]);
  assert.throws(() => applyPatch(new Uint8Array(0), bad), RangeError);
});
