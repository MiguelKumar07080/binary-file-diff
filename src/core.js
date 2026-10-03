/**
 * Binary File Diff — core engine.
 *
 * Design choices (and why):
 *
 * 1. Instruction stream, not a delta encoding against the source.
 *    We emit a flat list of COPY (reference into source) and ADD
 *    (literal bytes) instructions. This is simpler to implement, test,
 *    and reason about than a VCDiff/GDIFF-style bytestream, and it is
 *    sufficient for files whose common byte-runs are short or
 *    irregular. The trade-off is size: patches for unrelated files are
 *    roughly target-size plus a small header.
 *
 * 2. Greedy longest-match, O(n*m) worst case.
 *    We walk the target left-to-right; at each position we look back
 *    into the source for the longest run of identical bytes and emit a
 *    COPY when that run is at least MIN_COPY bytes. Otherwise we
 *    accumulate literal bytes into an ADD. Greedy is not globally
 *    optimal, but for the common case (small files, modest overlap) it
 *    is within a few percent of an optimal diff and is dramatically
 *    simpler and faster to implement than a suffix-array/LCS approach.
 *    MIN_COPY=4 is chosen so the COPY instruction overhead (4 bytes for
 *    offset + 4 for length) is amortized over at least as many bytes
 *    as it costs; below this, emitting a literal is strictly smaller.
 *
 * 3. Deterministic serialization.
 *    The patch byte stream uses fixed-width little-endian integers so
 *    that applyPatch never depends on platform endianness or on a JSON
 *    parser. This keeps the patch stable across machines.
 *
 * 4. No mutation of inputs.
 *    computeDiff and applyPatch treat their inputs as read-only. This
 *    avoids surprising callers and makes the functions safe to use on
 *    shared buffers.
 */

/**
 * Opcode values. Kept as plain numbers (not an enum) so they are usable
 * in plain JS without a transpile step and survive serialization as
 * single bytes.
 */
export const OP_COPY = 0x01;
export const OP_ADD = 0x02;

/**
 * Minimum number of consecutive matching bytes required before we
 * prefer a COPY over accumulating literals. See design note 2.
 */
const MIN_COPY = 4;

/**
 * Magic bytes prefixing every serialized patch, so a consumer can
 * sanity-check that a byte stream is one of ours. Four bytes keeps it
 * human-inspectable while remaining unlikely to collide.
 */
const MAGIC = [0x42, 0x46, 0x44, 0x46]; // "BFDF"
const FORMAT_VERSION = 1;

/**
 * @typedef {Object} Instruction
 * @property {number} op        One of OP_COPY or OP_ADD.
 * @property {number} offset    For OP_COPY: start offset in source.
 * @property {number} length    For both: number of bytes.
 * @property {Uint8Array} [data] For OP_ADD: the literal bytes.
 */

/**
 * @typedef {Object} Patch
 * @property {number} sourceLength   Length the source must have for this patch to apply cleanly.
 * @property {number} targetLength   Length of the target the patch produces.
 * @property {Instruction[]} instructions  Ordered list of instructions.
 */

/**
 * Build a Patch object directly from a list of instructions. Useful for
 * constructing patches programmatically (e.g. in tests) without going
 * through computeDiff.
 *
 * @param {number} sourceLength
 * @param {number} targetLength
 * @param {Instruction[]} instructions
 * @returns {Patch}
 */
export function createPatch(sourceLength, targetLength, instructions) {
  if (!Number.isInteger(sourceLength) || sourceLength < 0) {
    throw new TypeError('sourceLength must be a non-negative integer');
  }
  if (!Number.isInteger(targetLength) || targetLength < 0) {
    throw new TypeError('targetLength must be a non-negative integer');
  }
  if (!Array.isArray(instructions)) {
    throw new TypeError('instructions must be an array');
  }
  // Defensive copy of the instruction list so external mutation cannot
  // corrupt the patch. We do NOT deep-copy ADD .data buffers here —
  // callers should not hand in buffers they intend to keep mutating.
  return {
    sourceLength,
    targetLength,
    instructions: instructions.slice(),
  };
}

/**
 * Find the longest run of bytes in `source` starting at `sourcePos` that
 * matches `target` starting at `targetPos`. Returns the match length
 * (possibly 0). We cap at Number.MAX_SAFE_INTEGER implicitly; for
 * practical binary files this is never the limiting factor.
 *
 * @param {Uint8Array} source
 * @param {number} sourcePos
 * @param {Uint8Array} target
 * @param {number} targetPos
 * @returns {number}
 */
function matchLength(source, sourcePos, target, targetPos) {
  let len = 0;
  const max = Math.min(source.length - sourcePos, target.length - targetPos);
  while (len < max && source[sourcePos + len] === target[targetPos + len]) {
    len++;
  }
  return len;
}

/**
 * At a given target position, scan the entire source for the longest
 * matching run. We iterate over every source offset rather than
 * building an index; this is O(n*m) but keeps the code small and has
 * no allocation overhead, which matters more for the file sizes this
 * library is aimed at (tens of KB to a few MB).
 *
 * @param {Uint8Array} source
 * @param {Uint8Array} target
 * @param {number} targetPos
 * @returns {{offset:number, length:number}} Best match found; length 0 if none.
 */
function findBestCopy(source, target, targetPos) {
  let bestOffset = 0;
  let bestLen = 0;
  // Early-out: if source is empty there is nothing to copy.
  if (source.length === 0) {
    return { offset: 0, length: 0 };
  }
  for (let i = 0; i < source.length; i++) {
    // Cheap skip: if the first byte doesn't match, matchLength is 0.
    if (source[i] !== target[targetPos]) continue;
    const len = matchLength(source, i, target, targetPos);
    if (len > bestLen) {
      bestLen = len;
      bestOffset = i;
      // A match that reaches the end of either buffer cannot be beaten.
      if (bestLen >= target.length - targetPos || bestLen >= source.length - i) {
        break;
      }
    }
  }
  return { offset: bestOffset, length: bestLen };
}

/**
 * Compute a Patch that transforms `source` into `target`.
 *
 * @param {Uint8Array} source The original bytes. May be empty.
 * @param {Uint8Array} target The desired bytes. May be empty.
 * @returns {Patch}
 */
export function computeDiff(source, target) {
  if (!(source instanceof Uint8Array)) {
    throw new TypeError('source must be a Uint8Array');
  }
  if (!(target instanceof Uint8Array)) {
    throw new TypeError('target must be a Uint8Array');
  }

  const instructions = [];
  let t = 0;
  // Pending literal bytes that have not yet been flushed as an ADD.
  // We accumulate so that short literal runs between COPYs are emitted
  // as a single ADD instruction rather than many one-byte ADDs.
  let pendingStart = 0;
  let pendingLen = 0;

  const flushPending = () => {
    if (pendingLen > 0) {
      // Slice creates an independent copy so later changes to `target`
      // cannot retroactively alter an already-produced patch.
      instructions.push({
        op: OP_ADD,
        offset: 0,
        length: pendingLen,
        data: target.slice(pendingStart, pendingStart + pendingLen),
      });
      pendingLen = 0;
    }
  };

  while (t < target.length) {
    const { offset, length } = findBestCopy(source, target, t);
    if (length >= MIN_COPY) {
      flushPending();
      instructions.push({ op: OP_COPY, offset, length });
      t += length;
    } else {
      // First literal byte in this run: remember where it starts.
      if (pendingLen === 0) pendingStart = t;
      pendingLen++;
      t++;
    }
  }
  flushPending();

  return {
    sourceLength: source.length,
    targetLength: target.length,
    instructions,
  };
}

/**
 * Apply a Patch to a source, reconstructing the target.
 *
 * Throws if the source length does not match the patch's declared
 * sourceLength, or if an instruction references out-of-range bytes.
 * This strictness is deliberate: a mismatched source almost certainly
 * indicates a logic error upstream, and silently producing a corrupt
 * target would be worse than failing loudly.
 *
 * @param {Uint8Array} source
 * @param {Patch} patch
 * @returns {Uint8Array} A freshly allocated Uint8Array equal to the original target.
 */
export function applyPatch(source, patch) {
  if (!(source instanceof Uint8Array)) {
    throw new TypeError('source must be a Uint8Array');
  }
  if (!patch || typeof patch !== 'object') {
    throw new TypeError('patch must be a Patch object');
  }
  if (source.length !== patch.sourceLength) {
    throw new RangeError(
      `source length ${source.length} does not match patch sourceLength ${patch.sourceLength}`,
    );
  }

  const out = new Uint8Array(patch.targetLength);
  let w = 0; // write cursor

  for (const instr of patch.instructions) {
    if (!instr || typeof instr !== 'object') {
      throw new TypeError('patch contains a non-object instruction');
    }
    if (instr.op === OP_COPY) {
      const { offset, length } = instr;
      if (!Number.isInteger(offset) || !Number.isInteger(length)) {
        throw new TypeError('COPY instruction requires integer offset and length');
      }
      if (offset < 0 || length < 0) {
        throw new RangeError('COPY offset/length must be non-negative');
      }
      if (offset + length > source.length) {
        throw new RangeError(
          `COPY references source[${offset}..${offset + length}] but source is ${source.length} bytes`,
        );
      }
      if (w + length > out.length) {
        throw new RangeError('COPY would overflow target buffer');
      }
      out.set(source.subarray(offset, offset + length), w);
      w += length;
    } else if (instr.op === OP_ADD) {
      const { data, length } = instr;
      if (!(data instanceof Uint8Array)) {
        throw new TypeError('ADD instruction requires a Uint8Array data field');
      }
      if (data.length !== length) {
        throw new RangeError('ADD instruction length does not match data.length');
      }
      if (w + length > out.length) {
        throw new RangeError('ADD would overflow target buffer');
      }
      out.set(data, w);
      w += length;
    } else {
    throw new RangeError(`unknown opcode ${instr.op}`);
    }
  }

  if (w !== patch.targetLength) {
    throw new RangeError(
      `patch produced ${w} bytes but declared targetLength is ${patch.targetLength}`,
    );
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Little-endian integer writers. We use a fixed 4-byte width for
 * offsets and lengths, which caps source/target size at 4 GiB. That is
 * far beyond the intended use case and keeps the format trivial to
 * parse. If larger files ever matter, bump to 8 bytes and increment
 * FORMAT_VERSION.
 */
function writeU32(bytes, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`value ${value} is not a 32-bit unsigned integer`);
  }
  bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function readU32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] * 0x1000000)
  );
}

/**
 * Serialize a Patch to a portable byte stream.
 *
 * Layout:
 *   magic            4 bytes  = [0x42,0x46,0x44,0x46]
 *   version          1 byte   = 1
 *   sourceLength     4 bytes  LE
 *   targetLength     4 bytes  LE
 *   instructionCount 4 bytes  LE
 *   instructions...  variable
 *     OP_COPY: 1 byte opcode, 4 LE offset, 4 LE length
 *     OP_ADD:  1 byte opcode, 4 LE length, `length` literal bytes
 *
 * @param {Patch} patch
 * @returns {Uint8Array}
 */
export function serializePatch(patch) {
  if (!patch || typeof patch !== 'object') {
    throw new TypeError('patch must be a Patch object');
  }
  if (!Array.isArray(patch.instructions)) {
    throw new TypeError('patch.instructions must be an array');
  }

  // Build into a regular array first for cheap push, then convert.
  // For the file sizes we target this is fine and avoids pre-sizing
  // arithmetic that would itself need to walk the instructions.
  const bytes = [];
  for (const m of MAGIC) bytes.push(m);
  bytes.push(FORMAT_VERSION);
  writeU32(bytes, patch.sourceLength);
  writeU32(bytes, patch.targetLength);
  writeU32(bytes, patch.instructions.length);

  for (const instr of patch.instructions) {
    if (instr.op === OP_COPY) {
      bytes.push(OP_COPY);
      writeU32(bytes, instr.offset);
      writeU32(bytes, instr.length);
    } else if (instr.op === OP_ADD) {
      bytes.push(OP_ADD);
      writeU32(bytes, instr.length);
      // Inline the literal bytes. data.length === length is enforced
      // by applyPatch; we re-check here so a hand-built Patch can't
      // produce a corrupt stream.
      if (!(instr.data instanceof Uint8Array) || instr.data.length !== instr.length) {
        throw new RangeError('ADD instruction has inconsistent data/length');
      }
      for (let i = 0; i < instr.data.length; i++) bytes.push(instr.data[i]);
    } else {
      throw new RangeError(`unknown opcode ${instr.op}`);
    }
  }

  return Uint8Array.from(bytes);
}

/**
 * Parse a byte stream produced by serializePatch back into a Patch.
 *
 * Throws on truncated input, bad magic, or unknown version. We never
 * throw on semantically odd instructions (that is applyPatch's job);
 * we only reject streams we cannot structurally parse.
 *
 * @param {Uint8Array} bytes
 * @returns {Patch}
 */
export function deserializePatch(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('bytes must be a Uint8Array');
  }
  if (bytes.length < MAGIC.length + 1 + 12) {
    throw new RangeError('patch stream too short for header');
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) {
      throw new RangeError('bad magic; not a BFDF patch');
    }
  }
  let p = MAGIC.length;
  const version = bytes[p++];
  if (version !== FORMAT_VERSION) {
    throw new RangeError(`unsupported patch version ${version}`);
  }
  const sourceLength = readU32(bytes, p); p += 4;
  const targetLength = readU32(bytes, p); p += 4;
  const instrCount = readU32(bytes, p); p += 4;

  const instructions = [];
  for (let i = 0; i < instrCount; i++) {
    if (p >= bytes.length) {
      throw new RangeError(`patch stream truncated at instruction ${i}`);
    }
    const op = bytes[p++];
    if (op === OP_COPY) {
      if (p + 8 > bytes.length) throw new RangeError('COPY instruction truncated');
      const offset = readU32(bytes, p); p += 4;
      const length = readU32(bytes, p); p += 4;
      instructions.push({ op: OP_COPY, offset, length });
    } else if (op === OP_ADD) {
      if (p + 4 > bytes.length) throw new RangeError('ADD instruction header truncated');
      const length = readU32(bytes, p); p += 4;
      if (p + length > bytes.length) throw new RangeError('ADD instruction data truncated');
      // Copy out so the returned Patch does not alias the input buffer;
      // callers may discard `bytes` after this call.
      const data = bytes.slice(p, p + length);
      p += length;
      instructions.push({ op: OP_ADD, offset: 0, length, data });
    } else {
      throw new RangeError(`unknown opcode ${op} at byte ${p - 1}`);
    }
  }

  if (p !== bytes.length) {
    // Trailing bytes mean either corruption or a newer format we don't
    // understand. Either way, refuse rather than silently dropping data.
    throw new RangeError(`patch stream has ${bytes.length - p} trailing bytes`);
  }

  return { sourceLength, targetLength, instructions };
}
