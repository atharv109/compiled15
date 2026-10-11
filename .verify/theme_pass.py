import io

s = io.open('console.css', encoding='utf-8').read()

# --- full-viewport app shell ---
s = s.replace("""#runview {
  height: 100vh;""", """#runview {
  height: 100vh;
  height: 100dvh;""")
s = s.replace(""".run-panes { flex: 1; display: flex; min-height: 0; }""",
""".run-panes { flex: 1; display: flex; min-height: 0; overflow: hidden; }

/* runview = app shell: the page never scrolls, pane bodies do */
body.run-active { overflow: hidden; height: 100dvh; }""")

# --- pane chrome type scale ---
s = s.replace(""".pane-title {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.7px;
  text-transform: uppercase;
  color: var(--c-ink);
}""", """.pane-title {
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--c-ink);
}""")
s = s.replace(""".pane-note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 0.6rem; color: var(--c-faint); }""",
""".pane-note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.8rem; color: var(--c-sec); }""")

# --- step rail labels >= 14px; numbers stay mono ---
s = s.replace(""".rtab {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  background: none;
  border: 1px solid transparent;
  padding: 6px 3px;
  font-family: var(--font-mono);
  font-size: 0.62rem;
  color: var(--c-sec);
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
}
.rtab b { font-size: 0.68rem; font-weight: 800; color: var(--c-faint); }""",
""".rtab {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  background: none;
  border: 1px solid transparent;
  padding: 6px 3px;
  font-size: 0.875rem;
  color: var(--c-sec);
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
}
.rtab b { font-family: var(--font-mono); font-size: 0.72rem; font-weight: 800; color: var(--c-faint); }""")

# --- launcher chrome: Inter labels ---
s = s.replace(".nav-note {\n  font-family: var(--font-mono);\n  font-size: 0.72rem;", ".nav-note {\n  font-size: 0.8rem;")
s = s.replace(".wf-head {\n  font-family: var(--font-mono);\n  font-size: 0.76rem;", ".wf-head {\n  font-size: 0.8rem;\n  font-weight: 600;")
s = s.replace(""".box-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--c-sec);
  margin-bottom: 10px;
}""", """.box-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--c-sec);
  margin-bottom: 10px;
}""")
s = s.replace(""".code-input {
  width: 100%;
  background: #FAFAFA;
  border: 1px solid #DDD;
  color: var(--c-ink);
  font-family: var(--font-mono);
  font-size: 0.9rem;""", """.code-input {
  width: 100%;
  background: #FAFAFA;
  border: 1px solid #DDD;
  color: var(--c-ink);
  font-size: 0.92rem;""")
s = s.replace(""".hint-row {
  font-family: var(--font-mono);
  font-size: 0.66rem;""", """.hint-row {
  font-size: 0.78rem;""")
s = s.replace(""".divider-label {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 4px 14px;
  font-family: var(--font-mono);
  font-size: 0.68rem;""", """.divider-label {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 4px 14px;
  font-size: 0.72rem;
  font-weight: 600;""")
s = s.replace(""".box-badge {
  text-align: right;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: #AAA;
  margin-top: 8px;
}""", """.box-badge {
  text-align: right;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: #AAA;
  margin-top: 8px;
}""")
s = s.replace(""".start-btn {
  width: calc(100% - 16px);
  margin: 6px 8px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #111111;
  color: #fff;
  border: 0;
  border-radius: 0;
  padding: 18px 22px;
  font-family: var(--font-mono);
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: 1px;""", """.start-btn {
  width: calc(100% - 16px);
  margin: 6px 8px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #111111;
  color: #fff;
  border: 0;
  border-radius: 0;
  padding: 18px 22px;
  font-size: 1.06rem;
  font-weight: 600;
  letter-spacing: 0.2px;""")
s = s.replace(""".demo-notice {
  background: var(--warn-bg);
  border-top: 1px solid rgba(255, 178, 36, 0.35);
  font-family: var(--font-mono);
  font-size: 0.78rem;""", """.demo-notice {
  background: var(--warn-bg);
  border-top: 1px solid rgba(255, 178, 36, 0.35);
  font-size: 0.82rem;""")

# --- found banner: Inter, legible ---
s = s.replace(""".found-banner .fb-copy {
  flex: 1;
  min-width: 0;
  font-size: 0.7rem;
  line-height: 1.45;
  color: var(--c-sec);
}""", """.found-banner .fb-copy {
  flex: 1;
  min-width: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--c-sec);
}""")
s = s.replace(""".found-banner .fb-yes, .found-banner .fb-no {
  border: 0; border-radius: 8px; padding: 5px 10px; cursor: pointer;
  font-family: var(--font-mono); font-size: 0.62rem; font-weight: 700;
  letter-spacing: 0.3px; transition: background 0.2s, transform 0.2s;
}""", """.found-banner .fb-yes, .found-banner .fb-no {
  border: 0; border-radius: 8px; padding: 5px 10px; cursor: pointer;
  font-size: 0.76rem; font-weight: 600;
  transition: background 0.2s, transform 0.2s;
}""")

# --- run log strip: label Inter, data mono ---
s = s.replace(""".runlog-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: 0;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--c-faint);
}""", """.runlog-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  background: none;
  border: 0;
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--c-sec);
}""")
s = s.replace(""".rl-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 0;
  border-bottom: 1px dashed var(--c-line);
  font-family: var(--font-mono);
  font-size: 0.62rem;
  line-height: 1.5;
  color: var(--c-sec);
  animation: cs-fl-in 0.25s var(--ease-out) both;
}
.rl-line:last-child { border-bottom: 0; }
.rl-time { flex: none; min-width: 46px; color: var(--c-faint); font-variant-numeric: tabular-nums; }""",
""".rl-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 0;
  border-bottom: 1px dashed var(--c-line);
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--c-sec);
  animation: cs-fl-in 0.25s var(--ease-out) both;
}
.rl-line:last-child { border-bottom: 0; }
.rl-time { flex: none; min-width: 48px; color: var(--c-faint); font-family: var(--font-mono); font-size: 0.66rem; font-variant-numeric: tabular-nums; }""")

# --- verdict card: Inter + glass over black ---
s = s.replace(""".verdict-card {
  flex: none;
  border-bottom: 1px solid var(--c-line);
  background: var(--c-canvas);
  animation: cs-fl-in 0.3s var(--ease-out) both;
}""", """.verdict-card {
  flex: none;
  border: 1px solid var(--line-08);
  background: var(--glass-04);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  backdrop-filter: blur(16px) saturate(1.2);
  border-radius: 15px;
  margin: 10px 10px 0;
  animation: cs-fl-in 0.3s var(--ease-out) both;
}""")
s = s.replace(""".vc-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 11px 14px;
  background: none;
  border: 0;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--accent-deep);
  text-align: left;
}""", """.vc-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 11px 14px;
  background: none;
  border: 0;
  cursor: pointer;
  font-size: 0.92rem;
  font-weight: 600;
  letter-spacing: 0.1px;
  color: var(--accent-deep);
  text-align: left;
}""")
s = s.replace(""".vc-mini { margin-left: auto; font-size: 0.6rem; font-weight: 600; color: var(--c-ter); white-space: nowrap; }""",
""".vc-mini { margin-left: auto; font-family: var(--font-mono); font-size: 0.7rem; font-weight: 600; color: var(--c-ter); white-space: nowrap; }""")
s = s.replace(""".vc-hero {
  font-family: var(--font-console);
  font-size: 0.98rem;""", """.vc-hero {
  font-size: 1.15rem;""")
s = s.replace(""".vc-cap {
  flex: none;
  width: 72px;
  font-family: var(--font-mono);
  font-size: 0.58rem;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--c-faint);
}""", """.vc-cap {
  flex: none;
  width: 76px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--c-faint);
}""")
s = s.replace(""".vc-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-family: var(--font-mono);
  font-size: 0.6rem;
  margin: 2px 0 4px 82px;
}""", """.vc-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  margin: 2px 0 4px 86px;
}""")
s = s.replace(""".vc-lock-t {
  font-family: var(--font-console);
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--c-ink);
  margin-bottom: 10px;
}""", """.vc-lock-t {
  font-size: 1.05rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--c-ink);
  margin-bottom: 10px;
}""")
s = s.replace(""".vc-cta {
  border: 0;
  border-radius: 10px;
  background: var(--accent-deep);
  color: #1a130a;
  font-family: var(--font-mono);
  font-size: 0.84rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 10px 22px;""", """.vc-cta {
  border: 0;
  border-radius: 10px;
  background: var(--accent-deep);
  color: #1a130a;
  font-size: 0.92rem;
  font-weight: 600;
  letter-spacing: 0.2px;
  padding: 10px 22px;""")
s = s.replace(""".vc-srow b { flex: none; font-family: var(--font-mono); font-size: 0.68rem; color: var(--accent-deep); min-width: 70px; }""",
""".vc-srow b { flex: none; font-family: var(--font-mono); font-size: 0.74rem; color: var(--accent-deep); min-width: 70px; }""")

io.open('console.css', 'w', encoding='utf-8', newline='\n').write(s)
print('ok')