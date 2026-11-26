"""Checks for the morning race alerts. Run: python3 .github/site-check/test_alerts.py"""
import datetime as dt
import os
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(__file__))
import alerts as a  # noqa: E402

TODAY = dt.date(2026, 12, 9)


def race(i, date, **kw):
    return dict({"id": i, "date": date, "end_date": "", "name": i.title(), "venue": "Eagle MTB Park",
                 "region": "Adelaide Hills", "entries_open": "", "entries_close": ""}, **kw)


RACES = [
    race("nats", "2027-03-17", end_date="2027-03-21", entries_open="2026-12-09"),
    race("juniors", "2026-12-13", entries_open="2026-11-20", entries_close="2026-12-10"),
    race("old", "2026-11-01", entries_open="2026-12-09"),
]


class Plan(unittest.TestCase):
    def test_first_run_learns_races_without_sending_them_as_new(self):
        alerts, state = a.plan(RACES, TODAY, {})
        self.assertEqual(sorted(x["topic"] for x in alerts), ["close", "open"])
        self.assertEqual(state["known"], ["juniors", "nats", "old"])

    def test_open_and_close(self):
        alerts, _ = a.plan(RACES, TODAY, {"known": ["nats", "juniors", "old"]})
        by = {x["topic"]: x for x in alerts}
        self.assertEqual(by["open"]["title"], "Entries open today")
        self.assertIn("Nats (Wed 17 Mar)", by["open"]["body"])
        self.assertEqual(by["open"]["url"], "/calendar#race/nats")
        self.assertEqual(by["close"]["race"], "juniors")
        self.assertNotIn("old", [x.get("race") for x in alerts])  # finished races are skipped

    def test_never_twice(self):
        alerts, state = a.plan(RACES, TODAY, {"known": ["nats", "juniors", "old"]})
        again, _ = a.plan(RACES, TODAY, state)
        self.assertTrue(alerts)
        self.assertEqual(again, [])

    def test_new_races_one_by_one_then_grouped(self):
        alerts, _ = a.plan(RACES, TODAY, {"known": ["juniors", "old"]})
        new = [x for x in alerts if x["topic"] == "new"]
        self.assertEqual([x["body"] for x in new], ["Nats, Wed 17 Mar at Eagle MTB Park."])
        lots = RACES + [race(f"r{n}", "2027-02-0" + str(n)) for n in range(1, 5)]
        alerts, _ = a.plan(lots, TODAY, {"known": ["juniors", "old", "nats"]})
        self.assertEqual([x["title"] for x in alerts if x["topic"] == "new"], ["4 new races added"])

    def test_old_keys_are_forgotten(self):
        _, state = a.plan(RACES, TODAY, {"known": [], "sent": ["open:x:2026-01-01", "new:x"]})
        self.assertNotIn("open:x:2026-01-01", state["sent"])
        self.assertIn("new:x", state["sent"])


class Wanted(unittest.TestCase):
    ALERTS = [{"topic": "open", "race": "nats", "title": "o"}, {"topic": "close", "race": "juniors", "title": "c"},
              {"topic": "new", "race": "nats", "title": "n"}]

    def test_topics_and_followed_races(self):
        pick = lambda s: [x["title"] for x in a.wanted(s, self.ALERTS)]
        self.assertEqual(pick({"topics": {"open": True, "new": True}}), ["o", "n"])
        self.assertEqual(pick({"topics": {}, "races": ["juniors"]}), ["c"])
        self.assertEqual(pick({"topics": {}, "races": ["nats"]}), ["o"])  # following doesn't mean "new race" alerts
        self.assertEqual(pick({"topics": {}}), [])

    def test_too_many_becomes_a_summary(self):
        many = [{"topic": "open", "race": str(i), "title": str(i)} for i in range(7)]
        got = a.wanted({"topics": {"open": True}}, many)
        self.assertEqual(len(got), a.MAX_PER_PERSON)
        self.assertEqual(got[-1]["title"], "4 more race updates")


class Sending(unittest.TestCase):
    def test_gone_devices_are_removed(self):
        try:
            from pywebpush import WebPushException
        except ImportError:
            self.skipTest("pywebpush isn't installed here")

        class Resp:
            def __init__(self, code):
                self.status_code = code

        calls = []

        def fake_push(subscription_info, **kw):
            calls.append((subscription_info["endpoint"], kw["data"]))
            if subscription_info["endpoint"].endswith("gone"):
                raise WebPushException("gone", response=Resp(410))

        subs = [{"id": "a" * 64, "subscription": {"endpoint": "https://push.example/ok"}, "topics": {"open": True}},
                {"id": "b" * 64, "subscription": {"endpoint": "https://push.example/gone"}, "topics": {"open": True}}]
        sent, gone, failed = a.send_all(subs, [{"topic": "open", "race": "x", "title": "T", "body": "B", "url": "/u"}],
                                        "key", push=fake_push)
        self.assertEqual((sent, gone, failed), (1, ["b" * 64], 0))
        self.assertIn('"title": "T"', calls[0][1])

    def test_keys_work_with_pywebpush(self):
        try:
            from py_vapid import Vapid
        except ImportError:
            self.skipTest("pywebpush isn't installed here")
        keys = a.make_keys()
        v = Vapid.from_string(keys["privateKey"])
        self.assertEqual(len(a.base64.urlsafe_b64decode(keys["publicKey"] + "==")), 65)
        headers = v.sign({"sub": a.CONTACT, "aud": "https://fcm.googleapis.com"})
        self.assertIn("vapid", headers["Authorization"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
