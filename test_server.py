import copy
import io
import json
import time
import unittest
from unittest.mock import patch

import server
from target_wire import decode_targets


class PublicTargetWireTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads((server.ROOT / "tests/fixtures/public-targets-v4.json").read_text())

    def test_recorded_response_matches_original_map_decoder(self):
        self.assertEqual(decode_targets(self.fixture["wire"]), self.fixture["expected"])

    def test_fetch_source_decodes_the_new_endpoint(self):
        with patch.object(server.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(self.fixture["wire"]).encode())) as fetch:
            self.assertEqual(server.fetch_source("targets"), self.fixture["expected"])
        self.assertEqual(fetch.call_args.args[0].full_url, server.BASE + "/api/centrifuge/map/fallback")

    def test_corrupt_truncated_and_unknown_frames_are_rejected(self):
        wire = self.fixture["wire"]["r"]
        for frame in (None, {}, {"r": "~5:abc"}, {"r": "~4:!"}, {"r": wire[:50]},
                      {"r": wire[:40] + ("A" if wire[40] != "A" else "B") + wire[41:]}):
            with self.subTest(frame=str(frame)[:60]), self.assertRaises(ValueError):
                decode_targets(frame)

    def test_disabled_public_delivery_hides_targets_and_bad_references_fail(self):
        from target_wire import _unpack_frame
        _, payload = _unpack_frame(self.fixture["wire"]["r"])
        with patch("target_wire._unpack_frame", return_value=(False, payload)):
            self.assertEqual(decode_targets(self.fixture["wire"])["targets"], [])
        for bad_index in (-1, len(payload[5]), None):
            bad = copy.deepcopy(payload)
            bad[8][0][1] = bad_index
            with patch("target_wire._unpack_frame", return_value=(True, bad)), self.assertRaises(ValueError):
                decode_targets(self.fixture["wire"])

    def test_null_update_and_invalid_clocks(self):
        from target_wire import _unpack_frame
        _, payload = _unpack_frame(self.fixture["wire"]["r"])
        payload[1] = None
        with patch("target_wire._unpack_frame", return_value=(False, payload)):
            self.assertEqual(decode_targets(self.fixture["wire"])["updatedAt"], 0)
        for clock in (float("nan"), float("inf"), 1e308, True, "bad"):
            payload[0] = clock
            with patch("target_wire._unpack_frame", return_value=(True, payload)), self.assertRaises(ValueError):
                decode_targets(self.fixture["wire"])


class MapDataTests(unittest.TestCase):
    def setUp(self):
        self.saved = copy.deepcopy(server.CACHE)
        now = time.time()
        server.CACHE.clear()
        server.CACHE.update({
            "alerts": {"ok": True, "fetchedAt": now, "data": {"alerts": []}},
            "targets": {"ok": True, "fetchedAt": now, "data": {"targets": [], "serverTime": now * 1000, "updatedAt": now * 1000, "snapshotTtl": 30}},
        })

    def tearDown(self):
        server.CACHE.clear()
        server.CACHE.update(self.saved)

    def test_red_wins_but_both_levels_are_retained(self):
        rows = [{"regionId": "115", "activeAlerts": [{"type": "AIR", "activeAlertLevels": [{"alertLevel": "Yellow"}, {"alertLevel": "Red"}]}]}]
        alerts = server.air_alerts(rows, "115")
        self.assertEqual(server.alert_level(alerts), "red")
        self.assertEqual({a["level"] for a in alerts}, {"red", "yellow"})
        rows[0]["activeAlerts"][0]["activeAlertLevels"] = [{"alertLevel": "Purple"}]
        self.assertEqual(server.alert_level(server.air_alerts(rows, "115")), "unknown")

    def test_unclassified_target_is_not_a_shahed(self):
        self.assertEqual(server.target_kind({"type": 8, "iconName": "", "detectedType": ""}), "unknown")
        self.assertEqual(server.target_kind({"detectedType": "ShahedJet"}), "shahed-jet")

    def test_oblast_alert_inherits_and_local_community_stays_local(self):
        server.CACHE["alerts"]["data"]["alerts"] = [
            {"regionId": "20", "activeAlerts": [{"type": "AIR", "activeAlertLevels": [{"alertLevel": "Yellow"}]}]},
            {"regionId": "1188", "activeAlerts": [{"regionId": "1188", "type": "AIR", "activeAlertLevels": [{"alertLevel": "Red"}]}]},
        ]
        state = server.make_state(time.time())
        self.assertTrue(all(d["level"] == "yellow" for d in state["districts"]))
        self.assertEqual(state["communities"][0]["level"], "red")
        self.assertEqual(next(d for d in state["districts"] if d["id"] == "114")["local"][0]["level"], "red")

    def test_expired_or_failed_targets_are_hidden(self):
        entry = server.CACHE["targets"]
        entry["data"]["targets"] = [{"trackId": "test", "x": .7, "y": .2}]
        entry["data"]["updatedAt"] -= 31000
        self.assertFalse(server.source_status("targets", time.time())["fresh"])
        self.assertEqual(server.make_state(time.time())["targets"], [])
        entry["data"]["updatedAt"] = entry["data"]["serverTime"]
        entry["ok"] = False
        self.assertFalse(server.source_status("targets", time.time())["fresh"])

    def test_geo_filter_does_not_include_other_regions(self):
        self.assertTrue(server.contains(34.8, 50.91, server.FEATURES["20"]["geometry"]))
        self.assertFalse(server.contains(30.52, 50.45, server.FEATURES["20"]["geometry"]))
        # Coordinates recorded from the official public map during this session.
        lon, lat = server.normalized_to_lnglat(.698559, .167376)
        self.assertAlmostEqual(lon, 34.82592, places=4)
        self.assertAlmostEqual(lat, 51.09911, places=4)
        self.assertTrue(server.contains(lon, lat, server.FEATURES["1188"]["geometry"]))
        with self.assertRaises(ValueError):
            server.normalized_to_lnglat(float("nan"), .5)
        with self.assertRaises(ValueError):
            server.normalized_to_lnglat(2, .5)

    def test_only_sumy_targets_are_exposed_with_their_course(self):
        server.CACHE["targets"]["data"]["targets"] = [
            {"trackId": "inside", "x": .698559, "y": .167376, "heading": 180},
            {"trackId": "outside", "x": .5, "y": .5, "detectedType": "Shahed"},
        ]
        targets = server.make_state(time.time())["targets"]
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0]["id"], "inside")
        self.assertEqual(targets[0]["districtId"], "114")
        self.assertEqual(targets[0]["heading"], 180)
        self.assertEqual(targets[0]["kind"], "unknown")

    def test_new_public_frame_reaches_sumy_map(self):
        fixture = json.loads((server.ROOT / "tests/fixtures/public-targets-v4.json").read_text())
        server.CACHE["targets"]["data"] = decode_targets(fixture["wire"])
        state = server.make_state(time.time())
        self.assertTrue(state["sources"]["targets"]["fresh"])
        self.assertEqual(state["rejectedTargets"], 0)
        self.assertEqual(len(state["targets"]), 1)
        self.assertEqual(state["targets"][0]["id"], "7f7ebe06f4ff4577af58f6b18d1bee8d")
        self.assertEqual(state["targets"][0]["districtId"], "114")
        self.assertEqual(state["targets"][0]["heading"], 270)

    def test_network_failure_keeps_alert_history_but_marks_it_unavailable(self):
        with patch.object(server, "fetch_source", side_effect=OSError("offline")):
            state = server.get_state()
        self.assertFalse(state["sources"]["alerts"]["fresh"])
        self.assertFalse(state["sources"]["targets"]["fresh"])
        self.assertEqual(state["targets"], [])


if __name__ == "__main__":
    unittest.main()
