"""Sends the morning race alerts for mtbsa.com.au.

Runs right after the daily site check, so it sees any entry dates the check
just found. Three kinds of alert:

  open   "Entries open today"      races.csv entries_open is today
  close  "Entries close tomorrow"  races.csv entries_close is tomorrow
  new    "New race added"          a race id that wasn't in races.csv last time

People choose which kinds they want on the site (alerts.js), or follow single
races, and functions/api/alerts keeps that list. This reads it with the
ALERTS_TOKEN secret and sends with standard web push (pywebpush).

The first time it runs it makes the alert keys and saves them on the site, so
there's nothing to copy by hand. alerts-sent.json (on the site-check-data
branch) remembers what has been sent, so nobody gets the same alert twice.

  ALERTS_TOKEN=... python3 .github/site-check/alerts.py --state data/alerts-sent.json
  python3 .github/site-check/alerts.py --dry-run     # show what would go out today
"""

import argparse
import base64
import csv
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
ADELAIDE = ZoneInfo("Australia/Adelaide")
CONTACT = "mailto:support@mtbsa.com.au"   # push services ask for a contact address
MAX_PER_PERSON = 4                         # more than this in one morning becomes one summary
GROUP_NEW = 3                              # more new races than this become one alert


def to_date(s):
    s = (s or "").strip()
    parts = s.split("/")
    if len(parts) == 3:  # Excel's 15/11/2026
        s = f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}"
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        return None


def nice(d):
    return d.strftime("%a %-d %b")


def read_races():
    with open(ROOT / "races.csv", encoding="utf-8-sig", newline="") as f:
        return [r for r in csv.DictReader(f) if (r.get("id") or "").strip()]


def race_url(r):
    return "/calendar#race/" + urllib.request.quote(r["id"], safe="")


def plan(races, today, state):
    """Works out today's alerts. Returns (alerts, new_state). Pure, so it's easy to test."""
    sent = set(state.get("sent", []))
    first_run = "known" not in state
    known = set(state.get("known", []))
    tomorrow = today + dt.timedelta(days=1)
    alerts = []

    def finished(r):
        end = to_date(r.get("end_date")) or to_date(r.get("date"))
        return not end or end < today

    for r in races:
        if finished(r):
            continue
        opens, closes = to_date(r.get("entries_open")), to_date(r.get("entries_close"))
        day = to_date(r.get("date"))
        if opens == today:
            alerts.append({"key": f"open:{r['id']}:{opens}", "topic": "open", "race": r["id"],
                           "title": "Entries open today",
                           "body": f"{r['name']} ({nice(day)}). Tap to see the race and enter.",
                           "url": race_url(r), "tag": f"open-{r['id']}"})
        if closes == tomorrow:
            alerts.append({"key": f"close:{r['id']}:{closes}", "topic": "close", "race": r["id"],
                           "title": "Entries close tomorrow",
                           "body": f"Last chance to enter {r['name']} ({nice(day)}).",
                           "url": race_url(r), "tag": f"close-{r['id']}"})

    ids = {r["id"] for r in races}
    if not first_run:  # the first run only learns what's already there
        fresh = [r for r in races if r["id"] not in known and not finished(r)]
        if len(fresh) > GROUP_NEW:
            alerts.append({"key": "new:" + ",".join(sorted(r["id"] for r in fresh)), "topic": "new",
                           "title": f"{len(fresh)} new races added",
                           "body": "New races are on the MTB SA calendar. Tap to have a look.",
                           "url": "/calendar", "tag": "new-races"})
        else:
            for r in fresh:
                where = r.get("venue") if r.get("venue") not in ("", "See entry page") else r.get("region", "")
                alerts.append({"key": f"new:{r['id']}", "topic": "new", "race": r["id"],
                               "title": "New race added",
                               "body": f"{r['name']}, {nice(to_date(r['date']))}" + (f" at {where}" if where else "") + ".",
                               "url": race_url(r), "tag": f"new-{r['id']}"})

    alerts = [a for a in alerts if a["key"] not in sent]
    # Forget dated keys after a couple of months so the file stays small.
    cutoff = (today - dt.timedelta(days=60)).isoformat()
    keep = [k for k in sent if not (k.count(":") == 2 and k.rsplit(":", 1)[1] < cutoff)]
    new_state = {"known": sorted(ids), "sent": sorted(set(keep) | {a["key"] for a in alerts})}
    return alerts, new_state


def wanted(sub, alerts):
    """The alerts one person asked for: a kind they ticked, or a race they follow."""
    topics, races = sub.get("topics") or {}, set(sub.get("races") or [])
    mine = []
    for a in alerts:
        if topics.get(a["topic"]) or (a["topic"] in ("open", "close") and a.get("race") in races):
            mine.append(a)
    if len(mine) > MAX_PER_PERSON:
        mine = mine[:MAX_PER_PERSON - 1] + [{
            "title": f"{len(mine) - MAX_PER_PERSON + 1} more race updates",
            "body": "More entries are opening and closing. Tap to see the calendar.",
            "url": "/calendar", "tag": "more"}]
    return mine


# ---------------------------------------------------------------- the site

class Site:
    def __init__(self, base, token):
        self.base, self.token = base.rstrip("/"), token

    def call(self, method, query="", body=None):
        req = urllib.request.Request(
            f"{self.base}/api/alerts/admin{query}", method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
                     "User-Agent": "mtbsa-daily-site-check"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())

    def everyone(self):
        vapid, subs, cursor = None, [], ""
        while True:
            page = self.call("GET", f"?cursor={urllib.request.quote(cursor)}" if cursor else "")
            vapid = vapid or page.get("vapid")
            subs += page.get("subs", [])
            cursor = page.get("cursor")
            if not cursor:
                return vapid, subs

    def setup(self, keys):
        return self.call("POST", body={"setup": keys})

    def remove(self, ids):
        for i in range(0, len(ids), 500):
            self.call("POST", body={"remove": ids[i:i + 500]})


def b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def make_keys():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    raw_public = key.public_key().public_bytes(serialization.Encoding.X962,
                                               serialization.PublicFormat.UncompressedPoint)
    return {"publicKey": b64(raw_public), "privateKey": b64(key.private_numbers().private_value.to_bytes(32, "big"))}


def send_all(subs, alerts, private_key, push=None):
    """Sends everyone their alerts. Returns (sent, gone_ids, failed)."""
    if push is None:
        from pywebpush import webpush as push
    from pywebpush import WebPushException
    sent, gone, failed = 0, [], 0
    for s in subs:
        for a in wanted(s, alerts):
            data = {k: a[k] for k in ("title", "body", "url", "tag") if k in a}
            try:
                push(subscription_info=s["subscription"], data=json.dumps(data),
                     vapid_private_key=private_key, vapid_claims={"sub": CONTACT}, ttl=12 * 3600)
                sent += 1
            except WebPushException as e:
                code = getattr(e.response, "status_code", None)
                if code in (404, 410):  # they turned alerts off or cleared the browser
                    gone.append(s["id"])
                    break
                failed += 1
                print(f"  couldn't send one alert (push service said {code or e})")
    return sent, gone, failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", help="alerts-sent.json (what has been sent before)")
    ap.add_argument("--dry-run", action="store_true", help="only print today's alerts")
    ap.add_argument("--site", default=os.environ.get("SITE_URL") or "https://mtbsa.com.au")
    args = ap.parse_args()

    today = dt.datetime.now(ADELAIDE).date()
    state_path = Path(args.state) if args.state else None
    state = {}
    if state_path and state_path.exists():
        try:
            state = json.loads(state_path.read_text())
        except ValueError:
            state = {}
    alerts, new_state = plan(read_races(), today, state)
    for a in alerts:
        print(f"[{a['topic']}] {a['title']}: {a['body']}")
    if "known" not in state:
        print("First run: remembering the races already on the site, so they aren't sent as new.")
    if args.dry_run:
        return

    token = os.environ.get("ALERTS_TOKEN", "")
    if not token:
        print("Race alerts aren't set up yet (no ALERTS_TOKEN secret), so nothing was sent.")
        return
    site = Site(args.site, token)
    try:
        vapid, subs = site.everyone()
        if not vapid:
            got = site.setup(make_keys())
            print("Made the alert keys and saved them on the site." if got.get("created") else "Alert keys were already there.")
            vapid, subs = site.everyone()
    except urllib.error.HTTPError as e:
        hint = {401: "ALERTS_TOKEN on GitHub doesn't match the one on Cloudflare.",
                503: "the ALERTS KV namespace isn't connected to the Cloudflare Pages project yet.",
                404: "the site doesn't have the alerts code yet (is it deployed?)."}.get(e.code, "")
        print(f"Couldn't reach the alert list on the site ({e.code}). {hint}")
        sys.exit(1)

    sent, gone, failed = (0, [], 0)
    if alerts and subs:
        sent, gone, failed = send_all(subs, alerts, vapid["privateKey"])
        if gone:
            site.remove(gone)
    print(f"{len(subs)} device(s) signed up. Sent {sent} alert(s). "
          f"Removed {len(gone)} that had turned alerts off. {failed} failed.")
    if state_path:
        state_path.write_text(json.dumps(new_state, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
