/*
 * CCQR — self-contained, zero-dependency QR Code generator.
 * Byte mode only, error-correction level L, versions 1-5 (single ECC block).
 * No network calls. Browser global: window.CCQR. Node: module.exports.
 */
(function (root) {
  'use strict';

  // Per-version facts (level L, single ECC block).
  // index 0 => version 1, etc.
  var DATA_CODEWORDS = [19, 34, 55, 80, 108]; // v1..v5
  var ECC_CODEWORDS = [7, 10, 15, 20, 26];    // v1..v5
  var ALIGN_CENTERS = [
    [],            // v1: none
    [6, 18],       // v2
    [6, 22],       // v3
    [6, 26],       // v4
    [6, 30]        // v5
  ];

  // ---------- GF(256) arithmetic, primitive poly 0x11D ----------
  var EXP = new Array(512);
  var LOG = new Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // Build generator polynomial of given degree.
  function rsGenerator(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var i = 0; i < poly.length; i++) {
        next[i] ^= poly[i];
        next[i + 1] ^= gfMul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly; // length degree+1, leading coeff 1
  }

  // Compute ECC codewords for a data block.
  function rsEncode(data, eccCount) {
    var gen = rsGenerator(eccCount);
    var result = new Array(eccCount).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ result[0];
      result.shift();
      result.push(0);
      if (factor !== 0) {
        for (var j = 0; j < eccCount; j++) {
          result[j] ^= gfMul(gen[j + 1], factor);
        }
      }
    }
    return result;
  }

  // ---------- UTF-8 encode ----------
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        // surrogate pair
        var c2 = str.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(
          0xF0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3F),
          0x80 | ((cp >> 6) & 0x3F),
          0x80 | (cp & 0x3F)
        );
        i++;
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  // ---------- Bitstream builder ----------
  function buildCodewords(bytes, version) {
    var dataCount = DATA_CODEWORDS[version - 1];
    var totalBits = dataCount * 8;
    var bits = [];

    function pushBits(value, len) {
      for (var b = len - 1; b >= 0; b--) bits.push((value >> b) & 1);
    }

    pushBits(0x4, 4);            // mode indicator: byte mode = 0100
    pushBits(bytes.length, 8);   // char count indicator (8 bits, v1-9)
    for (var i = 0; i < bytes.length; i++) pushBits(bytes[i], 8);

    // Terminator 0000, truncated if at capacity.
    var remaining = totalBits - bits.length;
    var term = Math.min(4, remaining);
    for (var t = 0; t < term; t++) bits.push(0);

    // Pad to byte boundary.
    while (bits.length % 8 !== 0) bits.push(0);

    // Convert to bytes.
    var codewords = [];
    for (var k = 0; k < bits.length; k += 8) {
      var v = 0;
      for (var m = 0; m < 8; m++) v = (v << 1) | bits[k + m];
      codewords.push(v);
    }

    // Pad bytes alternating 0xEC, 0x11.
    var pad = [0xEC, 0x11];
    var pi = 0;
    while (codewords.length < dataCount) {
      codewords.push(pad[pi % 2]);
      pi++;
    }

    return codewords;
  }

  // ---------- Matrix construction ----------
  function makeEmpty(size) {
    var m = new Array(size);
    var reserved = new Array(size);
    for (var r = 0; r < size; r++) {
      m[r] = new Array(size).fill(false);
      reserved[r] = new Array(size).fill(false);
    }
    return { modules: m, reserved: reserved };
  }

  function placeFinder(m, res, top, left) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = top + r, cc = left + c;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var dark;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          var ring = (r === 0 || r === 6 || c === 0 || c === 6);
          var center = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          dark = ring || center;
        } else {
          dark = false; // separator
        }
        m[rr][cc] = dark;
        res[rr][cc] = true;
      }
    }
  }

  function placeAlignment(m, res, cr, cc) {
    for (var r = -2; r <= 2; r++) {
      for (var c = -2; c <= 2; c++) {
        var rr = cr + r, ccc = cc + c;
        var ring = Math.max(Math.abs(r), Math.abs(c));
        var dark = (ring !== 1); // dark at ring 0 and 2, light at ring 1
        m[rr][ccc] = dark;
        res[rr][ccc] = true;
      }
    }
  }

  function drawFunctionPatterns(m, res, version) {
    var size = m.length;

    // Finder patterns + separators.
    placeFinder(m, res, 0, 0);
    placeFinder(m, res, 0, size - 7);
    placeFinder(m, res, size - 7, 0);

    // Timing patterns (row 6 and col 6).
    for (var i = 8; i < size - 8; i++) {
      var dark = (i % 2 === 0);
      if (!res[6][i]) { m[6][i] = dark; res[6][i] = true; }
      if (!res[i][6]) { m[i][6] = dark; res[i][6] = true; }
    }

    // Alignment patterns at center combinations, skipping finder collisions.
    var centers = ALIGN_CENTERS[version - 1];
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        var cr = centers[a], cc = centers[b];
        // Skip the three that overlap finder patterns.
        var nearTL = (cr <= 8 && cc <= 8);
        var nearTR = (cr <= 8 && cc >= size - 9);
        var nearBL = (cr >= size - 9 && cc <= 8);
        if (nearTL || nearTR || nearBL) continue;
        placeAlignment(m, res, cr, cc);
      }
    }

    // Dark module at (row = size-8, col = 8).
    m[size - 8][8] = true;
    res[size - 8][8] = true;

    // Reserve format-info areas.
    reserveFormat(res, size);
  }

  function reserveFormat(res, size) {
    // Around top-left finder.
    for (var i = 0; i <= 8; i++) {
      if (i !== 6) { res[8][i] = true; res[i][8] = true; }
    }
    res[8][6] = true; // these specific cells are part of format band (col/row 6 intersection handled by timing)
    res[6][8] = true;
    // Top-right horizontal strip (row 8, cols size-8..size-1).
    for (var c = size - 8; c < size; c++) res[8][c] = true;
    // Bottom-left vertical strip (rows size-7..size-1, col 8).
    for (var r = size - 7; r < size; r++) res[r][8] = true;
  }

  // ---------- Data placement (zig-zag) ----------
  function placeData(m, res, allCodewords) {
    var size = m.length;
    // Flatten codewords to bit array.
    var bits = [];
    for (var i = 0; i < allCodewords.length; i++) {
      for (var b = 7; b >= 0; b--) bits.push((allCodewords[i] >> b) & 1);
    }

    var bitIdx = 0;
    var upward = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5; // skip timing column
      for (var rowStep = 0; rowStep < size; rowStep++) {
        var row = upward ? (size - 1 - rowStep) : rowStep;
        for (var dc = 0; dc < 2; dc++) {
          var c = col - dc;
          if (res[row][c]) continue;
          var bit = bitIdx < bits.length ? bits[bitIdx] : 0;
          m[row][c] = (bit === 1);
          bitIdx++;
        }
      }
      upward = !upward;
    }
  }

  // ---------- Masking ----------
  function maskFn(pattern, r, c) {
    switch (pattern) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
    return false;
  }

  function applyMask(m, res, pattern) {
    var size = m.length;
    var out = new Array(size);
    for (var r = 0; r < size; r++) {
      out[r] = m[r].slice();
      for (var c = 0; c < size; c++) {
        if (!res[r][c] && maskFn(pattern, r, c)) out[r][c] = !out[r][c];
      }
    }
    return out;
  }

  // ---------- Penalty scoring ----------
  function penalty(m) {
    var size = m.length;
    var score = 0;

    // Rule 1: runs of 5+ same color in rows and columns.
    for (var r = 0; r < size; r++) {
      var runColor = m[r][0], runLen = 1;
      for (var c = 1; c < size; c++) {
        if (m[r][c] === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) score += 3 + (runLen - 5);
          runColor = m[r][c]; runLen = 1;
        }
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
    }
    for (var c2 = 0; c2 < size; c2++) {
      var rc = m[0][c2], rl = 1;
      for (var r2 = 1; r2 < size; r2++) {
        if (m[r2][c2] === rc) {
          rl++;
        } else {
          if (rl >= 5) score += 3 + (rl - 5);
          rc = m[r2][c2]; rl = 1;
        }
      }
      if (rl >= 5) score += 3 + (rl - 5);
    }

    // Rule 2: 2x2 blocks of same color.
    for (var r3 = 0; r3 < size - 1; r3++) {
      for (var c3 = 0; c3 < size - 1; c3++) {
        var v = m[r3][c3];
        if (m[r3][c3 + 1] === v && m[r3 + 1][c3] === v && m[r3 + 1][c3 + 1] === v) {
          score += 3;
        }
      }
    }

    // Rule 3: finder-like patterns 1:1:3:1:1 with 4 light on either side.
    var pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    var pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    function matches(arr, off, pat) {
      for (var k = 0; k < pat.length; k++) {
        if (arr[off + k] !== pat[k]) return false;
      }
      return true;
    }
    for (var r4 = 0; r4 < size; r4++) {
      for (var c4 = 0; c4 <= size - 11; c4++) {
        if (matches(m[r4], c4, pat1) || matches(m[r4], c4, pat2)) score += 40;
      }
    }
    for (var c5 = 0; c5 < size; c5++) {
      var colArr = [];
      for (var r5 = 0; r5 < size; r5++) colArr.push(m[r5][c5]);
      for (var r6 = 0; r6 <= size - 11; r6++) {
        if (matches(colArr, r6, pat1) || matches(colArr, r6, pat2)) score += 40;
      }
    }

    // Rule 4: balance of dark/light.
    var dark = 0;
    for (var r7 = 0; r7 < size; r7++) {
      for (var c7 = 0; c7 < size; c7++) if (m[r7][c7]) dark++;
    }
    var total = size * size;
    var percent = (dark * 100) / total;
    var prev = Math.floor(percent / 5) * 5;
    var next = prev + 5;
    var ratio = Math.min(Math.abs(prev - 50), Math.abs(next - 50)) / 5;
    score += ratio * 10;

    return score;
  }

  // ---------- Format information ----------
  function formatBits(mask) {
    // 5 data bits: ECC level L = 01, shifted, OR mask.
    var data = (0x01 << 3) | mask; // 01 << 3 | mask
    // BCH(15,5) with generator 0x537.
    var rem = data << 10;
    var g = 0x537;
    for (var i = 14; i >= 10; i--) {
      if ((rem >> i) & 1) {
        rem ^= g << (i - 10);
      }
    }
    var bits = ((data << 10) | rem) ^ 0x5412;
    return bits & 0x7FFF; // 15 bits
  }

  function placeFormat(m, mask) {
    var size = m.length;
    var fmt = formatBits(mask);
    // bit indexing: bit 14 is most significant.
    function getBit(i) { return (fmt >> i) & 1; }

    // Copy 1: around top-left finder.
    // Horizontal (row 8): cols 0..5, then 7,8 ; vertical (col 8): rows 0..5 etc.
    // Standard placement per spec.
    // Top-left horizontal/vertical.
    for (var i = 0; i <= 5; i++) {
      m[8][i] = getBit(i) === 1;        // row 8, col 0..5 -> bits 0..5
    }
    m[8][7] = getBit(6) === 1;
    m[8][8] = getBit(7) === 1;
    m[7][8] = getBit(8) === 1;
    for (var j = 0; j <= 5; j++) {
      m[5 - j][8] = getBit(9 + j) === 1; // col 8, rows 5..0 -> bits 9..14
    }

    // Copy 2.
    for (var k = 0; k <= 7; k++) {
      m[size - 1 - k][8] = getBit(k) === 1; // col 8, bottom rows -> bits 0..7
    }
    for (var l = 0; l <= 6; l++) {
      m[8][size - 7 + l] = getBit(8 + l) === 1; // row 8, right cols -> bits 8..14
    }

    // Dark module guaranteed.
    m[size - 8][8] = true;
  }

  // ---------- Public: matrix ----------
  function pickVersion(byteLen) {
    for (var v = 1; v <= 5; v++) {
      if (byteLen + 2 <= DATA_CODEWORDS[v - 1]) {
        // need at least mode(4)+count(8)=12 bits = ok, but capacity check is in codewords:
        // data bytes + mode/count overhead. Mode+count = 12 bits => spans into first codewords.
        // Proper check below.
      }
    }
    // Proper capacity check: bits needed = 4 + 8 + 8*len; must be <= dataCount*8.
    for (var ver = 1; ver <= 5; ver++) {
      var capacityBits = DATA_CODEWORDS[ver - 1] * 8;
      var neededBits = 4 + 8 + 8 * byteLen;
      if (neededBits <= capacityBits) return ver;
    }
    return -1;
  }

  function buildMatrix(text) {
    var bytes = utf8Bytes(text);
    var version = pickVersion(bytes.length);
    if (version === -1) return null;

    var size = 17 + 4 * version;
    var dataCodewords = buildCodewords(bytes, version);
    var eccCodewords = rsEncode(dataCodewords, ECC_CODEWORDS[version - 1]);
    var allCodewords = dataCodewords.concat(eccCodewords);

    var base = makeEmpty(size);
    drawFunctionPatterns(base.modules, base.reserved, version);
    placeData(base.modules, base.reserved, allCodewords);

    // Try all 8 masks, pick lowest penalty.
    var bestMask = 0, bestScore = Infinity, bestMatrix = null;
    for (var mask = 0; mask < 8; mask++) {
      var masked = applyMask(base.modules, base.reserved, mask);
      placeFormat(masked, mask);
      var p = penalty(masked);
      if (p < bestScore) {
        bestScore = p;
        bestMask = mask;
        bestMatrix = masked;
      }
    }

    return { size: size, modules: bestMatrix, version: version, mask: bestMask };
  }

  function matrix(text) {
    var result = buildMatrix(text);
    if (!result) return null;
    return { size: result.size, modules: result.modules };
  }

  // ---------- Public: svg ----------
  function svg(text, opts) {
    opts = opts || {};
    var pxSize = opts.size != null ? opts.size : 160;
    var margin = opts.margin != null ? opts.margin : 4;
    var dark = opts.dark != null ? opts.dark : '#0b0e1a';
    var light = opts.light != null ? opts.light : '#ffffff';

    var result = buildMatrix(text);
    if (!result) return null;

    var n = result.size;
    var total = n + margin * 2; // total modules across including quiet zone
    var mods = result.modules;

    var pathData = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (mods[r][c]) {
          var x = c + margin;
          var y = r + margin;
          pathData += 'M' + x + ' ' + y + 'h1v1h-1z';
        }
      }
    }

    var svgStr =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + pxSize + '" height="' + pxSize +
      '" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges">' +
      '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
      '<path d="' + pathData + '" fill="' + dark + '"/>' +
      '</svg>';

    return svgStr;
  }

  // ---------- Export ----------
  var api = { matrix: matrix, svg: svg };
  if (root) root.CCQR = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { matrix: matrix, svg: svg };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
