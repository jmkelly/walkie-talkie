// Minimal QR encoder for room links. Byte mode, error correction M, versions 1-10.
// The matrix layout follows ISO/IEC 18004; no external decoder is involved.

const MAX_VERSION = 10;
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const EC_CODEWORDS_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCK_COUNT = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGNMENT_CENTERS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < GF_EXP.length; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

const GENERATORS = new Map();

export function createQr(text, { mask = null } = {}) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const data = buildData(bytes, version);
  const codewords = interleave(data, version);

  if (mask !== null) {
    return { version, size: 17 + version * 4, modules: buildMatrix(version, codewords, mask) };
  }

  let best = null;
  let bestScore = Infinity;
  for (let candidate = 0; candidate < 8; candidate += 1) {
    const modules = buildMatrix(version, codewords, candidate);
    const score = penalty(modules);
    if (score < bestScore) {
      best = modules;
      bestScore = score;
    }
  }
  return { version, size: 17 + version * 4, modules: best };
}

export function renderQr(svg, text, { margin = 4 } = {}) {
  const qr = createQr(text);
  const total = qr.size + margin * 2;
  const path = svg.querySelector("path");
  const runs = [];

  for (let row = 0; row < qr.size; row += 1) {
    let column = 0;
    while (column < qr.size) {
      if (!qr.modules[row][column]) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < qr.size && qr.modules[row][column]) column += 1;
      const length = column - start;
      runs.push(`M${start + margin} ${row + margin}h${length}v1h-${length}z`);
    }
  }

  svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
  path.setAttribute("d", runs.join(""));
  svg.hidden = false;
  return qr;
}

function pickVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const capacity = dataCapacity(version) * 8;
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= capacity) return version;
  }
  throw new RangeError("Link is too long for a QR code.");
}

function dataCapacity(version) {
  return TOTAL_CODEWORDS[version] - EC_CODEWORDS_PER_BLOCK[version] * BLOCK_COUNT[version];
}

function buildData(bytes, version) {
  const capacity = dataCapacity(version) * 8;
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) appendBits(bits, byte, 8);

  if (bits.length > capacity) throw new RangeError("Link does not fit the selected QR version.");

  const terminated = Math.min(capacity, bits.length + 4);
  const data = new Uint8Array(dataCapacity(version));
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) data[i >> 3] |= 1 << (7 - (i & 7));
  }

  const usedBytes = Math.ceil(terminated / 8);
  for (let i = usedBytes; i < data.length; i += 1) {
    data[i] = (i - usedBytes) % 2 === 0 ? 0xec : 0x11;
  }
  return data;
}

function appendBits(target, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) target.push((value >>> i) & 1);
}

function interleave(data, version) {
  const blockCount = BLOCK_COUNT[version];
  const ecLength = EC_CODEWORDS_PER_BLOCK[version];
  const shortLength = Math.floor(data.length / blockCount);
  const longCount = data.length % blockCount;
  const blocks = [];
  let offset = 0;

  for (let i = 0; i < blockCount; i += 1) {
    const length = shortLength + (i >= blockCount - longCount ? 1 : 0);
    const chunk = data.slice(offset, offset + length);
    offset += length;
    blocks.push(chunk);
  }

  const result = [];
  const longest = shortLength + (longCount > 0 ? 1 : 0);
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) {
      if (i < block.length) result.push(block[i]);
    }
  }

  const ecBlocks = blocks.map((block) => reedSolomon(block, ecLength));
  for (let i = 0; i < ecLength; i += 1) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

function reedSolomon(data, degree) {
  let generator = GENERATORS.get(degree);
  if (!generator) {
    generator = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array(generator.length + 1).fill(0);
      for (let j = 0; j < generator.length; j += 1) {
        next[j] ^= generator[j];
        next[j + 1] ^= multiply(generator[j], GF_EXP[i]);
      }
      generator = next;
    }
    GENERATORS.set(degree, generator);
  }

  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    if (!factor) continue;
    for (let i = 0; i < degree; i += 1) {
      remainder[i] ^= multiply(generator[i + 1], factor);
    }
  }
  return remainder;
}

function multiply(a, b) {
  if (!a || !b) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildMatrix(version, codewords, mask) {
  const size = 17 + version * 4;
  const modules = Array.from({ length: size }, () => new Int8Array(size).fill(-1));

  for (const [row, column] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    placeFinder(modules, row, column);
  }

  const centers = ALIGNMENT_CENTERS[version];
  for (const row of centers) {
    for (const column of centers) {
      if (
        (row === 6 && column === 6) ||
        (row === 6 && column === size - 7) ||
        (row === size - 7 && column === 6)
      ) {
        continue;
      }
      placeAlignment(modules, row, column);
    }
  }

  for (let i = 8; i < size - 8; i += 1) {
    if (modules[6][i] === -1) modules[6][i] = i % 2 === 0 ? 1 : 0;
    if (modules[i][6] === -1) modules[i][6] = i % 2 === 0 ? 1 : 0;
  }

  modules[4 * version + 9][8] = 1;
  reserveFormat(modules, size);
  if (version >= 7) writeVersion(modules, size, version);

  let bitIndex = 0;
  let row = size - 1;
  let direction = -1;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1;
    for (;;) {
      for (let offset = 0; offset < 2; offset += 1) {
        const current = column - offset;
        if (modules[row][current] !== -1) continue;
        const bit =
          bitIndex < codewords.length * 8
            ? ((codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1) === 1
            : false;
        modules[row][current] = (bit !== maskBit(mask, row, current)) ? 1 : 0;
        bitIndex += 1;
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }

  writeFormat(modules, size, mask);
  return modules;
}

function placeFinder(modules, row, column) {
  const size = modules.length;
  for (let dr = -1; dr <= 7; dr += 1) {
    for (let dc = -1; dc <= 7; dc += 1) {
      const r = row + dr;
      const c = column + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      const dark =
        (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
        (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
        (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
      modules[r][c] = dark ? 1 : 0;
    }
  }
}

function placeAlignment(modules, row, column) {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const edge = Math.max(Math.abs(dr), Math.abs(dc));
      modules[row + dr][column + dc] = edge === 1 ? 0 : 1;
    }
  }
}

function reserveFormat(modules, size) {
  const cells = formatCells(size);
  for (const [row, column] of cells) modules[row][column] = 0;
}

function formatCells(size) {
  const cells = [];
  for (let i = 0; i < 15; i += 1) {
    if (i < 6) cells.push([i, 8]);
    else if (i < 8) cells.push([i + 1, 8]);
    else cells.push([size - 15 + i, 8]);

    if (i < 8) cells.push([8, size - i - 1]);
    else if (i === 8) cells.push([8, 7]);
    else cells.push([8, 15 - i - 1]);
  }
  return cells;
}

function writeFormat(modules, size, mask) {
  const bits = formatBits(mask);
  const cells = formatCells(size);
  for (let i = 0; i < 15; i += 1) {
    const [row, column] = cells[i * 2];
    modules[row][column] = (bits >>> i) & 1;
    const [row2, column2] = cells[i * 2 + 1];
    modules[row2][column2] = (bits >>> i) & 1;
  }
}

function formatBits(mask) {
  const data = mask; // Error correction level M is 00.
  let remainder = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10);
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
}

function writeVersion(modules, size, version) {
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >>> i) & 1;
    modules[Math.floor(i / 3)][(i % 3) + size - 11] = bit;
    modules[(i % 3) + size - 11][Math.floor(i / 3)] = bit;
  }
}

function versionBits(version) {
  let remainder = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((remainder >>> i) & 1) remainder ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | (remainder & 0xfff);
}

function maskBit(mask, row, column) {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    case 7:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      throw new RangeError("Mask must be 0 through 7.");
  }
}

function penalty(modules) {
  const size = modules.length;
  let score = 0;

  for (let row = 0; row < size; row += 1) {
    let run = 1;
    for (let column = 1; column < size; column += 1) {
      if (modules[row][column] === modules[row][column - 1]) {
        run += 1;
      } else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
    if (run >= 5) score += 3 + run - 5;
  }

  for (let column = 0; column < size; column += 1) {
    let run = 1;
    for (let row = 1; row < size; row += 1) {
      if (modules[row][column] === modules[row - 1][column]) {
        run += 1;
      } else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
    if (run >= 5) score += 3 + run - 5;
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const value = modules[row][column];
      if (
        value === modules[row][column + 1] &&
        value === modules[row + 1][column] &&
        value === modules[row + 1][column + 1]
      ) {
        score += 3;
      }
    }
  }

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= size - 11; column += 1) {
      let window = 0;
      for (let i = 0; i < 11; i += 1) window = (window << 1) | modules[row][column + i];
      if (window === 0x5d0 || window === 0x05d) score += 40;
    }
  }

  for (let column = 0; column < size; column += 1) {
    for (let row = 0; row <= size - 11; row += 1) {
      let window = 0;
      for (let i = 0; i < 11; i += 1) window = (window << 1) | modules[row + i][column];
      if (window === 0x5d0 || window === 0x05d) score += 40;
    }
  }

  let dark = 0;
  for (const row of modules) {
    for (const value of row) dark += value;
  }
  score += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
  return score;
}
