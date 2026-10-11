"""Full integrated smoke, reusable. Zero hardcoded state:
creates a fresh session, debates a question, checks the unpaid gate,
pays, tests agent chat, Act. Prints a sectioned report. Loop/chart are
NOT run here (see --loop flag; 2-4 min)."""
import io
import json
import sys
import time
import urllib.request
import urllib.error

sys.path.insert(0, "C:/Users/athar/OneDrive/Desktop/compiled15")

BASE = "http://127.0.0.1:8000"
QUESTION = "Should we stay open until 2 AM on football Saturdays?"
BUSINESS = "Cafe 210 West"


def req(path, body=None, method=None, timeout=300):
    if method is None:
        method = "POST" if body is not None else "GET"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data,
                               headers={"Content-Type": "application/json"},
                               method=method)
    try:
        resp = urllib.request.urlopen(r, timeout=timeout)
        return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def wait_status(sid, want, tries, every=8):
    for _ in range(tries):
        st, d = req(f"/api/sessions/{sid}")
        if st == 200 and (d or {}).get("status") == want:
            return d
        time.sleep(every)
    return d


t0 = time.time()
el = lambda: f"[{round(time.time()-t0):>4}s]"

reviews = io.open("data/REAL-reviews-cafe210-west.txt", encoding="utf-8").read()
st, s = req("/api/sessions", {"business_name": BUSINESS, "town": "State College",
                              "reviews_text": reviews})
assert st == 200, s
sid = s["session_id"]
print(f"{el()} create: {sid}")

d = wait_status(sid, "ready", 14)
print(f"{el()} ingest: {d['status']} evidence={len(d.get('evidence') or [])} "
      f"class={d['business'].get('business_class')}")
assert d["status"] == "ready"

st, _ = req(f"/api/sessions/{sid}/question", {"text": QUESTION})
assert st == 200, st
d = wait_status(sid, "verdict_ready", 40)
v = d.get("verdict") or {}
print(f"{el()} debate+judge: {v.get('recommendation', '')[:120]}")
print(f"        confidence={v.get('confidence')} (verdict keys while UNPAID: "
      f"{sorted(v.keys())})")
if "tally" in v:
    print("        *** GATING LEAK: unpaid sees full verdict ***")
else:
    print("        teardown gate OK (teaser only, unpaid)")

st, _ = req(f"/api/sessions/{sid}/pay/mark-paid", {})
st, d = req(f"/api/sessions/{sid}")
full = d.get("verdict") or {}
print(f"{el()} paid: verdict keys now {sorted(full.keys())} tally={full.get('tally')}")

if not full.get("tally"):
    sys.exit("no tally after pay - aborting chat/act")

# agent chat on a supporter persona
personas = d.get("personas") or []
sup = next((p for p in personas if p.get("segment") == "students"), personas[0])
st, chat = req(f"/api/sessions/{sid}/agents/{sup['id']}/chat",
               {"message": "Why does this matter to you? Keep it short."})
print(f"{el()} chat[{sup['id']} {sup.get('name')}]: {st} "
      f"\n        reply: {(chat.get('reply') or '')[:160]}"
      f"\n        cites: {chat.get('evidence_ids')}")

if "--loop" in sys.argv:
    st, loopd = req(f"/api/sessions/{sid}/run-loop", {}, timeout=590)
    print(f"{el()} loop: {st} rows={len(loopd.get('round_scores') or [])}")
    tr = [round(x["regret"], 3) for x in loopd.get("round_scores", []) if x["split"] == "train"]
    print(f"        train regret: {tr}")
    fe = {k: round(v, 4) for k, v in (loopd.get("final_eval") or {}).items()
          if isinstance(v, (int, float))}
    print(f"        final_eval: {fe}")

st, act = req(f"/api/sessions/{sid}/act", {}, timeout=300)
print(f"{el()} act: {st} type={act.get('artifact_type')} best={act.get('best_id')}")
for dr in act.get("drafts") or []:
    print(f"        DRAFT {dr['id']}: {dr['title'][:60]}")
    print(f"          {dr['body_text'][:160]}")
print(f"{el()} INTEGRATED CHECK DONE")
io.open(".last_sid", "w").write(sid)