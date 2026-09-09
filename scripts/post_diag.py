#!/usr/bin/env python3
"""Best-effort: post a local log file to a reusable CI issue.

Usage (inside GitHub Actions):  python3 scripts/post_diag.py <label> <logfile>

Finds the newest OPEN issue whose title starts with "CI build log (<label>)"
and replaces its body with the (tail of the) log file. Creates the issue if
none exists. Prints the HTTP status of each call so the console log shows
whether this channel itself worked.
"""
import json
import os
import sys
import urllib.error
import urllib.request


def api(method, path, payload=None):
    url = "https://api.github.com" + path
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", "token " + os.environ.get("GITHUB_TOKEN", ""))
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "redstonepanel-ci-diag")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, str(e)


def main():
    if len(sys.argv) < 3:
        print("usage: post_diag.py <label> <logfile>")
        sys.exit(2)
    label, logfile = sys.argv[1], sys.argv[2]
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not repo or not os.environ.get("GITHUB_TOKEN"):
        print("post_diag: GITHUB_REPOSITORY/GITHUB_TOKEN missing - nothing posted")
        sys.exit(2)

    try:
        with open(logfile, "r", encoding="utf-8", errors="replace") as f:
            log = f.read()
    except Exception as e:  # noqa: BLE001
        log = "(could not read %s: %s)" % (logfile, e)
    log = log[-20000:]
    body = "```text\n%s\n```" % log

    target = None
    status, resp = api("GET", "/repos/%s/issues?state=open&per_page=100" % repo)
    if status == 200:
        try:
            for it in json.loads(resp):
                if it.get("title", "").startswith("CI build log (%s)" % label) and not it.get("pull_request"):
                    if target is None or it["number"] > target["number"]:
                        target = it
        except Exception:  # noqa: BLE001
            pass

    if target is not None:
        status, resp = api(
            "PATCH",
            "/repos/%s/issues/%d" % (repo, target["number"]),
            {"body": body, "state": "open"},
        )
        print("post_diag [%s]: updated issue #%s -> HTTP %s: %s"
              % (label, target["number"], status, resp[:300]))
    else:
        status, resp = api(
            "POST",
            "/repos/%s/issues" % repo,
            {"title": "CI build log (%s)" % label, "body": body},
        )
        print("post_diag [%s]: created issue -> HTTP %s: %s" % (label, status, resp[:300]))


if __name__ == "__main__":
    main()
