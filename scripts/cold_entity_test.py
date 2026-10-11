"""Cold entity test: name-only intake for an arbitrary business; no prep.
Usage: python scripts/cold_entity_test.py "Luminal" [town] [question]
"""
import io
import json
import sys
import urllib.request as u

BASE = "http://127.0.0.1:8000"


def req(p, body=None, method=None, t=120):
    """GET unless body given; method overrides. (POST /x needs body={})"""
    if method is None:
        method = "POST" if body is not None else "GET"
    data = json.dumps(body).encode() if body is not None else None
    try:
        resp = u.urlopen(u.Request(BASE + p, data=data,
                                   headers={"Content-Type": "application/json"},
                                   method=method), timeout=t)
        return resp.status, json.loads(resp.read() or b"null")
    except u.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def main():
    args = [a for a in sys.argv[1:]]
    name = args[0] if args else "Luminal"
    town = None
    question = "Should we invest more in community sponsorships or content marketing?"
    for a in args[1:]:
        if "?" in a:
            question = a
        elif not town:
            town = a
    payload = {"business_name": name}
    if town:
        payload["town"] = town
    st, s = req("/api/sessions", payload)
    print("[create]", st, s)
    if st != 200:
        return
    sid = s["session_id"]
    d = None
    for _ in range(20):
        time.sleep(6)
        st, d = req(f"/api/sessions/{sid}")
        if st == 200 and d and d.get("status") == "ready":
            break
    b = d.get("business") or {}
    ent = b.get("entity") or {}
    print("[resolved] kind:", ent.get("business_kind"), "| conf:", ent.get("confidence"),
          "| loc:", ent.get("location"))
    print("  candidates:", json.dumps(ent.get("candidates"))[:240])
    print("  class:", b.get("business_class"),
          "| evidence:", len(d.get("evidence") or []))
    types = {}
    for e in d.get("evidence") or []:
        types[e["type"]] = types.get(e["type"], 0) + 1
    print("  evidence types:", types)
    st, _ = req(f"/api/sessions/{sid}/question", {"text": question})
    for _ in range(40):
        time.sleep(10)
        st, d = req(f"/api/sessions/{sid}")
        if d and d.get("status") == "verdict_ready":
            break
    st, _ = req(f"/api/sessions/{sid}/pay/mark-paid", {})
    st, d = req(f"/api/sessions/{sid}")
    seg = {}
    for p in d.get("personas") or []:
        seg[p["segment"]] = seg.get(p["segment"], 0) + 1
    print("[personas]", seg)
    v = d.get("verdict") or {}
    print("[verdict]", (v.get("recommendation") or "")[:250])
    print("  conf:", v.get("confidence"), "| tally:", v.get("tally"))
    io.open(".cold_sid", "w").write(sid)
    print("COLD TEST DONE:", sid)


if __name__ == "__main__":
    import time
    main()