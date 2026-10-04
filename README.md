# binary-file-diff

Computes byte-level differences between two `Uint8Array` files and produces a patch that can be applied to recreate the target. Pure ESM, zero dependencies.

## Usage

```js
import {
  computeDiff,
  applyPatch,
  serializePatch,
  deserializePatch,
} from 'binary-file-diff';

const source = new TextEncoder().encode('hello world');
const target = new TextEncoder().encode('hello there');

const patch = computeDiff(source, target);
const rebuilt = applyPatch(source, patch);        // Uint8Array equal to `target`

const bytes = serializePatch(patch);              // Uint8Array you can store/send
const again = deserializePatch(bytes);            // structurally identical Patch
```

A `Patch` is a plain object: `{ sourceLength, targetLength, instructions[] }`.
Each instruction is either `{ op: OP_COPY, offset, length }` (copy `length` bytes
from `source[offset]`) or `{ op: OP_ADD, offset: 0, length, data: Uint8Array }`
(emit `length` literal bytes).

## Why this exists

The problem is straightforward: given two versions of a binary blob, store or
transmit only what changed. Existing formats (VCDiff, GDIFF, bsdiff) are either
complex to implement correctly or tuned for very large files via suffix arrays.
This library targets the middle ground — files from a few KB to a few MB where
a simple, inspectable instruction stream is more valuable than optimal size.

The trade-off is patch size for unrelated data: if `source` and `target` share
no runs of 4 or more bytes, the patch is roughly `target.length` plus a small
header. That is acceptable for the intended use case and keeps the code small.

## Edge you will hit

`computeDiff` uses a greedy longest-match strategy with a minimum copy length of
**4 bytes**. A run of 3 identical bytes between source and target will *not* be
encoded as a COPY — it will appear as literal ADD bytes, because a COPY
instruction costs 8 bytes of offset+length and would be larger than the literal.
This is intentional, not a bug. If you need sub-4-byte deduplication, this is
not the right library.

The serialized format uses 4-byte little-endian integers for offsets and
lengths, so source and target are capped at 4 GiB. Patch application is strict:
a source whose length does not match `patch.sourceLength` throws `RangeError`,
rather than silently producing a corrupt target.
