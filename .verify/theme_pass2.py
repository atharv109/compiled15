import io

s = io.open('agent-thread.css', encoding='utf-8').read()

# peer head: name 17px, sub stays mono (data), slightly bigger
s = s.replace(""".ad-who .mono {
  font-family: var(--font-mono);
  font-size: 0.62rem;""", """.ad-who .mono {
  font-family: var(--font-mono);
  font-size: 0.74rem;""")
s = s.replace(".ad-who b { font-size: 0.92rem; font-weight: 600; color: var(--c-ink); }",
              ".ad-who b { font-size: 1.06rem; font-weight: 600; letter-spacing: -0.01em; color: var(--c-ink); }")

# quote / empty state 16px
s = s.replace(""".ad-quote {
  font-size: 0.82rem;""", """.ad-quote {
  font-size: 1rem;""")
s = s.replace(""".ad-quote .mono,
.ad-quote span {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.62rem;""", """.ad-quote .mono,
.ad-quote span {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.72rem;""")

# bubbles: 16px text, theme bubble on glass
s = s.replace(""".ad-bubble {
  max-width: 86%;
  padding: 10px 14px;
  font-size: 0.84rem;""", """.ad-bubble {
  max-width: 86%;
  padding: 11px 15px;
  font-size: 1rem;""")
s = s.replace(""".ad-msg.them .ad-bubble {
  background: var(--c-canvas);
  border: 1px solid var(--c-line);
  color: var(--c-body);
  border-bottom-left-radius: 4px;
}""", """.ad-msg.them .ad-bubble {
  background: var(--glass-06);
  border: 1px solid var(--line-08);
  color: var(--c-body);
  border-bottom-left-radius: 4px;
}""")

# locked/waiting card on glass
s = s.replace(""".ad-lock {
  margin: auto 4px;
  padding: 26px 20px;
  text-align: center;
  border: 1px solid var(--c-line-2);
  border-radius: 14px;
  background: var(--c-canvas);""", """.ad-lock {
  margin: auto 4px;
  padding: 26px 20px;
  text-align: center;
  border: 1px solid var(--line-12);
  border-radius: 14px;
  background: var(--glass-04);""")

# composer: Inter 16px input, glass field on black
s = s.replace(""".ad-foot {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 14px;
  border-top: 1px solid var(--c-line);
  background: var(--c-canvas);
}
.ad-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 0.84rem;
  line-height: 1.5;
  color: var(--c-ink);
  background: var(--c-bg);
  border: 1px solid var(--c-line-2);""", """.ad-foot {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 14px;
  border-top: 1px solid var(--line-08);
  background: var(--glass-04);
}
.ad-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-landing);
  font-size: 1rem;
  line-height: 1.5;
  color: var(--c-ink);
  background: var(--glass-06);
  border: 1px solid var(--line-12);""")
s = s.replace(""".ad-send {
  flex: none;
  border: 0;
  border-radius: 10px;
  background: var(--c-ink);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  font-weight: 700;
  padding: 12px 18px;""", """.ad-send {
  flex: none;
  border: 0;
  border-radius: 10px;
  background: var(--accent-deep);
  color: #1a130a;
  font-size: 0.9rem;
  font-weight: 600;
  padding: 12px 18px;""")

# chat surface: flat black, hairlines only
s = s.replace(""".chat-station {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--c-canvas);
}

.ad-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px 10px 13px;
  border-bottom: 1px solid var(--c-line);
}""", """.chat-station {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: transparent;
}

.ad-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px 10px 13px;
  border-bottom: 1px solid var(--line-08);
}""")

io.open('agent-thread.css', 'w', encoding='utf-8', newline='\n').write(s)
print('ok')