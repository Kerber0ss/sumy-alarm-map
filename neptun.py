"""Adapter for the documented public NEPTUN threat snapshot."""
from datetime import datetime
import time


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Missing NEPTUN server time")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("NEPTUN time must include timezone")
    return parsed.timestamp() * 1000


def decode_neptun(data):
    if not isinstance(data, dict) or not isinstance(data.get("threats"), list):
        raise ValueError("Invalid NEPTUN snapshot")
    clock = timestamp(data.get("serverTime"))
    targets = []
    icons = {"uav": "ic_drone", "recon": "ic_drone", "fpv": "ic_drone",
             "missile": "ic_missile", "ballistic": "ic_ballistic", "kab": "ic_airbomb"}
    for row in data["threats"]:
        if not isinstance(row, dict):
            raise ValueError("Invalid NEPTUN threat")
        if row.get("status") == "resolved":
            continue
        target = dict(row)
        target.update(trackId=row.get("id"), detectedType=row.get("type", "unknown"),
                      iconName=icons.get(row.get("type"), ""), currentCount=row.get("count"),
                      isFading=row.get("status") == "stale")
        targets.append(target)
    return {"targets": targets, "serverTime": time.time() * 1000, "updatedAt": clock,
            "snapshotTtl": 30}
