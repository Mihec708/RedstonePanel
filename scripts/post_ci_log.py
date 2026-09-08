#!/usr/bin/env python3
"""Post CI build logs to GitHub so failures can be inspected remotely.

Usage (inside GitHub Actions):  python3 post_ci_log.py <platform>

Reads (from the repo root): preflight.log, frontend.log, build.log
Uses env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID

Channels (each best-effort; HTTP status + response are always printed):
  1. One reusable open issue per platform: "CI build log (<platform>) - ..."
  2. A draft release tagged 'preview'
"""
import json
import os
import sys
import urllib.error
import urllib.request


def read(name, limit):
    try:
        with open(name, "r", encoding="utf-8", errors="replace") as f:
            return f.read()[-limit:]
    except Exception as e:  # noqa: BLE001
        return "(could not read %s: %s)" % (name, e)


def api(method, path, payload=None):
    url = "https://api.github.com" + path
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", "token " + os.environ.get("GITHUB_TOKEN", ""))
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "redstonepanel-ci-logs")
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
    platform = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    if not repo or not os.environ.get("GITHUB_TOKEN"):
        print("post_ci_log: GITHUB_REPOSITORY/GITHUB_TOKEN missing - nothing posted")
        return

    log = (
        "platform: %s\nrun: %s\n\n"
        "===== preflight.log =====\n%s\n\n"
        "===== frontend.log (tail) =====\n%s\n\n"
        "===== build.log (tail) =====\n%s\n"
    ) % (
        platform,
        run_id,
        read("preflight.log", 4000),
        read("frontend.log", 8000),
        read("build.log", 20000),
    )
    body = "```text\n" + log + "\n```"

    # Channel 1: reuse one open issue per platform (create it if missing).
    target = None
    status, resp = api("GET", "/repos/%s/issues?state=open&per_page=100" % repo)
    if status == 200:
        try:
            for it in json.loads(resp):
                if it.get("title", "").startswith("CI build log (%s)" % platform) and not it.get("pull_request"):
                    if target is None or it["number"] > target["number"]:
                        target = it
        except Exception:  # noqa: BLE001
            pass
    if target is not None:
        status, resp = api(
            "PATCH", "/repos/%s/issues/%d" % (repo, target["number"]), {"body": body, "state": "open"}
        )
        print("[issue] updated #%s HTTP %s: %s" % (target["number"], status, resp[:400]))
    else:
        status, resp = api(
            "POST",
            "/repos/%s/issues" % repo,
            {"title": "CI build log (%s) - run %s" % (platform, run_id), "body": body},
        )
        print("[issue] created HTTP %s: %s" % (status, resp[:400]))

    # Channel 2: draft release (kept for parity with the previous workflow).
    status, resp = api(
        "POST",
        "/repos/%s/releases" % repo,
        {
            "tag_name": "preview",
            "name": "RedstonePanel build log (%s) - run %s" % (platform, run_id),
            "draft": True,
            "body": body,
        },
    )
    print("[release] HTTP %s: %s" % (status, resp[:400]))


if __name__ == "__main__":
    main()
