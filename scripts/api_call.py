"""Tiny API test harness. Usage (from repo root):
  python scripts/api_call.py GET  /api/sessions/s_x
  python scripts/api_call.py POST /api/sessions '{"business_name":"Cafe 210 West","town":"State College"}'
GET is the default request method; POST requires explicit JSON body (or '{}' for empty).
Prints the HTTP status line, then the response body (pretty JSON). Exits nonzero on 4xx/5xx.
"""
import json
import sys
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8000"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    args = sys.argv[1:]
    # accept both /api/... (bash-safe via MSYS env) and api/... (always safe)
    if args[0].upper() in ("GET", "POST", "PUT", "DELETE"):  # method-first form
        method = args[0].upper()
        raw_path = args[1]
        body_raw = args[2] if len(args) > 2 else ("{}" if method == "POST" else None)
    else:  # path-first form
        raw_path = args[0]
        method = args[1].upper() if len(args) > 1 else "GET"
        body_raw = args[2] if len(args) > 2 else ("{}" if method == "POST" else None)
    path = "/" + raw_path.lstrip("/")  # MSYS converts leading-slash args; bare paths survive
    body = json.dumps(json.loads(body_raw)).encode() if body_raw is not None else None
    req = urllib.request.Request(
        BASE + path, data=body,
        headers={"Content-Type": "application/json"}, method=method,
    )
    try:
        resp = urllib.request.urlopen(req, timeout=590)
        status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
        print(f"HTTP {status}")
        print(e.read().decode("utf-8", "replace") or "{}")
        return 1
    print(f"HTTP {status}")
    print(json.dumps(json.loads(resp.read() or b"null"), indent=1)[:3000])
    return 0


if __name__ == "__main__":
    sys.exit(main())