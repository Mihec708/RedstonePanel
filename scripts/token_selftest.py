#!/usr/bin/env python3
"""Read-only diagnostics about the CI environment and GitHub token.

Usage (inside GitHub Actions):  python3 scripts/token_selftest.py

Prints whether GITHUB_TOKEN / GITHUB_REPOSITORY are set, then performs
read-only API calls (GET /user, GET /repos/<repo>) and prints the HTTP
status + short body. Never prints the token itself.
"""
import json
import os
import urllib.error
import urllib.request


def req(url, tok, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Authorization": "token " + tok,
        "User-Agent": "redstonepanel-diag",
        "Accept": "application/vnd.github+json",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, repr(e)


def main():
    tok = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    print("GITHUB_TOKEN present: %s (len %d)" % (bool(tok), len(tok)))
    print("GITHUB_REPOSITORY: %s" % (repo or "NOT SET"))
    print("GITHUB_API_URL: %s" % (os.environ.get("GITHUB_API_URL", "default api.github.com")))

    s, b = req("https://api.github.com/user", tok)
    print("GET /user -> HTTP %s: %s" % (s, b[:300]))
    if s == 200:
        try:
            print("token login: %s" % json.loads(b).get("login"))
        except Exception:  # noqa: BLE001
            pass

    if repo:
        s2, b2 = req("https://api.github.com/repos/" + repo, tok)
        print("GET /repos/%s -> HTTP %s: %s" % (repo, s2, b2[:200]))


if __name__ == "__main__":
    main()
