#!/usr/bin/env python3
"""Create-or-fetch a GitHub Release and upload local bundle artifacts to it.

Designed to be called once per platform job from CI. It is safe to run in
parallel across jobs (they all target the same release tag): the first job
creates the release, the others fetch it (with retries to cover the small race
window). Uses only the Python standard library so it works on Windows, Linux
and macOS runners without extra dependencies.

Environment (provided by GitHub Actions):
  GITHUB_TOKEN        access token (needs `contents: write`)
  GITHUB_REPOSITORY   "owner/name"

Usage:
  python3 scripts/publish_release.py --tag preview --prerelease \
      --bundle-dir src-tauri/target/release/bundle --ext .deb --ext .AppImage
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"


def http(method, url, token, payload=None, raw=None, content_type=None):
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": "token " + token,
        "User-Agent": "redstonepanel-release-publisher",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if raw is not None:
        data = raw
        headers["Content-Type"] = content_type or "application/octet-stream"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def collect(bundle_dir, exts):
    found = []
    if not os.path.isdir(bundle_dir):
        return found
    for root, _dirs, names in os.walk(bundle_dir):
        for n in names:
            if any(n.endswith(e) for e in exts):
                found.append(os.path.join(root, n))
    return sorted(found)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--prerelease", action="store_true")
    ap.add_argument("--bundle-dir", required=True)
    ap.add_argument("--ext", action="append", default=[])
    args = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not token:
        print("FATAL: GITHUB_TOKEN is not set")
        sys.exit(2)
    if not repo:
        print("FATAL: GITHUB_REPOSITORY is not set")
        sys.exit(2)
    if not args.ext:
        print("FATAL: no --ext filters provided")
        sys.exit(2)
    print("env OK: token len=%d repo=%s" % (len(token), repo))

    files = collect(args.bundle_dir, args.ext)
    if not files:
        print("FATAL: no artifacts found under %s with extensions %s"
              % (args.bundle_dir, args.ext))
        sys.exit(3)
    print("artifacts to upload: " + repr([os.path.basename(f) for f in files]))

    payload = {
        "tag_name": args.tag,
        "name": "RedstonePanel",
        "draft": False,
        "prerelease": args.prerelease,
        "body": ("RedstonePanel - native Minecraft server manager. "
                 "Download the build for your OS."),
    }
    base = API + "/repos/" + repo + "/releases"

    # 1) Try to create the release.
    status, body = http("POST", base, token, payload=payload)
    upload_url = ""
    if status in (200, 201):
        try:
            upload_url = json.loads(body).get("upload_url", "").split("?")[0]
        except Exception:
            upload_url = ""
        print("created release '%s' (HTTP %s)" % (args.tag, status))
    else:
        print("create release -> HTTP %s: %s" % (status, body[:400]))

    # 2) If creation didn't yield an upload URL (a sibling job likely created
    #    the release first), fetch it. Retry to cover the small race window.
    if not upload_url:
        for attempt in range(1, 9):
            status, body = http("GET", base + "/tags/" + args.tag, token)
            if status == 200:
                try:
                    upload_url = json.loads(body).get("upload_url", "").split("?")[0]
                except Exception:
                    upload_url = ""
                if upload_url:
                    print("resolved existing release '%s' (attempt %d)"
                          % (args.tag, attempt))
                    break
            print("fetch release attempt %d -> HTTP %s" % (attempt, status))
            time.sleep(3)

    if not upload_url:
        print("FATAL: could not resolve upload URL for release '%s'" % args.tag)
        sys.exit(4)

    # 3) Upload each artifact.
    for path in files:
        name = os.path.basename(path)
        with open(path, "rb") as fh:
            raw = fh.read()
        status, body = http(
            "POST", upload_url + "?name=" + name, token,
            raw=raw, content_type="application/octet-stream",
        )
        print("uploaded %s (%d bytes) -> HTTP %s" % (name, len(raw), status))
        if status not in (200, 201):
            print("FATAL: upload of %s failed: %s" % (name, body[:400]))
            sys.exit(5)

    print("PUBLISH OK: uploaded %d artifact(s) to release '%s'"
          % (len(files), args.tag))


if __name__ == "__main__":
    main()
