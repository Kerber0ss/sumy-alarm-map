#!/usr/bin/env python3
"""Local, read-only viewer of the public Ukraine Alarm map."""
import argparse
import json
import math
import mimetypes
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from neptun import decode_neptun

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
REGIONS = json.loads((ROOT / "sumy-regions.json").read_text())
GEOMETRY = json.loads((PUBLIC / "sumy.geojson").read_text())
FEATURES = {str(f["properties"]["regionId"]): f for f in GEOMETRY["features"]}
BASE = "https://map.ukrainealarm.com"
HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json", "Referer": BASE + "/"}
ENDPOINTS = {"alerts": "/api/v2/data/mapUpdate",
             "targets": "https://neptun.in.ua/api/v1/threats"}
POOL = ThreadPoolExecutor(max_workers=2)
CACHE, LOCK = {}, threading.Lock()
DISTRICTS = {str(d["districtId"]): d for d in REGIONS["districts"]}
COMMUNITY_DISTRICT = {str(c["communityId"]): str(d["districtId"])
                      for d in REGIONS["districts"] for c in d["communities"]}


def fetch_source(name):
    url = ENDPOINTS[name]
    request = urllib.request.Request(url if url.startswith("https://") else BASE + url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=12) as response:
        data = json.load(response)
    if name == "targets":
        data = decode_neptun(data)
    if not isinstance(data, dict) or not isinstance(data.get(name), list):
        raise ValueError("Невідомий формат відповіді джерела")
    if any(not isinstance(row, dict) for row in data[name]):
        raise ValueError("Некоректні записи джерела")
    return data


def normalized_to_lnglat(x, y):
    x, y = float(x), float(y)
    if not (math.isfinite(x) and math.isfinite(y) and 0 <= x <= 1 and 0 <= y <= 1):
        raise ValueError("Invalid normalized coordinates")
    west, east, south, north = 22.137059, 40.2275801, 44.184598, 52.3791473
    merc = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    pw, ph = math.radians(east - west), merc(north) - merc(south)
    scale = min(260 / pw, 175 / ph)
    ox, oy = (260 - pw * scale) / 2, (175 - ph * scale) / 2
    lon = west + math.degrees((x * 260 - ox) / scale)
    my = merc(north) - (y * 175 - oy) / scale
    return lon, math.degrees(2 * math.atan(math.exp(my)) - math.pi / 2)


def in_ring(x, y, ring):
    inside = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0])
        if abs(cross) < 1e-10 and min(a[0], b[0]) <= x <= max(a[0], b[0]) and min(a[1], b[1]) <= y <= max(a[1], b[1]):
            return True
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def contains(lon, lat, geometry):
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return any(in_ring(lon, lat, p[0]) and not any(in_ring(lon, lat, hole) for hole in p[1:]) for p in polygons)


def air_alerts(rows, region_id):
    found = []
    for row in rows:
        if str(row.get("regionId")) != region_id:
            continue
        for alert in row.get("activeAlerts", []):
            if str(alert.get("type", "")).upper() not in ("AIR", "1"):
                continue
            levels = alert.get("activeAlertLevels") or [{}]
            for level in levels:
                name = str(level.get("alertLevel", "")).lower()
                found.append({"level": name if name in ("red", "yellow") else "unknown",
                              "reason": level.get("reason") or "Повітряна тривога",
                              "since": level.get("createdAt") or alert.get("lastUpdate"),
                              "source": row.get("regionName", ""),
                              "regionId": str(alert.get("regionId", region_id))})
    return found


def alert_level(items):
    return next((level for level in ("red", "yellow", "unknown") if any(a["level"] == level for a in items)), "none")


def target_kind(target):
    # A default Shahed icon in the source renderer is not a positive classification.
    neptun_kinds = {"uav": "drone", "recon": "recon", "fpv": "fpv", "ballistic": "ballistic", "kab": "airbomb", "mig31k": "mig31k"}
    if target.get("type") in neptun_kinds:
        return neptun_kinds[target["type"]]
    classification = str(target.get("detectedType") or "") + " " + str(target.get("iconName") or "")
    classification = classification.lower()
    if "shahed" in classification:
        return "shahed-jet" if "jet" in classification else "shahed"
    for key in ("missile", "banderol", "airbomb", "drone"):
        if key in classification:
            return key
    return "unknown"


def source_status(name, now):
    entry = CACHE[name]
    data = entry.get("data") or {}
    age = now - entry.get("fetchedAt", 0)
    fresh = bool(entry.get("ok")) and age <= 30
    snapshot_age = None
    if name == "targets":
        try:
            snapshot_age = max(0, (float(data["serverTime"]) - float(data["updatedAt"])) / 1000) + age
            ttl = float(data["snapshotTtl"])
            fresh = fresh and math.isfinite(snapshot_age) and 0 < ttl and snapshot_age <= ttl
        except (KeyError, TypeError, ValueError):
            fresh = False
    return {"fresh": fresh, "fetchedAt": entry.get("fetchedAt"), "age": round(age, 1),
            "snapshotAge": snapshot_age, "error": entry.get("error"),
            "updatedAt": data.get("updatedAt"), "ttl": data.get("snapshotTtl")}


def make_state(now):
    statuses = {name: source_status(name, now) for name in ENDPOINTS}
    rows = (CACHE["alerts"].get("data") or {}).get("alerts", [])
    parent = air_alerts(rows, "20")
    districts = []
    communities = []
    for region_id, district in DISTRICTS.items():
        alerts = parent + air_alerts(rows, region_id)
        local = []
        for community in district["communities"]:
            cid = str(community["communityId"])
            own = air_alerts(rows, cid)
            if own:
                effective = alerts + own
                communities.append({"id": cid, "name": community["communityName"],
                                    "level": alert_level(effective), "alerts": effective})
                # Inherited district alerts are not a second local alarm.
                if any(a["regionId"] == cid for a in own):
                    local.append({"name": community["communityName"], "level": alert_level(own)})
        districts.append({"id": region_id, "name": district["districtName"],
                          "level": alert_level(alerts), "alerts": alerts, "local": local})
    targets = []
    rejected = 0
    if statuses["targets"]["fresh"]:
        for raw in (CACHE["targets"].get("data") or {}).get("targets", []):
            try:
                area_only = bool(raw.get("areaOnly"))
                if "lon" in raw or "lat" in raw:
                    lon, lat = float(raw["lon"]), float(raw["lat"])
                    if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
                        raise ValueError("Invalid coordinates")
                else:
                    lon, lat = normalized_to_lnglat(raw["x"], raw["y"])
                if area_only and raw.get("region") != "Сумська область":
                    continue
                if not area_only and not contains(lon, lat, FEATURES["20"]["geometry"]):
                    continue
                district_id = next((rid for rid in DISTRICTS if contains(lon, lat, FEATURES[rid]["geometry"])), None)
                community = next((FEATURES[cid]["properties"]["name"] for cid in COMMUNITY_DISTRICT
                                  if cid in FEATURES and contains(lon, lat, FEATURES[cid]["geometry"])), "")
                heading = None if area_only else raw.get("heading")
                heading = float(heading) % 360 if heading is not None and math.isfinite(float(heading)) else None
                if not isinstance(raw.get("trackId"), str) or not raw["trackId"]:
                    raise ValueError("Missing track ID")
                targets.append({"title": raw.get("title", ""), "areaOnly": area_only,
                                "locality": raw.get("locality", ""),
                                "description": raw.get("explanationShort", ""),
                                "confidence": raw.get("displayConfidence") or raw.get("confidenceLevel"),
                                "sourceCount": raw.get("sourceCount"), "updatedAt": raw.get("updatedAt"),
                                "uncertaintyKm": raw.get("uncertaintyKm"),
                                "positionQuality": raw.get("positionQuality"),
                                "advisory": bool(raw.get("advisory")),
                                "presumptiveCourse": bool(raw.get("presumptiveCourse")),
                                "velocity": raw.get("velocity") if not area_only else None,
                                "id": str(raw["trackId"]), "lon": lon, "lat": lat,
                                "heading": heading, "kind": target_kind(raw),
                                "classification": raw.get("detectedType") or "",
                                "iconName": raw.get("iconName") or "",
                                "districtId": district_id, "community": community,
                                "count": raw.get("currentCount"), "fading": bool(raw.get("isFading"))})
            except (ValueError, KeyError, TypeError):
                rejected += 1
    return {"generatedAt": now, "sources": statuses, "districts": districts,
            "communities": communities, "targets": targets, "rejectedTargets": rejected}


def get_state():
    with LOCK:
        now = time.time()
        due = [name for name in ENDPOINTS if now - CACHE.get(name, {}).get("attemptAt", 0) >= 10]
        pending = {name: POOL.submit(fetch_source, name) for name in due}
        for name, future in pending.items():
            entry = CACHE.setdefault(name, {})
            entry["attemptAt"] = now
            try:
                entry.update(data=future.result(), fetchedAt=time.time(), ok=True, error=None)
            except (OSError, ValueError, TypeError) as error:
                entry.update(ok=False, error="HTTP " + str(error.code) if isinstance(error, urllib.error.HTTPError) else "Джерело тимчасово недоступне")
        return make_state(time.time())


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/state":
            payload = json.dumps(get_state(), ensure_ascii=False, allow_nan=False).encode()
            self.send_payload(payload, "application/json; charset=utf-8", cache="no-store")
            return
        # Only public files are served; APKs, reports and session tokens are unreachable.
        file = (PUBLIC / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
        if not file.is_relative_to(PUBLIC) or not file.is_file():
            self.send_error(404)
            return
        self.send_payload(file.read_bytes(), mimetypes.guess_type(file.name)[0] or "application/octet-stream")

    def send_payload(self, body, content_type, cache="no-cache"):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Сумщина · http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        POOL.shutdown(wait=False, cancel_futures=True)
