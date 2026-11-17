import copy
import io
import json
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import server
from neptun import decode_neptun


class UkraineMapTests(unittest.TestCase):
    def setUp(self):
        self.saved = copy.deepcopy(server.CACHE)
        self.now = time.time()
        server.CACHE.clear()
        server.CACHE.update({
            "alerts": {"ok": True, "fetchedAt": self.now, "data": {"raions": [], "oblasts": []}},
            "targets": {"ok": True, "fetchedAt": self.now, "data": {
                "targets": [], "serverTime": self.now * 1000, "updatedAt": self.now * 1000, "snapshotTtl": 30}},
        })

    def tearDown(self):
        server.CACHE.clear()
        server.CACHE.update(self.saved)

    def state(self):
        return server.make_state(self.now)

    def set_threats(self, *rows):
        server.CACHE["targets"]["data"] = decode_neptun({
            "serverTime": datetime.now(timezone.utc).isoformat(), "threats": list(rows)})

    def threat(self, id="track", **fields):
        row = {"id": id, "type": "uav", "title": "БПЛА", "lat": 50.91, "lon": 34.8,
               "region": "Сумська область", "heading": 270, "status": "active", "count": 3,
               "confidenceLevel": "high", "sourceCount": 2}
        return {**row, **fields}

    def test_all_regions_districts_and_separate_cities_exist(self):
        state = self.state()
        self.assertEqual(len(state["regions"]), 27)
        self.assertEqual(len(server.DISTRICTS), 136)
        self.assertEqual(len(state["districts"]), 138)
        self.assertEqual(set(server.CITIES), {"oblast:м. київ", "oblast:севастополь"})
        self.assertEqual(len(server.FEATURES), 163)
        self.assertTrue(all(d["properties"]["parentId"] in server.OBLASTS for d in server.DISTRICTS.values()))

    def test_regions_include_crimea_kyiv_and_sevastopol(self):
        for point, expected in [((34.1, 44.95), "автономна республіка крим"),
                                ((30.52, 50.45), "м. київ"), ((33.52, 44.6), "севастополь"),
                                ((24.03, 49.84), "львівська"), ((36.23, 49.99), "харківська")]:
            self.assertTrue(server.contains(*point, server.OBLASTS['oblast:' + expected]["geometry"]))

    def test_oblast_alert_inherits_only_to_its_districts(self):
        server.CACHE["alerts"]["data"]["oblasts"] = [{"key": "сумська", "level": "yellow"}]
        state = self.state()
        sumy = [d for d in state["districts"] if d["regionId"] == "oblast:сумська"]
        self.assertEqual(len(sumy), 5)
        self.assertTrue(all(d["level"] == "yellow" for d in sumy))
        self.assertTrue(all(d["level"] == "none" for d in state["districts"] if d not in sumy))

    def test_red_wins_and_local_yellow_is_preserved(self):
        server.CACHE["alerts"]["data"] = {
            "oblasts": [{"key": "київська", "level": "yellow"}],
            "raions": [{"key": "бучанський", "level": "red", "since": "2026-11-14T12:00:00Z"}]}
        state = self.state()
        bucha = next(d for d in state["districts"] if d["id"] == "raion:бучанський")
        self.assertEqual(bucha["level"], "red")
        self.assertEqual({a["level"] for a in bucha["alerts"]}, {"red", "yellow"})
        kyiv = next(d for d in state["districts"] if d["id"] == "oblast:м. київ")
        self.assertEqual(kyiv["level"], "none")

    def test_occupied_oblast_and_city_alerts_are_shown(self):
        server.CACHE["alerts"]["data"]["oblasts"] = [
            {"key": key} for key in ("автономна республіка крим", "севастополь", "м. київ")]
        state = self.state()
        for d in state["districts"]:
            if d["regionId"] in {"oblast:автономна республіка крим", "oblast:севастополь", "oblast:м. київ"}:
                self.assertEqual(d["level"], "red")

    def test_unknown_alert_level_is_not_an_all_clear(self):
        server.CACHE["alerts"]["data"]["raions"] = [{"key": "конотопський", "level": "purple"}]
        d = next(d for d in self.state()["districts"] if d["id"] == "raion:конотопський")
        self.assertEqual(d["level"], "unknown")

    def test_targets_across_ukraine_and_border_approaches_are_retained(self):
        self.set_threats(self.threat(), self.threat("kyiv", lat=50.45, lon=30.52, region="м. Київ"),
                         self.threat("odesa", lat=46.48, lon=30.73, region="Одеська область"),
                         self.threat("border", lat=53, lon=32, region=""))
        targets = self.state()["targets"]
        self.assertEqual({t["id"] for t in targets}, {"track", "kyiv", "odesa", "border"})
        self.assertEqual(next(t for t in targets if t["id"] == "kyiv")["regionId"], "oblast:м. київ")

    def test_metadata_and_course_reach_client(self):
        self.set_threats(self.threat(heading=-90, explanationShort="Опис", velocity={"speedKmh": 150}, advisory=True))
        t = self.state()["targets"][0]
        self.assertEqual((t["heading"], t["count"], t["confidence"], t["sourceCount"]), (270, 3, "high", 2))
        self.assertEqual(t["description"], "Опис")
        self.assertEqual(t["velocity"]["speedKmh"], 150)
        self.assertTrue(t["advisory"])

    def test_area_only_is_retained_for_any_oblast_without_course(self):
        self.set_threats(self.threat(areaOnly=True, region="Одеська область", lat=46.5, lon=30.7,
                                    velocity={"speedKmh": 150}))
        t = self.state()["targets"][0]
        self.assertTrue(t["areaOnly"])
        self.assertEqual(t["regionId"], "oblast:одеська")
        self.assertIsNone(t["districtId"])
        self.assertIsNone(t["heading"])
        self.assertIsNone(t["velocity"])

    def test_bad_coordinates_ids_and_resolved_targets_are_hidden(self):
        for fields in ({"lon": float("nan")}, {"lat": 91}, {"status": "resolved"}, {"id": None}):
            with self.subTest(fields=fields):
                self.set_threats(self.threat(**fields))
                self.assertEqual(self.state()["targets"], [])

    def test_missing_course_and_stale_target(self):
        self.set_threats(self.threat(heading=None, status="stale"))
        t = self.state()["targets"][0]
        self.assertIsNone(t["heading"])
        self.assertTrue(t["fading"])

    def test_failed_and_expired_snapshots_are_hidden(self):
        self.set_threats(self.threat())
        server.CACHE["targets"]["ok"] = False
        self.assertEqual(self.state()["targets"], [])
        server.CACHE["targets"]["ok"] = True
        server.CACHE["targets"]["data"]["updatedAt"] -= 31000
        self.assertEqual(self.state()["targets"], [])

    def test_old_empty_snapshot_is_also_unavailable(self):
        server.CACHE["targets"]["data"] = decode_neptun({"serverTime": "2020-01-01T00:00:00Z", "threats": []})
        self.assertFalse(self.state()["sources"]["targets"]["fresh"])

    def test_network_failure_marks_both_sources_unavailable(self):
        with patch.object(server, "fetch_source", side_effect=OSError("offline")):
            state = server.get_state()
        self.assertFalse(state["sources"]["alerts"]["fresh"])
        self.assertFalse(state["sources"]["targets"]["fresh"])

    def test_request_throttling_uses_shared_cache(self):
        for entry in server.CACHE.values():
            entry["attemptAt"] = time.time()
        with patch.object(server, "fetch_source") as fetch:
            server.get_state()
        fetch.assert_not_called()

    def test_source_refreshes_at_five_seconds(self):
        for entry in server.CACHE.values():
            entry["attemptAt"] = self.now
        with patch.object(server.time, "time", return_value=self.now + 4.9), patch.object(server, "fetch_source") as fetch:
            server.get_state()
            fetch.assert_not_called()
        snapshots = {name: copy.deepcopy(entry["data"]) for name, entry in server.CACHE.items()}
        with patch.object(server.time, "time", return_value=self.now + 5), patch.object(server, "fetch_source", side_effect=lambda name: snapshots[name]) as fetch:
            server.get_state()
            self.assertEqual(fetch.call_count, 2)

    def test_fetch_uses_documented_neptun_endpoints(self):
        for source, raw in [("alerts", {"raions": [], "oblasts": []}),
                            ("targets", {"serverTime": datetime.now(timezone.utc).isoformat(), "threats": []})]:
            with patch.object(server.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(raw).encode())) as fetch:
                server.fetch_source(source)
            path = "alerts" if source == "alerts" else "threats"
            self.assertEqual(fetch.call_args.args[0].full_url, f"https://neptun.in.ua/api/v1/{path}")

    def test_malformed_alert_snapshot_fails_closed(self):
        for raw in ({}, {"raions": [], "oblasts": None}, {"raions": [{}], "oblasts": []}):
            with patch.object(server.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(raw).encode())):
                with self.assertRaises(ValueError):
                    server.fetch_source("alerts")

    def test_invalid_threat_snapshot_fails_closed(self):
        for raw in ({}, {"serverTime": "bad", "threats": []}, {"serverTime": "2026-11-14T12:00:00", "threats": []}):
            with self.assertRaises(ValueError):
                decode_neptun(raw)


if __name__ == "__main__":
    unittest.main()
