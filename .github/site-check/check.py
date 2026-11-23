"""Daily site check for mtbsa.com.au.

Looks at the race calendars and links the site uses and reports anything
that has changed or broken in one GitHub issue ("Daily site check").
It never edits the site. Standard library only, so it needs nothing installed.

Run locally with:  python3 .github/site-check/check.py --dry-run
"""

import csv
import concurrent.futures
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
ADELAIDE = ZoneInfo("Australia/Adelaide")
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36 mtbsa-daily-site-check")
LABEL = "daily-site-check"
ISSUE_TITLE = "Daily site check"

# Calendars always watched, on top of any found in the site's files.
EXTRA_CALENDARS = [
    "https://entryboss.cc/calendar/ambc",
    "https://entryboss.cc/calendar/gesa",
    "https://entryboss.cc/calendar/insideline",
]
AUSCYCLING_SA = "https://auscycling.org.au/events?state=sa"
MTB_WORDS = re.compile(
    r"mtb|mountain|enduro|downhill|gravity|xco|xcc|xcm|cross-country|"
    r"marathon|dirt|trail|dh-|-dh|e-mtb|pump", re.I)

# Hosts that aren't pages people click (fonts, analytics, schema markup).
SKIP_HOSTS = {
    "fonts.googleapis.com", "fonts.gstatic.com", "schema.org", "www.w3.org",
    "gc.zgo.at",
}
SKIP_HOST_SUFFIXES = (".posthog.com", ".goatcounter.com")

URL_RE = re.compile(r"https?://[^\s\"'<>()`,]+")
SCAN_GLOBS = ["*.html", "*.csv", "*.js"]


# ---------------------------------------------------------------- helpers

def fetch(url, timeout=25, method="GET"):
    """Returns (status, final_url, text). status 0 means it didn't load."""
    req = urllib.request.Request(url, method=method, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(3_000_000) if method == "GET" else b""
            return r.status, r.geturl(), body.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, url, ""
    except Exception as e:  # DNS, timeout, TLS, reset
        return 0, url, f"{type(e).__name__}: {e}"


def load_ignore():
    p = ROOT / ".github/site-check/ignore.txt"
    items = set()
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                items.add(line.rstrip("/"))
    return items


def site_text():
    out = []
    for g in SCAN_GLOBS:
        for f in sorted(ROOT.glob(g)):
            out.append(f.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(out)


def load_races():
    with open(ROOT / "races.csv", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def entryboss_id(url):
    m = re.search(r"entryboss\.cc/races/(\d+)", url or "")
    return m.group(1) if m else None


def parse_day(text):
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})", text)
    if not m:
        return None
    try:
        return dt.datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}",
                                    "%d %b %Y").date()
    except ValueError:
        return None


def nice(d):
    return d.strftime("%a %-d %b %Y") if d else "?"


# ---------------------------------------------------------------- checks

def check_calendars(races, text, today, ignore):
    """Compares EntryBoss calendars with races.csv."""
    by_id = {}
    for r in races:
        rid = entryboss_id(r.get("entry_url"))
        if rid:
            by_id[rid] = r

    cals = set(EXTRA_CALENDARS)
    cals.update(u.rstrip("/") for u in re.findall(
        r"https://entryboss\.cc/calendar/[a-z0-9_-]+", text))

    new, moved, problems = [], [], []
    row_re = re.compile(
        r'fixture-date">\s*(.*?)\s*</div>.*?href="/races/(\d+)"[^>]*>(.*?)</a>',
        re.S)
    for cal in sorted(cals):
        status, _, body = fetch(cal)
        rows = row_re.findall(body) if status == 200 else []
        if not rows:
            problems.append(f"Couldn't read the calendar at {cal} today "
                            f"(status {status or 'no answer'}). "
                            "If this keeps happening the page may have changed.")
            continue
        for date_txt, rid, name in rows:
            day = parse_day(html.unescape(date_txt))
            name = html.unescape(re.sub(r"<[^>]+>", "", name)).strip()
            url = f"https://entryboss.cc/races/{rid}"
            if rid in ignore or url in ignore:
                continue
            if rid in by_id:
                ours = by_id[rid]
                try:
                    our_day = dt.date.fromisoformat(ours["date"])
                except ValueError:
                    our_day = None
                upcoming = (day and day >= today) or (our_day and our_day >= today)
                if day and our_day and day != our_day and upcoming:
                    moved.append(
                        f"**{ours['name']}** is now on **{nice(day)}** "
                        f"(the site says {nice(our_day)}). [Entry page]({url})")
            elif day and day >= today:
                new.append(f"**{name}** on {nice(day)}, listed on "
                           f"[{cal.split('/')[-1]}]({cal}). [Entry page]({url})")
    return new, moved, problems


AC_DATE = re.compile(
    r"\b([A-Z][a-z]{2}) (\d{1,2})(?:\s*[\u2013-]\s*(?:[A-Z][a-z]{2} )?\d{1,2})?, (\d{4})\b")


def check_auscycling_dates(races, today, ignore):
    """For races whose entry link is an AusCycling event page, checks the date."""
    moved, problems = [], []
    for r in races:
        url = (r.get("entry_url") or "").strip()
        if "auscycling.org.au/events/" not in url or url.rstrip("/") in ignore:
            continue
        try:
            our_day = dt.date.fromisoformat(r["date"])
        except ValueError:
            continue
        if our_day < today:
            continue
        status, _, body = fetch(url)
        if status != 200:
            continue  # the link check reports broken pages
        page = re.sub(r"<script.*?</script>|<style.*?</style>", " ", body, flags=re.S)
        page = html.unescape(re.sub(r"<[^>]+>", " ", page))
        m = AC_DATE.search(page)
        if not m:
            problems.append(f"Couldn't find the date on {url} today.")
            continue
        try:
            day = dt.datetime.strptime(" ".join(m.groups()), "%b %d %Y").date()
        except ValueError:
            continue
        if day != our_day:
            moved.append(f"**{r['name']}** is now on **{nice(day)}** "
                         f"(the site says {nice(our_day)}). [Event page]({url})")
    return moved, problems


def check_auscycling(text, today, ignore):
    status, _, body = fetch(AUSCYCLING_SA)
    if status != 200 or not body:
        return [], [f"Couldn't read the AusCycling SA events page today "
                    f"(status {status or 'no answer'})."]
    found = []
    for slug in sorted(set(re.findall(
            r'href="(?:https://auscycling\.org\.au)?/events/([a-z0-9-]+)"', body))):
        url = f"https://auscycling.org.au/events/{slug}"
        if not MTB_WORDS.search(slug) or url in text or url in ignore or slug in ignore:
            continue
        # skip events from years already over
        years = [int(y) for y in re.findall(r"20\d\d", slug)]
        if years and max(years) < today.year:
            continue
        found.append(f"[{slug.replace('-', ' ')}]({url})")
    return found, []


def raw_links():
    """Every http(s) link in the site's pages, scripts and spreadsheets."""
    found = set()
    for g in SCAN_GLOBS:
        for f in sorted(ROOT.glob(g)):
            t = f.read_text(encoding="utf-8", errors="replace")
            if f.suffix == ".csv":
                for row in csv.reader(t.splitlines()):
                    found.update(c.strip() for c in row if c.strip().startswith("http"))
            else:
                found.update(re.findall(r'(?:href|src)="(https?://[^"]+)"', t))
                found.update(URL_RE.findall(t))
    return found


def collect_links(ignore):
    urls = set()
    for u in raw_links():
        u = html.unescape(u).rstrip(".,;:'\"")
        parts = urllib.parse.urlsplit(u)
        host = parts.hostname or ""
        if host in SKIP_HOSTS or host.endswith(SKIP_HOST_SUFFIXES):
            continue
        if "google." in host and parts.path.startswith("/maps"):
            continue  # map searches always load
        if "#" in u or "{" in u or "$" in u or not parts.path and host.endswith("posthog.com"):
            continue
        if host.endswith("mtbsa.com.au") and parts.path.endswith(
                (".png", ".svg", ".ico", ".pdf")):
            continue
        if u.rstrip("/") in ignore:
            continue
        urls.add(u)
    # drop bare-domain duplicates (https://x.com and https://x.com/)
    return sorted({u for u in urls if not (u + "/") in urls})


def check_one(url):
    status, final, _ = fetch(url)
    if status in (0, 500, 502, 503, 504):
        time.sleep(8)
        status, final, _ = fetch(url)
    return url, status, final


def check_links(urls):
    broken, homepage, blocked = [], [], 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for url, status, final in pool.map(check_one, urls):
            if status in (401, 403, 429):  # sites that block robots; not a real break
                blocked += 1
            elif status == 0:
                broken.append(f"{url} (the site didn't answer)")
            elif status >= 400:
                why = "page not found" if status in (404, 410) else f"error {status}"
                broken.append(f"{url} ({why})")
            else:
                a, b = urllib.parse.urlsplit(url), urllib.parse.urlsplit(final)
                if a.path.strip("/") and not b.path.strip("/"):
                    homepage.append(f"{url} now just goes to the home page")
                elif "/products/" in a.path and "/products/" not in b.path:
                    homepage.append(f"{url} no longer goes to the product "
                                    f"(now {final})")
    return broken, homepage, blocked


# ---------------------------------------------------------------- report

def build_report(f, now, checked, blocked):
    sections = []

    def sec(title, intro, items):
        if items:
            sections.append(f"### {title}\n{intro}\n\n" +
                            "\n".join(f"- [ ] {i}" for i in items))

    sec("🗓️ Race dates that changed", "These races have moved. Update the date in `races.csv`.",
        f["moved"])
    sec("🆕 New races not on the site yet", "These are on the organisers' calendars but not in `races.csv`.",
        f["new"])
    sec("🆕 Possible new MTB events on AusCycling (SA)",
        "These might be worth adding. Some may not be mountain bike races.", f["auscycling"])
    sec("🔗 Broken links", "These links didn't work today.", f["broken"])
    sec("↪️ Links that now go somewhere else", "Worth a quick look.", f["moved_links"])
    sec("⚠️ Couldn't check", "Not necessarily a problem, just a heads up.", f["problems"])

    head = (f"Checked on **{now:%A %-d %B %Y, %-I:%M %p}** Adelaide time "
            f"({checked} links).\n\n")
    foot = ("\n\n---\n**What to do:** tick things off as you fix them, or ask Claude "
            "in the project to \"apply today's site check\". To stop something being "
            "flagged again, add its link to `.github/site-check/ignore.txt`.\n\n"
            "This issue updates itself each morning and closes when everything is clear.")
    if blocked:
        foot += (f"\n\n_{blocked} link(s) block automatic checks, so they were skipped._")
    return head + "\n\n".join(sections) + foot


def gh(method, path, data=None):
    token = os.environ["GITHUB_TOKEN"]
    url = f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}{path}"
    req = urllib.request.Request(
        url, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28",
                 "User-Agent": "mtbsa-daily-site-check"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def publish(body, fingerprint, anything):
    marker = f"<!-- fingerprint:{fingerprint} -->"
    open_issues = [i for i in gh("GET", f"/issues?state=open&labels={LABEL}&per_page=10")
                   if "pull_request" not in i]
    issue = open_issues[0] if open_issues else None

    if not anything:
        if issue:
            gh("POST", f"/issues/{issue['number']}/comments",
               {"body": "✅ All clear this morning. Closing this until something changes."})
            gh("PATCH", f"/issues/{issue['number']}",
               {"state": "closed", "state_reason": "completed"})
            print(f"All clear, closed #{issue['number']}")
        else:
            print("All clear, nothing to report")
        return

    full = body + "\n" + marker
    if not issue:
        new = gh("POST", "/issues", {"title": ISSUE_TITLE, "body": full, "labels": [LABEL]})
        print(f"Opened #{new['number']}")
    elif marker in (issue.get("body") or ""):
        print(f"No change since last time (#{issue['number']})")
    else:
        gh("PATCH", f"/issues/{issue['number']}", {"body": full})
        gh("POST", f"/issues/{issue['number']}/comments",
           {"body": "🔔 Something new turned up this morning. The list above is updated."})
        print(f"Updated #{issue['number']}")


# ---------------------------------------------------------------- main

def right_time(now):
    """Two crons are booked; only run on the one that's 9 AM in Adelaide."""
    if os.environ.get("EVENT_NAME") != "schedule":
        return True
    offset = now.utcoffset().total_seconds() / 3600
    want = {"30 22 * * *": 10.5, "30 23 * * *": 9.5}.get(os.environ.get("SCHEDULE", "").strip())
    return want is None or want == offset


def main():
    dry = "--dry-run" in sys.argv
    now = dt.datetime.now(ADELAIDE)
    if not right_time(now):
        print(f"Not 9 AM in Adelaide on this schedule ({now:%H:%M %Z}), skipping.")
        return
    today = now.date()
    ignore = load_ignore()
    text = site_text()
    races = load_races()

    new, moved, problems = check_calendars(races, text, today, ignore)
    moved2, p3 = check_auscycling_dates(races, today, ignore)
    moved += moved2
    problems += p3
    ausc, p2 = check_auscycling(text, today, ignore)
    links = collect_links(ignore)
    broken, moved_links, blocked = check_links(links)

    f = {"moved": moved, "new": new, "auscycling": ausc, "broken": broken,
         "moved_links": moved_links, "problems": problems + p2}
    # "Couldn't check" items open the issue too (so a silent failure gets
    # noticed), but don't count as "something new" for the daily ping.
    anything = any(f.values())
    fingerprint = hashlib.sha1(json.dumps(
        {k: sorted(v) for k, v in f.items() if k != "problems"}).encode()).hexdigest()[:12]
    body = build_report(f, now, len(links), blocked)

    print(body)
    if not dry:
        publish(body, fingerprint, anything)


if __name__ == "__main__":
    main()
