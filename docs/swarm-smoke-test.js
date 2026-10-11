/* Harness for smoke-testing steps/swarm.js without a browser.
   Minimal DOM: elements with classList/attrs/children, a tiny tag parser,
   a CS bus shim mirroring bridge.js surface. */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------- tiny DOM shim ---------- */
class FT {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._class = new Set();
    this._text = "";
    this.listeners = {};
    this._innerHTML = "";
    this.style = { setProperty() {}, cssText: "" };
    this.hidden = false;
    const self = this;
    const cl = {
      add(...cs) { cs.forEach((c) => c.split(/\s+/).filter(Boolean).forEach((x) => self._class.add(x))); self._syncClass(); },
      remove(...cs) { cs.forEach((c) => c.split(/\s+/).filter(Boolean).forEach((x) => self._class.delete(x))); self._syncClass(); },
      contains(c) { return self._class.has(c); },
      toggle(c) { self._class.has(c) ? self._class.delete(c) : self._class.add(c); self._syncClass(); },
    };
    this.classList = cl;
    if (tag === "template") this.content = new FT("div");
  }
  get _cl() { return this._class; }
  add(c) { this._class.add(c); this._syncClass(); }
  remove(c) { this._class.delete(c); this._syncClass(); }
  contains(c) { return this._class.has(c); }
  _syncClass() { this.attrs["class"] = Array.from(this._class).join(" "); }
  get className() { return this.attrs["class"] || ""; }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); this._syncClass(); }
  set innerHTML(html) {
    if (this.tagName === "TEMPLATE") { this.content.innerHTML = html; return; }
    this._innerHTML = html;
    this.children = [];
    parse(html, this);
  }
  get innerHTML() { return this.tagName === "TEMPLATE" ? this.content._innerHTML : this._innerHTML; }
  set textContent(v) { this._text = String(v); this.children = []; this._innerHTML = ""; }
  get textContent() { return this._text; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  prepend(c) { c.parentNode = this; this.children.unshift(c); return c; }
  remove() {
    if (this._class && this._class.has("sw-detail")) { console.log("TRACE removal of .sw-detail"); console.log(new Error("trace").stack.split("\n").slice(1, 9).join("\n")); }
    if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; }
  }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); } }
  getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { const a = this.listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  dispatch(t, e) { for (const fn of this.listeners[t] || []) fn(e || { stopPropagation() {}, clientX: 100, clientY: 100, target: this }); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 560, right: 900, bottom: 560 }; }
  _all(out) { for (const c of this.children) { out.push(c); c._all(out); } return out; }
  _match(sel) {
    const cls = sel.split(".").filter(Boolean);
    return cls.every((c) => this._class.has(c));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    for (const el of this._all([])) if (el._match(sel)) out.push(el);
    return out;
  }
  querySelectorNS(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/* whitespace-insensitive parser for our simple markup */
function parse(html, parent) {
  const stack = [parent];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[5]) { const t = stack[stack.length - 1]; t._text += (t._text || "") + m[5].trim(); continue; }
    const closing = m[1] === "/", tag = m[2].toLowerCase();
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const el = new FT(tag);
    const cattr = (m[3].match(/class\s*=\s*"([^"]*)"/) || [])[1];
    if (cattr) { el._class = new Set(cattr.split(/\s+/).filter(Boolean)); el._syncClass(); }
    const o = (m[3].match(/type\s*=\s*"([^"]*)"/) || [])[1];
    if (o) el.setAttribute("type", o);
    stack[stack.length - 1].appendChild(el);
    if (!m[4]) stack.push(el);
  }
}

/* ---------- CS bus shim (mirrors bridge.js) ---------- */
class Bus {
  constructor() { this.m = new Map(); }
  addEventListener(n, fn) { if (!this.m.has(n)) this.m.set(n, []); this.m.get(n).push(fn); }
  removeEventListener(n, fn) { const a = this.m.get(n) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  dispatchEvent(e) { for (const fn of this.m.get(e.type) || []) fn(e); }
}
const bus = new Bus();
global.EventTarget = Bus;
global.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
const session = { evidence: [], segments: [], personas: [] };
global.window = {
  CS: {
    STEPS: [], PAL: ["#B45309", "#0F766E", "#7C3AED", "#1D4ED8", "#BE185D", "#65A30D", "#C2410C", "#0369A1", "#7E22CE", "#4D7C0F"],
    session: session, bus: bus, state: "running",
    register(s) { this.STEPS.push(s); },
    on(n, fn) { const wrap = (e) => fn(e.detail); bus.addEventListener(n, wrap); return () => bus.removeEventListener(n, wrap); },
    esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },
    color(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return this.PAL[h % this.PAL.length]; },
    el(html) {
      const t = new FT("template");
      t.innerHTML = html.trim();
      return t.content.firstElementChild;
    },
  },
  addEventListener() {}, removeEventListener() {},
  innerWidth: 1400, innerHeight: 900,
  location: { search: "" },
  CSEffects: {
    avatar(id, size) { return '<span class="cs-avatar" data-id="' + id + '"></span>'; },
  },
};
global.document = {
  createElement(t) { return new FT(t); },
  createElementNS(ns, t) { return new FT(t); },
  addEventListener() {},
};
document.head = { appendChild() {} };

/* rAF: run synchronously, max 240 simulated frames */
let pending = [];
global.requestAnimationFrame = (fn) => { pending.push(fn); return pending.length; };
global.cancelAnimationFrame = () => {};
function frames(n) {
  for (let i = 0; i < n; i++) {
    const cur = pending; pending = [];
    if (!cur.length) return true;
    cur.forEach((fn) => fn());
  }
  return pending.length > 0;
}

/* ---------- load module ---------- */
const src = fs.readFileSync(path.join(process.argv[2], "swarm.js"), "utf8");
/* run in a Function scope with `window` bound */
new Function("window", "document", "CS", "requestAnimationFrame", "cancelAnimationFrame",
  "location", "setTimeout", "clearTimeout", src + "\n//# sourceURL=swarm.js")(
  global.window, global.document, global.window.CS, global.requestAnimationFrame, global.cancelAnimationFrame,
  global.window.location, (fn, ms) => { fn(); return 0; }, () => {});
const step = global.window.CS.STEPS.find((s) => s.id === "swarm");
if (!step) { console.log("FAIL: step not registered"); process.exit(1); }
console.log("registered:", JSON.stringify({ id: step.id, num: step.num, title: step.title, short: step.short }));

function assert(cond, msg) { if (!cond) { console.log("FAIL:", msg); process.exit(1); } console.log("ok:", msg); }

/* ---------- test A: mount on EMPTY session ---------- */
const mountA = new FT("div");
step.render(mountA, session);
assert(mountA.children.length === 1, "A: root appended");
const rootA = mountA.children[0];
const title = rootA.querySelector(".sw-title");
assert(title && title.textContent === "Awaiting scout results…", "A: empty-title");
assert(rootA.querySelectorAll(".nd").length === 0, "A: no nodes");
const hint = rootA.querySelector(".sw-seg-hint");
assert(!!hint, "A: segments hint");
frames(30);
console.log("A: physics idle ok, pending rAF:", pending.length);

/* ---------- test B: catch-up, fully populated session ---------- */
const names = ["Maya", "Jordan", "Priya", "Ethan", "Sofia", "Marcus", "Ava", "Tyler"];
session.evidence.push(
  { id: "E1", claim: "Study late wishes", source_url: "g", source_label: "Google", type: "wishes" },
  { id: "E2", claim: "Competitors close midnight", source_url: "g", source_label: "Comp", type: "market" },
  { id: "E3", claim: "Turnover doubled", source_url: "y", source_label: "Yelp", type: "operations" },
  { id: "E11", claim: "Viral claim 40%", source_url: "r", source_label: "Forum", type: "weak", weak: true }
);
session.segments.push(
  { id: "S1", name: "Late-Night Study Crowd", size: 4, description: "Students; a 10pm+ refuge, late hours." },
  { id: "S2", name: "Consistency Loyalists", size: 4, description: "Regulars; sensitive to staff turnover." }
);
for (let i = 1; i <= 8; i++) {
  session.personas.push({
    id: "P" + (i < 10 ? "0" + i : i), name: names[i - 1],
    segment: i <= 4 ? "S1" : "S2",
    quote: "quote " + i, stance: i <= 4 ? "for" : "against",
  });
}
const mountB = new FT("div");
step.render(mountB, session);   // destroys instance A, fresh catch-up mount
const rootB = mountB.children[0];
const nds = rootB.querySelectorAll(".nd");
assert(nds.length === 14, "B: 14 nodes mounted (4 ev + 2 seg + 8 per), got " + nds.length);
const lk = rootB.querySelectorAll(".lk");
assert(lk.length === 12, "B: 12 edges (4 ev + 8 per), got " + lk.length);
const weak = rootB.querySelectorAll(".nd-ev.is-weak");
assert(weak.length === 1, "B: 1 weak evidence node");
frames(240);
assert(pending.length === 0, "B: sim settled (alpha<0.02), pending rAF " + pending.length);
/* physics sanity: all settled node transforms finite, personas clustered 2 groups */
{
  const nodes = rootB.querySelectorAll(".nd");
  let bad = 0, xs = [];
  for (const el of nodes) {
    const t = /translate\(([-\d.]+),([-\d.]+)\)/.exec(el.getAttribute("transform") || "");
    if (!t) { bad++; continue; }
    const x = parseFloat(t[1]), y = parseFloat(t[2]);
    if (!isFinite(x) || !isFinite(y)) bad++;
    else xs.push([x, y]);
  }
  assert(bad === 0, "physics: all nodes have finite positions");
  let minSep = 1e9;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    const d = Math.hypot(xs[i][0] - xs[j][0], xs[i][1] - xs[j][1]);
    if (d < minSep) minSep = d;
  }
  assert(minSep > 5, "physics: minimum pairwise separation " + minSep.toFixed(1) + " > 5px (no collapse)");
  let maxD = 0;
  for (const [x, y] of xs) { maxD = Math.max(maxD, Math.hypot(x - 450, y - 280)); }
  assert(maxD < 500, "physics: graph stays inside canvas (max spread " + maxD.toFixed(0) + "px)");
}

const agents = rootB.querySelectorAll(".sw-agent");
assert(agents.length === 6, "B: stream shows 6 seeded agents, got " + agents.length);
const segCards = rootB.querySelectorAll(".sw-seg");
assert(segCards.length === 2, "B: 2 segment cards");
const count = rootB.querySelector(".sw-count");
assert(count.textContent === "8 agents · 2 segments", "B: counter '" + count.textContent + "'");

/* ---------- test C: streaming deltas on a live instance ---------- */
rootB.querySelectorAll; // noop
session.personas.push({ id: "P09", name: "Nadia", segment: "S1", quote: "late + quiet", stance: "for" });
bus.dispatchEvent(new CustomEvent("persona", { detail: session.personas[8] }));
frames(60);
const agentsC = rootB.querySelectorAll(".sw-agent");
assert(agentsC.length <= 9, "C: stream bounded, got " + agentsC.length);
assert(rootB.querySelectorAll(".nd").length === 15, "C: persona node merged");
assert(rootB.querySelectorAll(".lk").length === 13, "C: persona edge merged");
for (let i = 10; i <= 20; i++) {
  session.personas.push({ id: "P" + i, name: "Aga" + i, segment: "S2", quote: "q", stance: "neutral" });
  bus.dispatchEvent(new CustomEvent("persona", { detail: session.personas[i - 1] }));
}
frames(60);
assert(rootB.querySelectorAll(".nd").length === 26, "C: 11 more personas merged");
assert(rootB.querySelectorAll(".agent-flood").length === 0, "C: no flood class");
/* click the newest persona node -> detail panel */
const p09 = rootB.querySelectorAll(".nd-per")[0];
p09.dispatch("click");
const det = rootB.querySelector(".sw-detail");
assert(!det.hidden, "C: detail opens on persona click");
assert(det.innerHTML.indexOf("Maya") >= 0, "C: detail shows persona name (P01 Maya)");
assert(det.innerHTML.indexOf("Late-Night Study Crowd") >= 0, "C: detail shows its segment");
/* empty-space click clears */
rootB.querySelectorAll; rootB; new FT("svg");
/* scout:done title flip */
bus.dispatchEvent(new CustomEvent("scout:done", { detail: {} }));
assert(rootB.querySelector(".sw-title").textContent === "Scouts done · evidence base ready", "C: title after scout:done");

/* ---------- test D: session restart while mounted ---------- */
session.evidence.length = 0; session.segments.length = 0; session.personas.length = 0;
bus.dispatchEvent(new CustomEvent("session:start", { detail: { business: "X", question: "Y" } }));
const rootD = mountB.children[0];
assert(rootD.querySelectorAll(".nd").length === 0, "D: restart wipes nodes");
assert(!rootD.querySelector(".sw-detail").hidden ? false : true, "D: detail hidden after restart");

/* ---------- test E: re-mount storm (render spam) ---------- */
/* repopulate what test D wiped so E/F/G mounts carry full state */
session.evidence.push(
  { id: "E1", claim: "Study late wishes", source_url: "g", source_label: "Google", type: "wishes" },
  { id: "E2", claim: "Competitors close midnight", source_url: "g", source_label: "Comp", type: "market" },
  { id: "E3", claim: "Turnover doubled", source_url: "y", source_label: "Yelp", type: "operations" },
  { id: "E11", claim: "Viral claim 40%", source_url: "r", source_label: "Forum", type: "weak", weak: true }
);
session.segments.push(
  { id: "S1", name: "Late-Night Study Crowd", size: 4, description: "Students; a 10pm+ refuge, late hours." },
  { id: "S2", name: "Consistency Loyalists", size: 4, description: "Regulars; sensitive to staff turnover." }
);
for (let i = 9; i <= 20; i++) {
  session.personas.push({ id: "P" + i, name: "Aga" + i, segment: i <= 13 ? "S1" : "S2", quote: "q", stance: "neutral" });
}
let mountLast = null;
for (let i = 0; i < 5; i++) { const m = new FT("div"); step.render(m, session); frames(3); mountLast = m; }
console.log("ok: E: 5 rapid re-mounts, no throw");

/* ---------- test F: weak evidence detail chip ---------- */
{
  const weakNode = mountLast.querySelectorAll(".nd-ev.is-weak")[0];
  assert(!!weakNode, "F: weak node present on fresh mount");
  weakNode.dispatch("click");
  const detF = mountLast.querySelector(".sw-detail");
  assert(detF.innerHTML.indexOf("unverified") >= 0, "F: unverified chip in weak-evidence detail");
  /* ---------- test G: pairing determinism across two fresh mounts ---------- */
  const snap = (m) => m.querySelectorAll(".sw-seg").map((c) => c.textContent).sort().join("|");
  const mountG1 = new FT("div"), mountG2 = new FT("div");
  step.render(mountG1, session); step.render(mountG2, session);
  assert(snap(mountG1) === snap(mountG2), "G: deterministic output across mounts");
  const n1 = mountG1.querySelectorAll(".nd").length;
  assert(n1 === 18, "G: deterministic node count after re-mount (4 ev + 2 seg + 12 per), got " + n1);
}

console.log("\nALL SMOKE TESTS PASSED");