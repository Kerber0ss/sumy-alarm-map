"""Decode public ~4/~5 snapshots (mapRuntime.js, checked 2026-10-31).

Only public targets and their freshness metadata are retained; heat trails are
not used by this viewer. No downloaded JavaScript is executed.
"""
import base64
import math
import re
import struct
import uuid

MASK = 0xffffffff


def _random(seed):
    value = seed[0] or 1831565813
    value ^= (value << 13) & MASK
    value ^= value >> 17
    value ^= (value << 5) & MASK
    seed[0] = value & MASK
    return seed[0]


def _unpack_frame(frame):
    if not isinstance(frame, str) or not frame.startswith(("~4:", "~5:")):
        raise ValueError("Unsupported public target frame")
    encoded = frame[3:]
    if not 0 < len(encoded) <= 11184832 or len(encoded) % 4 == 1 or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded):
        raise ValueError("Invalid public target frame")
    data = bytearray(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    if not 17 <= len(data) <= 8388624:
        raise ValueError("Invalid public target frame size")
    first, second, third, checksum = struct.unpack_from("<4I", data)
    # Public wire-format mask shipped to every map client; not an API credential.
    state = [1634760805, 857760878, 2036477234, 1797285236,
             2838917605, 566540499, 2028117766, 3025996967,
             1063430289, 3353677899, 1519178294, 2422993229,
             1, first, second, third]

    def rotate(value, count):
        return ((value << count) | (value >> (32 - count))) & MASK

    def quarter(words, a, b, c, d):
        words[a] = (words[a] + words[b]) & MASK
        words[d] = rotate(words[d] ^ words[a], 16)
        words[c] = (words[c] + words[d]) & MASK
        words[b] = rotate(words[b] ^ words[c], 12)
        words[a] = (words[a] + words[b]) & MASK
        words[d] = rotate(words[d] ^ words[a], 8)
        words[c] = (words[c] + words[d]) & MASK
        words[b] = rotate(words[b] ^ words[c], 7)

    for offset in range(16, len(data), 64):
        words = state.copy()
        for _ in range(10):
            for indices in ((0, 4, 8, 12), (1, 5, 9, 13), (2, 6, 10, 14), (3, 7, 11, 15),
                            (0, 5, 10, 15), (1, 6, 11, 12), (2, 7, 8, 13), (3, 4, 9, 14)):
                quarter(words, *indices)
        block = struct.pack("<16I", *((a + b) & MASK for a, b in zip(words, state)))
        for i in range(min(64, len(data) - offset)):
            data[offset + i] ^= block[i]
        state[12] = (state[12] + 1) & MASK
    actual = 2166136261
    for byte in data[16:]:
        actual = ((actual ^ byte) * 16777619) & MASK
    if actual != checksum:
        raise ValueError("Damaged public target frame")

    order_seed = [first ^ third ^ 2246822507]
    value_seed = [3266489909 ^ second]
    tag_seed = [first ^ second ^ third ^ 668265263]
    tags = list(range(10))
    for i in range(9, 0, -1):
        j = _random(tag_seed) % (i + 1)
        tags[i], tags[j] = tags[j], tags[i]
    inverse = {value: i for i, value in enumerate(tags)}
    offset, nodes = 16, 0
    strings, numbers = [], []

    def take(size):
        nonlocal offset
        if size < 0 or size > len(data) - offset:
            raise ValueError("Truncated public target frame")
        result = data[offset:offset + size]
        offset += size
        return result

    def integer():
        result = 0
        for i in range(8):
            byte = take(1)[0]
            result += (byte & 127) << (7 * i)
            if result > 9007199254740991:
                break
            if not byte & 128:
                return result
        raise ValueError("Invalid public frame integer")

    def read(depth=0):
        nonlocal nodes
        nodes += 1
        if depth > 63 or nodes > 1000000:
            raise ValueError("Public frame exceeds codec limits")
        tag = inverse.get(take(1)[0])
        if tag in (0, 1, 2):
            return (None, False, True)[tag]
        if tag == 3:
            value = integer()
            value = (value & ~MASK) + ((value & MASK) ^ (_random(value_seed) & 65535))
            return -(value + 1) // 2 if value % 2 else value // 2
        if tag == 4:
            low, high = struct.unpack("<2I", take(8))
            value = struct.unpack("<d", struct.pack("<2I", low ^ _random(value_seed), high ^ _random(value_seed)))[0]
            if not math.isfinite(value):
                raise ValueError("Invalid public frame number")
            numbers.append(value)
            return value
        if tag == 5:
            raw = take(integer())
            mask = _random(value_seed)
            value = bytes(byte ^ ((mask >> (8 * (i % 4))) & 255) for i, byte in enumerate(raw)).decode("utf-8", errors="replace")
            strings.append(value)
            return value
        if tag == 6:
            size = integer()
            if size > min(len(data) - offset, 1000000 - nodes):
                raise ValueError("Invalid public frame array size")
            result = [None] * size
            if size:
                start = _random(order_seed) % size
                reverse = bool(_random(order_seed) & 1)
                for i in range(size):
                    result[(start + (size - i if reverse else i)) % size] = read(depth + 1)
            return result
        if tag in (7, 8):
            values = strings if tag == 7 else numbers
            index = integer()
            if index >= len(values):
                raise ValueError("Invalid public frame reference")
            return values[index]
        raise ValueError("Invalid public frame value")

    result = read()
    if offset != len(data) or not isinstance(result, list):
        raise ValueError("Invalid public frame envelope")
    if frame.startswith("~5:"):
        # v5 rearranges the same tables into presentation planes.
        if (len(result) != 6 or type(result[0]) is not int or result[0] != 5
                or any(not isinstance(part, list) or len(part) != size
                       for part, size in zip(result[1:], (2, 2, 5, 3, 4)))):
            raise ValueError("Invalid public presentation planes")
        _, (revision, epoch), (coverage, enabled), timing, tables, rows = result
        clock, updated, extrapolated, fog, ttl = timing
        ids, cells, styles = tables
        extrapolation, trail, targets, movement = rows
        payload = [clock, updated, extrapolated, fog, ttl, cells, styles, ids,
                   targets, trail, extrapolation, movement]
    else:
        if len(result) != 5:
            raise ValueError("Invalid public frame envelope")
        epoch, revision, enabled, coverage, payload = result
    if (not isinstance(epoch, str) or not isinstance(revision, str) or not isinstance(enabled, bool)
            or type(coverage) not in (int, float) or not 0 <= coverage <= 100
            or not isinstance(payload, list) or len(payload) != 12):
        raise ValueError("Invalid public frame metadata")
    return enabled, payload


def decode_targets(data):
    """Return the subset consumed by server.py; fail closed on unknown formats."""
    try:
        enabled, payload = _unpack_frame(data.get("n") if "n" in data else data.get("r"))
        clock, updated, _, _, ttl, cells, styles, ids, rows, _, _, _ = payload
        if (type(clock) not in (int, float) or not 0 < clock <= 9007199254740991
                or (updated is not None and (type(updated) not in (int, float) or not -clock <= updated <= 9007199254740991 - clock))
                or type(ttl) not in (int, float) or not math.isfinite(ttl) or not 0 < ttl <= 300
                or not all(isinstance(v, list) for v in (cells, styles, ids, rows))):
            raise ValueError("Invalid public target snapshot")

        def reference(values, index):
            if type(index) is not int or not 0 <= index < len(values):
                raise ValueError("Invalid target reference")
            return values[index]

        targets = []
        for row in rows:
            if not isinstance(row, list) or not 7 <= len(row) <= 13:
                raise ValueError("Invalid public target row")
            rid, cell, style, heading, count, _, _ = row[:7]
            position, appearance, track_id = reference(cells, cell), reference(styles, style), reference(ids, rid)
            if len(position) < 4 or len(appearance) < 5 or not isinstance(track_id, str):
                raise ValueError("Invalid public target fields")
            if track_id.startswith("~~"):
                track_id = track_id[1:]
            elif track_id.startswith("~"):
                track_id = uuid.UUID(bytes_le=base64.urlsafe_b64decode(track_id[1:] + "==")).hex
            targets.append({"trackId": track_id, "x": position[0], "y": position[1],
                            "type": appearance[0], "detectedType": appearance[2], "iconName": appearance[3],
                            "heading": heading, "currentCount": count,
                            "isFading": bool(row[9]) if len(row) > 9 else False})
        return {"targets": targets if enabled else [], "serverTime": clock,
                "updatedAt": clock + updated if updated is not None else 0, "snapshotTtl": ttl}
    except (AttributeError, IndexError, TypeError, struct.error, OverflowError) as error:
        raise ValueError("Invalid public target snapshot") from error
