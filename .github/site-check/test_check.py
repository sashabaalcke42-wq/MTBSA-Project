"""Checks for the daily site check. Run: python3 .github/site-check/test_check.py"""
import datetime as dt
import json
import http.server
import os
import sys
import threading
from pathlib import Path
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(__file__))
import check as c  # noqa: E402

TODAY = dt.date(2026, 11, 24)


def row(d, i, n, course="Eagle MTB Park"):
    return (f'<div class="row fixture-row">\n<div class="col-xs-9 col-sm-2 fixture-date">\n{d}\n</div>\n'
            f'<div class="col-xs-3 col-sm-1 col-sm-push-9">\n<a href="/races/{i}/enter">Enter</a>\n</div>\n'
            f'<div class="col-xs-12 col-sm-pull-1 fixture-name col-sm-6"><a href="/races/{i}">{n}</a></div>'
            f'<div class="col-xs-11 col-sm-pull-1 fixture-course col-sm-3">{course}</div>\n</div>')


RACES = [
    {"id": "juniors", "date": "2026-12-06", "end_date": "", "name": "Juniors Day", "venue": "Eagle MTB Park",
     "region": "Adelaide Hills", "organiser": "Adelaide Mountain Bike Club",
     "organiser_url": "https://entryboss.cc/calendar/ambc", "entry_url": "https://entryboss.cc/races/32881"},
    {"id": "nats", "date": "2027-03-17", "end_date": "2027-03-21", "name": "MTB Nationals", "venue": "Tasmania",
     "region": "Interstate", "organiser": "AusCycling", "organiser_url": "https://auscycling.org.au/",
     "entry_url": "https://auscycling.org.au/events/2027-auscycling-mtb-national-championships"},
]


class FakeWeb:
    def __init__(self, pages):
        self.pages = pages

    def __call__(self, url, timeout=25):
        for k, v in self.pages.items():
            if k in url:
                return c.Page(200, url, url, v)
        return c.Page(200, url, url, "")


class Calendar(unittest.TestCase):
    def setUp(self):
        self.real = c.fetch

    def tearDown(self):
        c.fetch = self.real

    def run_cal(self, html):
        c.fetch = FakeWeb({"calendar/ambc": html})
        out = c.Findings()
        c.check_calendars(RACES, "", TODAY, out)
        return [i for i in out.items if i["kind"] != "source"]

    def test_new_and_moved(self):
        items = self.run_cal("<h4>Upcoming</h4>" + row("Sun, 14 Feb 2027", "40001", "2027 R01 XCC &amp; Kids")
                             + row("Sun, 13 Dec 2026", "32881", "Juniors Day")
                             + row("Sun, 8 Nov 2026", "30000", "Old race"))
        kinds = sorted(i["kind"] for i in items)
        self.assertEqual(kinds, ["race_date", "race_new"])
        moved = next(i for i in items if i["kind"] == "race_date")
        self.assertEqual(moved["change"]["set"], {"date": "2026-12-13"})
        self.assertEqual(moved["change"]["expect"], {"date": "2026-12-06"})
        new = next(i for i in items if i["kind"] == "race_new")
        r = new["change"]["row"]
        self.assertEqual((r["date"], r["name"], r["type"], r["level"], r["region"]),
                         ("2027-02-14", "2027 R01 XCC & Kids", "Cross-country", "Club", "Adelaide Hills"))
        self.assertEqual(r["entry_url"], "https://entryboss.cc/races/40001")

    def test_same_suggestion_same_id(self):
        h = row("Sun, 14 Feb 2027", "40001", "R01")
        self.assertEqual(self.run_cal(h)[0]["id"], self.run_cal(h)[0]["id"])
        self.assertNotEqual(self.run_cal(h)[0]["id"], self.run_cal(row("Sun, 21 Feb 2027", "40001", "R01"))[0]["id"])

    def test_cancelled(self):
        items = self.run_cal(row("Sun, 6 Dec 2026", "32881", "CANCELLED - Juniors Day"))
        self.assertEqual([i["kind"] for i in items], ["race_cancelled"])

    def test_unreadable_calendar_is_reported(self):
        c.fetch = FakeWeb({})
        out = c.Findings()
        c.check_calendars(RACES, "", TODAY, out)
        self.assertTrue(all(i["kind"] == "source" for i in out.items))
        self.assertEqual(len(out.items), 3)


class AusCycling(unittest.TestCase):
    def tearDown(self):
        c.fetch = c.__dict__["_real_fetch"]

    def test_date_and_new_event(self):
        c.fetch = FakeWeb({
            "mtb-national-championships": "<h1>2027 MTB Nationals</h1><div>Mar 18 – 22, 2027</div>",
            "events/2027-sa-enduro-state-round-1": "<h1>SA Enduro Round 1</h1><p>Feb 7, 2027</p>",
            "state=sa": '<a href="/events/2027-sa-enduro-state-round-1">x</a><a href="/events/2027-tour-down-under">y</a>',
        })
        out = c.Findings()
        c.check_auscycling(RACES, RACES[1]["entry_url"], TODAY, out)
        moved = [i for i in out.items if i["kind"] == "race_date"]
        self.assertEqual(moved[0]["change"]["set"], {"date": "2027-03-18", "end_date": "2027-03-22"})
        new = [i for i in out.items if i["kind"] == "race_new"]
        self.assertEqual(len(new), 1)
        self.assertEqual(new[0]["change"]["row"]["date"], "2027-02-07")
        self.assertEqual(new[0]["change"]["row"]["type"], "Enduro")


class EntryDates(unittest.TestCase):
    """When entries open and close, read from the organiser's page."""
    AC = ('<h1>2027 AusCycling MTB National Championships</h1><div>Mar 17 – 21, 2027</div>'
          '<p>Entries open on <strong>Wednesday 9 December 2026</strong>.</p>'
          '<p><strong>Enter your details below to be notified when entries open.</strong></p>'
          '<p>Entry links, pricing and key deadlines will be published when entries open.</p>')
    EB = ('<dl><dt>Date</dt><dd>Sun, 15 Mar 2026</dd><dt>Entries open</dt>'
          '<dd>Tue, 24 Feb 2026 7:00 PM ACDT</dd><dt>Entries close</dt>'
          '<dd>Sun, 08 Mar 2026 11:59 PM ACDT</dd></dl>')

    def tearDown(self):
        c.fetch = c._real_fetch

    def test_reads_both_sites(self):
        self.assertEqual(c.entry_dates(c.page_words(self.AC)), {"entries_open": dt.date(2026, 12, 9)})
        self.assertEqual(c.entry_dates(c.page_words(self.EB)),
                         {"entries_open": dt.date(2026, 2, 24), "entries_close": dt.date(2026, 3, 8)})

    def test_month_only(self):
        page = ('<p>Entries for this event open in August 2027.</p><p>Enter your details below to be '
                'notified when entries open.</p><h3>Registration</h3><div>Registration Opens From</div>'
                '<div>August 2027</div><div>Until</div><div>November 2027</div><h3>Event Information</h3>')
        self.assertEqual(c.entry_dates(c.page_words(page)),
                         {"entries_open": c.Month(2027, 8), "entries_close": c.Month(2027, 11)})

    def test_day_beats_month(self):
        page = ('<p>Entries open on Wednesday 9 December 2026.</p><div>Registration Opens From</div>'
                '<div>December 2026</div><h3>Event Information</h3>')
        self.assertEqual(c.entry_dates(c.page_words(page)), {"entries_open": dt.date(2026, 12, 9)})

    def test_month_never_replaces_a_day(self):
        out = c.Findings()
        r = dict(RACES[1], entries_open="2027-08-04", entries_close="")
        c.suggest_entry_dates(r, {"entries_open": c.Month(2027, 8), "entries_close": c.Month(2027, 11)},
                              "AusCycling", r["entry_url"], out)
        self.assertEqual(out.items[0]["change"]["set"], {"entries_close": "2027-11"})
        self.assertIn("close in November 2027", out.items[0]["title"])

    def test_no_date_no_guess(self):
        self.assertEqual(c.entry_dates("Entries open now. Racing on 9 December 2026."), {})
        self.assertEqual(c.entry_dates("Entries opening soon"), {})

    def races(self):
        return [dict(r, entries_open="", entries_close="") for r in RACES]

    def test_auscycling_suggests_and_auto_fixes(self):
        c.fetch = FakeWeb({"mtb-national-championships": self.AC, "state=sa": ""})
        out = c.Findings()
        races = self.races()
        c.check_auscycling(races, races[1]["entry_url"], TODAY, out)
        got = [i for i in out.items if i["kind"] == "race_entries"]
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["change"]["set"], {"entries_open": "2026-12-09"})
        self.assertEqual(got[0]["change"]["expect"], {"entries_open": ""})
        self.assertIn("race_entries", c.AUTO_KINDS)

    def test_quiet_when_already_right(self):
        c.fetch = FakeWeb({"mtb-national-championships": self.AC, "state=sa": ""})
        out = c.Findings()
        races = self.races()
        races[1]["entries_open"] = "2026-12-09"
        c.check_auscycling(races, races[1]["entry_url"], TODAY, out)
        self.assertEqual([i for i in out.items if i["kind"] == "race_entries"], [])

    def test_entryboss_upcoming_only(self):
        c.fetch = FakeWeb({"races/32881": self.EB.replace("2026 7:00", "2026 7:00").replace("24 Feb", "20 Nov").replace("08 Mar", "04 Dec")})
        out = c.Findings()
        races = self.races() + [dict(self.races()[0], id="old", date="2026-01-01", entry_url="https://entryboss.cc/races/1")]
        c.check_entryboss_entries(races, TODAY, out)
        self.assertEqual([i["change"]["value"] for i in out.items], ["juniors"])
        self.assertEqual(out.items[0]["change"]["set"], {"entries_open": "2026-11-20", "entries_close": "2026-12-04"})


class Gear(unittest.TestCase):
    def tearDown(self):
        c.fetch = c.__dict__["_real_fetch"]

    def test_shopify_price(self):
        c.fetch = FakeWeb({"gloves.js": '{"price": 2499, "compare_at_price": 3499, "available": true}'})
        out = c.Findings()
        c.check_gear([{"id": "g", "name": "Gloves", "brand": "Fox", "shop": "99 Bikes", "price_aud": "29",
                       "shop_url": "https://99bikes.com.au/products/gloves"}], TODAY, out)
        self.assertEqual(out.items[0]["change"]["set"], {"price_aud": "24.99", "rrp_aud": "34.99", "checked": "2026-11-24"})

    def test_other_shops_are_skipped(self):
        c.fetch = FakeWeb({"x.html": '<meta property="product:price:amount" content="44.99">'})
        out = c.Findings()
        c.check_gear([{"id": "g", "name": "Grips", "brand": "ODI", "shop": "Pushys", "price_aud": "49.99",
                       "shop_url": "https://www.pushys.com.au/x.html"}], TODAY, out)
        self.assertEqual(out.items, [])

    def test_sold_out_is_not_reported(self):
        c.fetch = FakeWeb({"gloves.js": '{"price": 2900, "available": false}'})
        out = c.Findings()
        c.check_gear([{"id": "g", "name": "Gloves", "brand": "Fox", "shop": "99 Bikes", "price_aud": "29",
                       "shop_url": "https://99bikes.com.au/products/gloves"}], TODAY, out)
        self.assertEqual(out.items, [])

    def test_same_price_is_quiet(self):
        c.fetch = FakeWeb({"x.html": '<meta property="product:price:amount" content="49.99">'})
        out = c.Findings()
        c.check_gear([{"id": "g", "name": "Grips", "brand": "ODI", "shop": "Pushys", "price_aud": "49.99",
                       "shop_url": "https://www.pushys.com.au/x.html"}], TODAY, out)
        self.assertEqual(out.items, [])


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        routes = {"/old": (301, "/new"), "/temp": (302, "/new"), "/gone": (301, "/")}
        if self.path == "/bot":
            self.send_response(400); self.end_headers(); return
        if self.path in routes:
            code, loc = routes[self.path]
            self.send_response(code); self.send_header("Location", loc); self.end_headers(); return
        if self.path == "/missing":
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


class Redirects(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.pop("HTTP_PROXY", None); os.environ.pop("http_proxy", None)
        os.environ["NO_PROXY"] = "127.0.0.1"
        cls.srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        cls.base = f"http://127.0.0.1:{cls.srv.server_port}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def test_codes(self):
        p = c.fetch(self.base + "/old")
        self.assertEqual((p.status, p.final, p.permanent), (200, self.base + "/new", True))
        self.assertFalse(c.fetch(self.base + "/temp").permanent)
        self.assertEqual(c.fetch(self.base + "/missing").status, 404)

    def test_link_kinds(self):
        out = c.Findings()
        c.files_containing = lambda s: ["links.html"]
        c.check_links([self.base + p for p in ("/old", "/temp", "/gone", "/missing", "/fine", "/bot")], out)
        kinds = sorted(i["kind"] for i in out.items)
        self.assertEqual(kinds, ["link_broken", "link_home", "link_moved"])
        moved = next(i for i in out.items if i["kind"] == "link_moved")
        self.assertEqual(moved["change"], {"op": "replace_text", "files": ["links.html"],
                                           "from": self.base + "/old", "to": self.base + "/new"})


class AutoFix(unittest.TestCase):
    def setUp(self):
        import tempfile, pathlib
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.old_root = c.ROOT
        c.ROOT = self.dir
        (self.dir / "races.csv").write_text(
            'id,date,name,summary\njuniors,2026-12-06,Juniors Day,"Fun, for kids."\nother,2027-01-01,Other,x\n')
        (self.dir / "links.html").write_text('<a href="https://old.example/a">x</a>')

    def tearDown(self):
        c.ROOT = self.old_root

    def test_safe_ones_are_fixed_and_others_wait(self):
        now = dt.datetime(2026, 11, 24, 8, 0, tzinfo=c.ADELAIDE)
        items = [
            {"id": "a", "kind": "race_date", "group": "calendar", "title": "moved",
             "change": {"op": "csv_set", "file": "races.csv", "key": "id", "value": "juniors",
                        "expect": {"date": "2026-12-06"}, "set": {"date": "2026-12-13"}}},
            {"id": "b", "kind": "link_moved", "group": "links", "title": "link",
             "change": {"op": "replace_text", "files": ["links.html"], "from": "https://old.example/a", "to": "https://new.example/a"}},
            {"id": "c", "kind": "race_new", "group": "calendar", "title": "new",
             "change": {"op": "csv_append", "file": "races.csv", "row": {"id": "n"}}},
            {"id": "d", "kind": "race_date", "group": "calendar", "title": "stale",
             "change": {"op": "csv_set", "file": "races.csv", "key": "id", "value": "other",
                        "expect": {"date": "2099-01-01"}, "set": {"date": "2027-02-02"}}},
        ]
        fixed, rest = c.auto_fix(items, now)
        self.assertEqual([f["id"] for f in fixed], ["a", "b"])
        self.assertEqual([r["id"] for r in rest], ["c", "d"])
        self.assertEqual((self.dir / "races.csv").read_text(),
                         'id,date,name,summary\njuniors,2026-12-13,Juniors Day,"Fun, for kids."\nother,2027-01-01,Other,x\n')
        self.assertEqual((self.dir / "links.html").read_text(), '<a href="https://new.example/a">x</a>')

    def test_bad_file_names_are_refused(self):
        self.assertEqual(c.apply_change({"op": "replace_text", "files": ["../x.html"], "from": "a", "to": "b"}), [])


class Clock(unittest.TestCase):
    def test_eight_am(self):
        summer = dt.datetime(2026, 11, 24, 8, 0, tzinfo=c.ADELAIDE)
        winter = dt.datetime(2026, 6, 24, 8, 0, tzinfo=c.ADELAIDE)
        os.environ["EVENT_NAME"] = "schedule"
        try:
            os.environ["SCHEDULE"] = "30 21 * * *"
            self.assertEqual((c.right_time(summer), c.right_time(winter)), (True, False))
            os.environ["SCHEDULE"] = "30 22 * * *"
            self.assertEqual((c.right_time(summer), c.right_time(winter)), (False, True))
        finally:
            os.environ.pop("EVENT_NAME")

    def test_backup_skips_if_already_ran_today(self):
        import tempfile
        today = dt.date(2026, 11, 27)
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "results.json"
            self.assertFalse(c.ran_today(f, today))  # no file yet
            f.write_text(json.dumps({"generated": "2026-11-27T08:00:41+10:30"}))
            self.assertTrue(c.ran_today(f, today))
            f.write_text(json.dumps({"generated": "2026-11-26T08:21:31+10:30"}))
            self.assertFalse(c.ran_today(f, today))
            f.write_text("not json")
            self.assertFalse(c.ran_today(f, today))


c._real_fetch = c.fetch
Calendar.setUp = lambda self: None
Calendar.tearDown = lambda self: setattr(c, "fetch", c._real_fetch)

if __name__ == "__main__":
    unittest.main(verbosity=1)
