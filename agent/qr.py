#!/usr/bin/env python3
"""Pure-stdlib QR-code encoder and terminal renderer for Couchside.

This is a faithful Python port of the reference JavaScript encoder
(Kazuhiko Arase's qrcode-generator, reduced to exactly what Couchside
needs): 8-bit byte mode, error-correction level M, automatic version
selection (smallest of versions 1..40 that fits), and automatic mask
selection using the standard ISO/IEC 18004 penalty rules.

The goal is byte-for-byte matrix parity with that reference encoder,
so the numeric tables and the bit-level arithmetic below mirror the
JS source line for line. Where the JS relies on unsigned 32-bit shifts
or `Math.floor` on positive numbers, the Python equivalents (masking,
`//`) are chosen to reproduce the exact same integers.

Target boxes are immutable SteamOS / Bazzite installs with no pip, so
this file uses the Python standard library only (just `sys`).

Usage:
    python3 qr.py "<text>"            # print a scannable terminal QR
    python3 qr.py --matrix "<text>"   # print raw matrix for verification
"""

import sys


# ---------------------------------------------------------------------------
# Constants and numeric tables (ported verbatim from the reference qr.js).
# ---------------------------------------------------------------------------

# Error-correction level M is encoded as 0 in the format-information bits.
# The reference calls this errorCorrectLevel = 0 (QRErrorCorrectLevel.M).
EC_LEVEL_M = 0

# Byte-mode indicator (mode 0100 in the QR spec). The reference stores this
# on each data chunk as `mode = 4`.
MODE_8BIT_BYTE = 4

# Padding bytes alternated to fill the data capacity after the terminator.
PAD0 = 0xEC
PAD1 = 0x11

# BCH generator polynomials and the format-info mask, exactly as in qr.js.
# G15 protects the 15-bit format information, G18 the 18-bit version
# information (used only for version >= 7), and G15_MASK is XORed into the
# final format bits per the spec so an all-zero format is not all-light.
G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0)
G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0)
G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1)

# Alignment-pattern center coordinates, indexed by (version - 1). Version 1
# has none. These are the centers along each axis; the encoder places a
# pattern at every (row, col) pair drawn from this list (skipping any that
# collide with a finder pattern).
PATTERN_POSITION_TABLE = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
    [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74],
    [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
    [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170],
]

# Reed-Solomon block layout for level M, one entry per version (index is
# version - 1). Each entry is a flat list of [count, total_cw, data_cw]
# triples; a version with two block groups has two triples (six numbers).
# count = number of blocks with this shape, total_cw = codewords per block,
# data_cw = data codewords per block (the rest are error-correction codewords).
RS_BLOCK_TABLE = [
    [1, 26, 16], [1, 44, 28], [1, 70, 44], [2, 50, 32], [2, 67, 43],
    [4, 43, 27], [4, 49, 31], [2, 60, 38, 2, 61, 39], [3, 58, 24, 2, 59, 25],
    [4, 69, 43, 1, 70, 44], [1, 80, 50, 4, 81, 51], [6, 58, 36, 2, 59, 37],
    [8, 59, 37, 1, 60, 38], [4, 64, 40, 5, 65, 41], [5, 65, 41, 5, 66, 42],
    [7, 73, 45, 3, 74, 46], [10, 74, 46, 1, 75, 47], [9, 69, 43, 4, 70, 44],
    [3, 70, 44, 11, 71, 45], [3, 67, 41, 13, 68, 42], [17, 68, 42],
    [17, 74, 46], [4, 75, 47, 14, 76, 48], [6, 73, 45, 14, 74, 46],
    [8, 75, 47, 13, 76, 48], [19, 74, 46, 4, 75, 47], [22, 73, 45, 3, 74, 46],
    [3, 73, 45, 23, 74, 46], [21, 73, 45, 7, 74, 46], [19, 75, 47, 10, 76, 48],
    [2, 74, 46, 29, 75, 47], [10, 74, 46, 23, 75, 47], [14, 74, 46, 21, 75, 47],
    [14, 74, 46, 23, 75, 47], [12, 75, 47, 26, 76, 48], [6, 75, 47, 34, 76, 48],
    [29, 74, 46, 14, 75, 47], [13, 74, 46, 32, 75, 47], [40, 75, 47, 7, 76, 48],
    [18, 75, 47, 31, 76, 48],
]


# ---------------------------------------------------------------------------
# GF(256) arithmetic (QRMath). Log/antilog tables over the field defined by
# the primitive polynomial 0x11D. The exp table is seeded so exp[i] = 2**i
# for i < 8, then extended by the field recurrence.
# ---------------------------------------------------------------------------

EXP_TABLE = [0] * 256
LOG_TABLE = [0] * 256
for _i in range(8):
    EXP_TABLE[_i] = 1 << _i
for _i in range(8, 256):
    EXP_TABLE[_i] = (
        EXP_TABLE[_i - 4] ^ EXP_TABLE[_i - 5] ^ EXP_TABLE[_i - 6] ^ EXP_TABLE[_i - 8]
    )
for _i in range(255):
    LOG_TABLE[EXP_TABLE[_i]] = _i


def glog(n):
    """Discrete log in GF(256). Defined only for n >= 1 (0 has no log)."""
    if n < 1:
        raise ValueError("glog(%d)" % n)
    return LOG_TABLE[n]


def gexp(n):
    """Antilog in GF(256), with the exponent reduced modulo 255 like the JS."""
    while n < 0:
        n += 255
    while n >= 256:
        n -= 255
    return EXP_TABLE[n]


# ---------------------------------------------------------------------------
# Polynomials over GF(256) (QRPolynomial), used to compute the Reed-Solomon
# error-correction codewords.
# ---------------------------------------------------------------------------

class QRPolynomial:
    def __init__(self, num, shift):
        # Strip leading zero coefficients (they carry no information), then
        # pad with `shift` trailing zero slots. This matches the JS ctor.
        offset = 0
        while offset < len(num) and num[offset] == 0:
            offset += 1
        self.num = [0] * (len(num) - offset + shift)
        for i in range(len(num) - offset):
            self.num[i] = num[i + offset]

    def get(self, index):
        return self.num[index]

    def get_length(self):
        return len(self.num)

    def multiply(self, other):
        # Polynomial multiplication in GF(256): coefficient products become
        # sums of logs (gexp(glog(a) + glog(b))) and are XOR-accumulated.
        num = [0] * (self.get_length() + other.get_length() - 1)
        for i in range(self.get_length()):
            for j in range(other.get_length()):
                num[i + j] ^= gexp(glog(self.get(i)) + glog(other.get(j)))
        return QRPolynomial(num, 0)

    def mod(self, other):
        # Polynomial remainder (self mod other) in GF(256), implemented as
        # the same recursive long-division used by the reference.
        if self.get_length() - other.get_length() < 0:
            return self
        ratio = glog(self.get(0)) - glog(other.get(0))
        num = [self.get(i) for i in range(self.get_length())]
        for i in range(other.get_length()):
            num[i] ^= gexp(glog(other.get(i)) + ratio)
        return QRPolynomial(num, 0).mod(other)


# ---------------------------------------------------------------------------
# Reed-Solomon block descriptors (QRRSBlock).
# ---------------------------------------------------------------------------

class QRRSBlock:
    def __init__(self, total_count, data_count):
        self.total_count = total_count
        self.data_count = data_count


def get_rs_blocks(type_number, error_correct_level):
    """Expand the RS_BLOCK_TABLE row for this version into a block list.

    error_correct_level is accepted for parity with the reference signature;
    the table above is already reduced to level M so it is not indexed on.
    """
    rs_block = RS_BLOCK_TABLE[type_number - 1]
    length = len(rs_block) // 3
    blocks = []
    for i in range(length):
        count = rs_block[i * 3 + 0]
        total_count = rs_block[i * 3 + 1]
        data_count = rs_block[i * 3 + 2]
        for _ in range(count):
            blocks.append(QRRSBlock(total_count, data_count))
    return blocks


# ---------------------------------------------------------------------------
# Bit buffer (QRBitBuffer). Bits are packed MSB-first into a byte list.
# ---------------------------------------------------------------------------

class QRBitBuffer:
    def __init__(self):
        self.buffer = []
        self.length = 0

    def get(self, index):
        buf_index = index // 8
        return ((self.buffer[buf_index] >> (7 - index % 8)) & 1) == 1

    def put(self, num, length):
        for i in range(length):
            self.put_bit(((num >> (length - i - 1)) & 1) == 1)

    def get_length_in_bits(self):
        return self.length

    def put_bit(self, bit):
        buf_index = self.length // 8
        if len(self.buffer) <= buf_index:
            self.buffer.append(0)
        if bit:
            self.buffer[buf_index] |= (0x80 >> (self.length % 8))
        self.length += 1


# ---------------------------------------------------------------------------
# QRUtil: BCH codes, alignment positions, mask functions, EC polynomial,
# penalty scoring, and the length-field width per version.
# ---------------------------------------------------------------------------

def get_bch_digit(data):
    """Number of significant bits in `data` (position of the top set bit)."""
    digit = 0
    while data != 0:
        digit += 1
        data >>= 1
    return digit


def get_bch_type_info(data):
    """15-bit BCH-protected, masked format information for (EC level, mask)."""
    d = data << 10
    while get_bch_digit(d) - get_bch_digit(G15) >= 0:
        d ^= (G15 << (get_bch_digit(d) - get_bch_digit(G15)))
    return ((data << 10) | d) ^ G15_MASK


def get_bch_type_number(data):
    """18-bit BCH-protected version information (used for version >= 7)."""
    d = data << 12
    while get_bch_digit(d) - get_bch_digit(G18) >= 0:
        d ^= (G18 << (get_bch_digit(d) - get_bch_digit(G18)))
    return (data << 12) | d


def get_pattern_position(type_number):
    return PATTERN_POSITION_TABLE[type_number - 1]


def get_mask(mask_pattern, i, j):
    """The eight standard data-mask predicates. True means "invert here".

    Note `i // 2` and `i // 3`: the operands are always non-negative here,
    so Python floor-division reproduces JS `Math.floor` exactly.
    """
    if mask_pattern == 0:
        return (i + j) % 2 == 0
    if mask_pattern == 1:
        return i % 2 == 0
    if mask_pattern == 2:
        return j % 3 == 0
    if mask_pattern == 3:
        return (i + j) % 3 == 0
    if mask_pattern == 4:
        return (i // 2 + j // 3) % 2 == 0
    if mask_pattern == 5:
        return (i * j) % 2 + (i * j) % 3 == 0
    if mask_pattern == 6:
        return ((i * j) % 2 + (i * j) % 3) % 2 == 0
    if mask_pattern == 7:
        return ((i * j) % 3 + (i + j) % 2) % 2 == 0
    raise ValueError("bad maskPattern:%d" % mask_pattern)


def get_error_correct_polynomial(error_correct_length):
    """Generator polynomial for `error_correct_length` EC codewords.

    Built as the product (x - a^0)(x - a^1)...; in GF(256) subtraction is
    XOR, so each factor is [1, gexp(i)].
    """
    a = QRPolynomial([1], 0)
    for i in range(error_correct_length):
        a = a.multiply(QRPolynomial([1, gexp(i)], 0))
    return a


def get_length_in_bits(mode, type_number):
    """Width of the character-count field. For byte mode this is 8 bits for
    versions 1..9 and 16 bits for versions 10..40 (the reference collapses
    the two >=10 ranges to the same 16)."""
    if 1 <= type_number < 10:
        return 8
    if type_number < 27:
        return 16
    if type_number < 41:
        return 16
    raise ValueError("type:%d" % type_number)


def get_lost_point(qr_code):
    """ISO/IEC 18004 penalty score for a rendered matrix (lower is better).

    Sums the four standard penalties: runs of five-or-more same-color
    modules in a row/column, 2x2 same-color blocks, finder-like 1:1:3:1:1
    patterns, and the deviation of the dark-module ratio from 50%.

    Returns a float, matching the JS which keeps the ratio term as a float.
    """
    module_count = qr_code.get_module_count()
    lost_point = 0

    # Penalty 1: adjacent same-colored modules. The reference counts, for
    # each module, how many of its (up to) eight neighbors share its color,
    # and adds (3 + sameCount - 5) whenever that exceeds five.
    for row in range(module_count):
        for col in range(module_count):
            same_count = 0
            dark = qr_code.is_dark(row, col)
            for r in range(-1, 2):
                if row + r < 0 or module_count <= row + r:
                    continue
                for c in range(-1, 2):
                    if col + c < 0 or module_count <= col + c:
                        continue
                    if r == 0 and c == 0:
                        continue
                    if dark == qr_code.is_dark(row + r, col + c):
                        same_count += 1
            if same_count > 5:
                lost_point += 3 + same_count - 5

    # Penalty 2: 2x2 blocks that are entirely dark or entirely light.
    for row in range(module_count - 1):
        for col in range(module_count - 1):
            count = 0
            if qr_code.is_dark(row, col):
                count += 1
            if qr_code.is_dark(row + 1, col):
                count += 1
            if qr_code.is_dark(row, col + 1):
                count += 1
            if qr_code.is_dark(row + 1, col + 1):
                count += 1
            if count == 0 or count == 4:
                lost_point += 3

    # Penalty 3: finder-like dark/light/dark/dark/dark/light/dark runs,
    # scanned horizontally then vertically.
    for row in range(module_count):
        for col in range(module_count - 6):
            if (qr_code.is_dark(row, col)
                    and not qr_code.is_dark(row, col + 1)
                    and qr_code.is_dark(row, col + 2)
                    and qr_code.is_dark(row, col + 3)
                    and qr_code.is_dark(row, col + 4)
                    and not qr_code.is_dark(row, col + 5)
                    and qr_code.is_dark(row, col + 6)):
                lost_point += 40
    for col in range(module_count):
        for row in range(module_count - 6):
            if (qr_code.is_dark(row, col)
                    and not qr_code.is_dark(row + 1, col)
                    and qr_code.is_dark(row + 2, col)
                    and qr_code.is_dark(row + 3, col)
                    and qr_code.is_dark(row + 4, col)
                    and not qr_code.is_dark(row + 5, col)
                    and qr_code.is_dark(row + 6, col)):
                lost_point += 40

    # Penalty 4: proportion of dark modules away from an even 50/50 split.
    dark_count = 0
    for col in range(module_count):
        for row in range(module_count):
            if qr_code.is_dark(row, col):
                dark_count += 1
    ratio = abs(100 * dark_count / module_count / module_count - 50) / 5
    lost_point += ratio * 10
    return lost_point


# ---------------------------------------------------------------------------
# Byte-mode data chunk (QR8bitByte). Encodes the input as UTF-8 bytes.
# ---------------------------------------------------------------------------

class QR8bitByte:
    def __init__(self, data):
        self.mode = MODE_8BIT_BYTE
        self.data = data
        # The reference walks JS UTF-16 code units and hand-rolls UTF-8. For
        # inputs in the Basic Multilingual Plane (everything Couchside emits:
        # ASCII URLs and tokens) that yields exactly Python's UTF-8 encoding.
        # It also prepends a UTF-8 BOM (EF BB BF) when any multi-byte
        # character is present, which we reproduce below for full parity.
        parsed = list(data.encode("utf-8"))
        if len(parsed) != len(data):
            parsed = [0xEF, 0xBB, 0xBF] + parsed
        self.parsed_data = parsed

    def get_length(self):
        return len(self.parsed_data)

    def write(self, buffer):
        for byte in self.parsed_data:
            buffer.put(byte, 8)


# ---------------------------------------------------------------------------
# The QR model (QRCodeModel): builds the module matrix for a given version
# and mask, and holds the data-placement logic.
# ---------------------------------------------------------------------------

class QRCodeModel:
    PAD0 = PAD0
    PAD1 = PAD1

    def __init__(self, type_number, error_correct_level):
        self.type_number = type_number
        self.error_correct_level = error_correct_level
        self.modules = None
        self.module_count = 0
        self.data_cache = None
        self.data_list = []

    def add_data(self, data):
        self.data_list.append(QR8bitByte(data))
        self.data_cache = None

    def is_dark(self, row, col):
        if row < 0 or self.module_count <= row or col < 0 or self.module_count <= col:
            raise IndexError("%d,%d" % (row, col))
        return self.modules[row][col]

    def get_module_count(self):
        return self.module_count

    def make(self):
        self.make_impl(False, self.get_best_mask_pattern())

    def make_impl(self, test, mask_pattern):
        # Allocate an empty (None-filled) matrix, lay down the fixed function
        # patterns, then map the data bits into the remaining modules.
        self.module_count = self.type_number * 4 + 17
        self.modules = [[None] * self.module_count for _ in range(self.module_count)]
        self.setup_position_probe_pattern(0, 0)
        self.setup_position_probe_pattern(self.module_count - 7, 0)
        self.setup_position_probe_pattern(0, self.module_count - 7)
        self.setup_position_adjust_pattern()
        self.setup_timing_pattern()
        self.setup_type_info(test, mask_pattern)
        if self.type_number >= 7:
            self.setup_type_number(test)
        if self.data_cache is None:
            self.data_cache = create_data(
                self.type_number, self.error_correct_level, self.data_list
            )
        self.map_data(self.data_cache, mask_pattern)

    def setup_position_probe_pattern(self, row, col):
        # The 7x7 finder pattern (with its 1-module light border where it
        # fits inside the matrix), placed at one of the three corners.
        for r in range(-1, 8):
            if row + r <= -1 or self.module_count <= row + r:
                continue
            for c in range(-1, 8):
                if col + c <= -1 or self.module_count <= col + c:
                    continue
                if ((0 <= r <= 6 and (c == 0 or c == 6))
                        or (0 <= c <= 6 and (r == 0 or r == 6))
                        or (2 <= r <= 4 and 2 <= c <= 4)):
                    self.modules[row + r][col + c] = True
                else:
                    self.modules[row + r][col + c] = False

    def get_best_mask_pattern(self):
        # Try all eight masks, keep the one with the lowest penalty score.
        min_lost_point = 0
        pattern = 0
        for i in range(8):
            self.make_impl(True, i)
            lost_point = get_lost_point(self)
            if i == 0 or min_lost_point > lost_point:
                min_lost_point = lost_point
                pattern = i
        return pattern

    def setup_timing_pattern(self):
        # The alternating dark/light timing lines on row 6 and column 6,
        # filling only modules not already claimed by a function pattern.
        for r in range(8, self.module_count - 8):
            if self.modules[r][6] is not None:
                continue
            self.modules[r][6] = (r % 2 == 0)
        for c in range(8, self.module_count - 8):
            if self.modules[6][c] is not None:
                continue
            self.modules[6][c] = (c % 2 == 0)

    def setup_position_adjust_pattern(self):
        # Place a 5x5 alignment pattern at every combination of center
        # coordinates, except where one would overlap a finder (already set).
        pos = get_pattern_position(self.type_number)
        for i in range(len(pos)):
            for j in range(len(pos)):
                row = pos[i]
                col = pos[j]
                if self.modules[row][col] is not None:
                    continue
                for r in range(-2, 3):
                    for c in range(-2, 3):
                        if (r == -2 or r == 2 or c == -2 or c == 2
                                or (r == 0 and c == 0)):
                            self.modules[row + r][col + c] = True
                        else:
                            self.modules[row + r][col + c] = False

    def setup_type_number(self, test):
        # Version information (18 bits, BCH-protected) placed near the
        # top-right and bottom-left finders, for version 7 and above.
        bits = get_bch_type_number(self.type_number)
        for i in range(18):
            mod = (not test) and ((bits >> i) & 1) == 1
            self.modules[i // 3][i % 3 + self.module_count - 8 - 3] = mod
        for i in range(18):
            mod = (not test) and ((bits >> i) & 1) == 1
            self.modules[i % 3 + self.module_count - 8 - 3][i // 3] = mod

    def setup_type_info(self, test, mask_pattern):
        # Format information (15 bits): the EC level and mask, BCH-protected
        # and masked, written twice (once around the top-left finder, once
        # split across the other two) so a reader can always recover it.
        data = (self.error_correct_level << 3) | mask_pattern
        bits = get_bch_type_info(data)
        for i in range(15):
            mod = (not test) and ((bits >> i) & 1) == 1
            if i < 6:
                self.modules[i][8] = mod
            elif i < 8:
                self.modules[i + 1][8] = mod
            else:
                self.modules[self.module_count - 15 + i][8] = mod
        for i in range(15):
            mod = (not test) and ((bits >> i) & 1) == 1
            if i < 8:
                self.modules[8][self.module_count - i - 1] = mod
            elif i < 9:
                self.modules[8][15 - i - 1 + 1] = mod
            else:
                self.modules[8][15 - i - 1] = mod
        # The single fixed "always dark" module below the top-left finder.
        self.modules[self.module_count - 8][8] = (not test)

    def map_data(self, data, mask_pattern):
        # Walk the matrix in the standard zig-zag (two columns at a time,
        # right to left, alternating upward/downward), dropping data bits
        # MSB-first into every module not already used by a function pattern,
        # and applying the chosen mask as we go.
        inc = -1
        row = self.module_count - 1
        bit_index = 7
        byte_index = 0

        col = self.module_count - 1
        while col > 0:
            if col == 6:
                col -= 1
            while True:
                for c in range(2):
                    if self.modules[row][col - c] is None:
                        dark = False
                        if byte_index < len(data):
                            dark = ((data[byte_index] >> bit_index) & 1) == 1
                        mask = get_mask(mask_pattern, row, col - c)
                        if mask:
                            dark = not dark
                        self.modules[row][col - c] = dark
                        bit_index -= 1
                        if bit_index == -1:
                            byte_index += 1
                            bit_index = 7
                row += inc
                if row < 0 or self.module_count <= row:
                    row -= inc
                    inc = -inc
                    break
            col -= 2


def create_data(type_number, error_correct_level, data_list):
    """Assemble the final interleaved codeword stream for the matrix.

    Concatenate each chunk's (mode, length, payload) bits, add the
    terminator, byte-align, pad to capacity with 0xEC/0x11, then hand off to
    create_bytes for Reed-Solomon and block interleaving.
    """
    rs_blocks = get_rs_blocks(type_number, error_correct_level)
    buffer = QRBitBuffer()
    for data in data_list:
        buffer.put(data.mode, 4)
        buffer.put(data.get_length(), get_length_in_bits(data.mode, type_number))
        data.write(buffer)

    total_data_count = 0
    for block in rs_blocks:
        total_data_count += block.data_count

    if buffer.get_length_in_bits() > total_data_count * 8:
        # Signal "does not fit" the same way the JS does: raise so the
        # automatic version search moves on to the next larger version.
        raise ValueError(
            "code length overflow. (%d>%d)"
            % (buffer.get_length_in_bits(), total_data_count * 8)
        )

    # Four-bit terminator, but only if there is room for it.
    if buffer.get_length_in_bits() + 4 <= total_data_count * 8:
        buffer.put(0, 4)

    # Pad up to a byte boundary.
    while buffer.get_length_in_bits() % 8 != 0:
        buffer.put_bit(False)

    # Fill the remaining capacity with the alternating pad bytes.
    while True:
        if buffer.get_length_in_bits() >= total_data_count * 8:
            break
        buffer.put(QRCodeModel.PAD0, 8)
        if buffer.get_length_in_bits() >= total_data_count * 8:
            break
        buffer.put(QRCodeModel.PAD1, 8)

    return create_bytes(buffer, rs_blocks)


def create_bytes(buffer, rs_blocks):
    """Split the data into blocks, compute EC codewords per block, then
    interleave data codewords and EC codewords into the final byte stream."""
    offset = 0
    max_dc_count = 0
    max_ec_count = 0
    dcdata = [None] * len(rs_blocks)
    ecdata = [None] * len(rs_blocks)

    for r in range(len(rs_blocks)):
        dc_count = rs_blocks[r].data_count
        ec_count = rs_blocks[r].total_count - dc_count
        max_dc_count = max(max_dc_count, dc_count)
        max_ec_count = max(max_ec_count, ec_count)

        dcdata[r] = [0] * dc_count
        for i in range(len(dcdata[r])):
            dcdata[r][i] = 0xFF & buffer.buffer[i + offset]
        offset += dc_count

        rs_poly = get_error_correct_polynomial(ec_count)
        raw_poly = QRPolynomial(dcdata[r], rs_poly.get_length() - 1)
        mod_poly = raw_poly.mod(rs_poly)
        ecdata[r] = [0] * (rs_poly.get_length() - 1)
        for i in range(len(ecdata[r])):
            mod_index = i + mod_poly.get_length() - len(ecdata[r])
            ecdata[r][i] = mod_poly.get(mod_index) if mod_index >= 0 else 0

    total_code_count = 0
    for block in rs_blocks:
        total_code_count += block.total_count

    data = [0] * total_code_count
    index = 0

    # Interleave the data codewords column by column across blocks, then the
    # EC codewords the same way. This is the standard QR interleaving order.
    for i in range(max_dc_count):
        for r in range(len(rs_blocks)):
            if i < len(dcdata[r]):
                data[index] = dcdata[r][i]
                index += 1
    for i in range(max_ec_count):
        for r in range(len(rs_blocks)):
            if i < len(ecdata[r]):
                data[index] = ecdata[r][i]
                index += 1

    return data


def build_qr(text):
    """Return a made QRCodeModel for `text`, choosing the smallest level-M
    version (1..40) that fits. Raises ValueError if it does not fit any.

    Mirrors the reference factory `qrcode(0)`: try versions in order and keep
    the first that encodes without overflow.
    """
    model = None
    for type_number in range(1, 41):
        try:
            candidate = QRCodeModel(type_number, EC_LEVEL_M)
            candidate.add_data(text)
            candidate.make()
            model = candidate
            break
        except ValueError:
            model = None
    if model is None:
        raise ValueError("data too long for QR level M")
    return model


# ---------------------------------------------------------------------------
# Output: raw matrix (for verification) and terminal rendering (for humans).
# ---------------------------------------------------------------------------

def matrix_lines(model):
    """Yield the verification-format lines: module count, then one row per
    line of '0'/'1' characters ('1' = dark)."""
    n = model.get_module_count()
    yield str(n)
    for r in range(n):
        yield "".join("1" if model.is_dark(r, c) else "0" for c in range(n))


def render_terminal(model):
    """Render the QR to a string of ANSI-colored half-block rows.

    We use the Unicode upper-half-block 'U+2580' with an explicit foreground
    (the top module) and background (the bottom module) color, so each output
    character covers one module column and two module rows. Dark modules are
    black, light modules white, both stated explicitly so the code scans on
    any terminal theme (light or dark, over SSH, etc.).

    A quiet zone of four light modules is added on all four sides, as the
    spec requires for reliable scanning.
    """
    n = model.get_module_count()
    quiet = 4
    size = n + quiet * 2

    # Build a boolean grid (True = dark) including the quiet zone. Anything
    # outside the actual matrix stays light (False).
    grid = [[False] * size for _ in range(size)]
    for r in range(n):
        for c in range(n):
            if model.is_dark(r, c):
                grid[r + quiet][c + quiet] = True

    # If the row count is odd, add one trailing light row so the final pair
    # of rows still forms a complete half-block cell.
    rows = size
    if rows % 2 == 1:
        grid.append([False] * size)
        rows += 1

    black_fg = "\033[38;2;0;0;0m"
    white_fg = "\033[38;2;255;255;255m"
    black_bg = "\033[48;2;0;0;0m"
    white_bg = "\033[48;2;255;255;255m"
    upper_half = "▀"  # the character draws the TOP half in the fg color
    reset = "\033[0m"

    out_lines = []
    for r in range(0, rows, 2):
        top = grid[r]
        bottom = grid[r + 1]
        line = []
        for c in range(size):
            # Foreground paints the top module, background the bottom one.
            fg = black_fg if top[c] else white_fg
            bg = black_bg if bottom[c] else white_bg
            line.append(fg + bg + upper_half)
        line.append(reset)
        out_lines.append("".join(line))
    return "\n".join(out_lines)


USAGE = "usage: qr.py [--matrix] \"<text>\"\n"


def main(argv):
    args = argv[1:]

    matrix_mode = False
    if args and args[0] == "--matrix":
        matrix_mode = True
        args = args[1:]

    # Exactly one text argument is required, and it must be non-empty.
    if len(args) != 1 or args[0] == "":
        sys.stderr.write(USAGE)
        return 2

    text = args[0]

    try:
        model = build_qr(text)
    except ValueError:
        sys.stderr.write("error: text too long to encode at EC level M\n")
        return 1

    if matrix_mode:
        sys.stdout.write("\n".join(matrix_lines(model)) + "\n")
    else:
        sys.stdout.write(render_terminal(model) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
