/* ============================================================
   Customer Swarm — mock-data.js
   The demo replay dataset: Cafe 210 West. Every byte of persona
   content is written as if it was scraped from public reviews —
   this is what the live backend streams over SSE; the frontend
   replay is a faithful rehearsal of that channel.
   ============================================================ */
window.CS_SESSION_DEMO = {
  business: { name: "Cafe 210 West", class: "local_consumer" },
  question:
    "Should we stay open until 2 AM on weekends and spend $400/month on a blanket 20% delivery-app promo?",

  /* ---- 01 · scout adapters (name-only intake) ---- */
  sources: [
    { key: "classify",    label: "Business classifier",  status: "ok",     count: null, note: "local_consumer · confidence 0.94" },
    { key: "g_reviews",   label: "Google reviews",       status: "scraped", count: 97,  note: "97 with text · 150 cap" },
    { key: "g_profile",   label: "Google profile",       status: "scraped", count: 1,   note: "hours · menu link · price band" },
    { key: "menu",        label: "Current menu",         status: "scraped", count: 42,  note: "42 items w/ prices" },
    { key: "competitors", label: "Nearby competitors",   status: "ok",     count: 6,   note: "2 close past midnight" },
    { key: "tavily_news", label: "News & local blogs",   status: "ok",     count: 4,   note: "1 feature · 3 mentions" },
    { key: "yelp",        label: "Yelp reviews",         status: "cached",  count: 53,  note: "from previous run" },
  ],
  reviews: [
    { text: "Go-to study spot after 8pm — outlets everywhere, never rushed. Wish they stayed open later though.", rating: 5, source: "Google" },
    { text: "Brunch with the kids is our Sunday ritual. Fast, warm, and they don't blink at a stroller parade.", rating: 5, source: "Google" },
    { text: "The new pastry case is dangerous. Staff turnover shows though — my latte order got flubbed twice this month.", rating: 3, source: "Yelp" },
    { text: "Ordered delivery at 11:30pm Friday and the app said closed. Missed revenue walking out the door?", rating: 4, source: "Google" },
    { text: "Quiet corners and no laptop-bro energy on weekday mornings. Please never change.", rating: 5, source: "Yelp" },
    { text: "Prices crept up again. $19 for brunch for one feels steep unless the promo discount hits.", rating: 3, source: "Google" },
    { text: "Barista remembered my order week two. I'd follow this place into a late-night slot happily.", rating: 5, source: "Google" },
    { text: "Parking after 7pm is misery. Only worth it if you live on this side of College Ave.", rating: 2, source: "Yelp" },
  ],

  /* ---- 02 · evidence cards {claim, source_url, type} ---- */
  evidence: [
    { id: "E1",  claim: "Reviewers repeatedly mention studying late and wish for later hours.", source_url: "google.com/maps/r/210w", source_label: "Google reviews", type: "wishes" },
    { id: "E2",  claim: "Two of six nearby competitors already close at midnight or later.", source_url: "google.com/maps/search/cafes", source_label: "Competitor scan", type: "market" },
    { id: "E3",  claim: "Staff turnover complaints doubled in reviews over the last 6 months.", source_url: "yelp.com/210w", source_label: "Yelp reviews", type: "operations" },
    { id: "E4",  claim: "Morning regulars praise the quiet/early atmosphere as the core draw.", source_url: "google.com/maps/r/210w", source_label: "Google reviews", type: "praise" },
    { id: "E5",  claim: "Brunch-for-one around $19 draws occasional 'steep' price complaints.", source_url: "google.com/maps/r/210w", source_label: "Google reviews", type: "price" },
    { id: "E6",  claim: "Menu prices rose ~9% this year per archived menus.", source_url: "web.archive.org", source_label: "Menu archive", type: "price" },
    { id: "E7",  claim: "Delivery-app listing goes dark at 23:00 — late orders bounce.", source_url: "doordash.com/store/210w", source_label: "Delivery listing", type: "market" },
    { id: "E8",  claim: "Local blog named the cafe 'best Sunday family brunch' in 2025.", source_url: "statecollege.local/news", source_label: "Local news", type: "praise" },
    { id: "E9",  claim: "Parking complaints cluster after 19:00 — evening access is the friction.", source_url: "yelp.com/210w", source_label: "Yelp reviews", type: "operations" },
    { id: "E10", claim: "Weekday 10am–3pm foot-traffic mention rate trails mornings 2:1.", source_url: "google.com/maps/r/210w", source_label: "Google reviews", type: "operations" },
    { id: "E11", claim: "A viral post claims late hours lift cafe revenue 40%.", source_url: "reddit.com/r/cafeowners", source_label: "Forum post", type: "weak", weak: true },
    { id: "E12", claim: "Promo-driven orders often replace full-margin dine-ins per owner-thread anecdotes.", source_url: "reddit.com/r/cafeowners", source_label: "Forum post", type: "weak", weak: true },
  ],

  /* ---- 03 · emergent segments (from the swarm's own clustering) ---- */
  segments: [
    { id: "S1", name: "Weekend Brunch Families", size: 9,  description: "Sunday ritualists with strollers; loyalty tied to morning speed and family tolerance." },
    { id: "S2", name: "Late-Night Study Crowd",  size: 8,  description: "Students; outlets, refills, and a 10pm+ refuge. The would-be late-hours customers." },
    { id: "S3", name: "Early Quiet Seekers",     size: 8,  description: "Weekday-morning purists; fear any change that makes evenings busier or mornings louder." },
    { id: "S4", name: "Coffee-First Commuters",  size: 9,  description: "In-and-out before 9am; judge the cafe on speed and consistency, ignore evening drama." },
    { id: "S5", name: "Consistency Loyalists",   size: 8,  description: "Staff-recognition regulars; sensitive to turnover and to any quality dip from overextension." },
    { id: "S6", name: "Deal-Driven Occasionals", size: 8,  description: "Promo-responsive but low loyalty; the exact customers a 20% blanket promo buys." },
  ],

  /* ---- 50 personas: synthesized below into D.personas (50 entries,
          id P01–P50, name, segment, quote, stance) ---- */
  personas: [],

  /* ---- 04 · debate (2 rounds, camps auto-clustered, digests feed round 2) ---- */
  debate: {
    rounds: [
      {
        n: 1,
        camps: [
          {
            name: "Late Hours Lift", size: 18, summary: "Extend; the demand exists and competitors already do it.",
            args: [
              { agent: "Maya", agentId: "P01", text: "I literally wrote 'wish they stayed open later' into a review. The demand is real and it's me.", cites: ["E1"] },
              { agent: "Ethan", agentId: "P06", text: "Two of your six competitors already run past midnight. Every Friday you close, that traffic walks somewhere else.", cites: ["E2"] },
              { agent: "Nadia", agentId: "P20", text: "The delivery listing bounces late orders tonight, tonight after tonight. The money is already ringing someone else's bell.", cites: ["E7"] },
              { agent: "Felix", agentId: "P40", text: "A blanket promo sounds reckless, but the promo + hours together pull my whole cohort in from 10pm.", cites: ["E11"] },
            ],
          },
          {
            name: "Staffing Burn", size: 17, summary: "Quality is the moat; overextension kills it.",
            args: [
              { agent: "Marcus", agentId: "P05", text: "Turnover complaints doubled in six months. Stretch the rota to 2 AM and the foam, the greetings, everything thins out.", cites: ["E3"] },
              { agent: "Rosa", agentId: "P24", text: "The people who tip 30% tip because a rested barista remembers their name. Don't trade them for strangers.", cites: ["E3"] },
              { agent: "Grace", agentId: "P13", text: "My Sunday is sacred because it's calm. A skeleton crew at 1 AM Saturday means a wrecked crew at my 9 AM table.", cites: ["E4"] },
              { agent: "Bianca", agentId: "P45", text: "Parking after seven is already misery — the new late crowd adds nothing for neighbors, only friction.", cites: ["E9"] },
            ],
          },
          {
            name: "Margin Skeptics", size: 15, summary: "Do the math; a blanket promo buys exactly the wrong customers.",
            args: [
              { agent: "Theo", agentId: "P36", text: "$400 a month for a 20% blanket promo buys deal-hunters who vanish the day it ends. That's rented loyalty.", cites: ["E12"] },
              { agent: "Ines", agentId: "P17", text: "Prices already crept 9% and reviews noticed. A promo that silently raises everyone's effective price is a trap.", cites: ["E6"] },
              { agent: "Omar", agentId: "P27", text: "Promo orders cannibalize full-margin dine-ins — that's in every owner thread I've read. The math is ugly.", cites: ["E12"] },
            ],
          },
        ],
        digest: null, // round 1 starts raw — nothing to read yet
      },
      {
        n: 2,
        /* round 2 agents read the opposing camps' strongest round-1 args */
        camps: [
          {
            name: "Targeted Pilot", size: 26, summary: "Cap at midnight, Fri/Sat only, no blanket promo — test with a segment-scoped offer.",
            args: [
              { agent: "Rosa", agentId: "P24", text: "Conceding the hours but not the blanket: close at midnight, staff two deep, and see if the study crowd shows as claimed.", cites: ["E1", "E3"] },
              { agent: "Felix", agentId: "P40", text: "Fine — but aim the pilot at students honestly: a punch card for the 10pm–midnight window, not 20% off everything.", cites: ["E1"] },
              { agent: "Grace", agentId: "P13", text: "And spend the saved promo budget where the loyalty already lives: the morning families. Keep my table unbeaten.", cites: ["E4", "E8"] },
            ],
          },
          {
            name: "Hold the Line", size: 14, summary: "Don't extend at all; double down on the morning identity.",
            args: [
              { agent: "Marcus", agentId: "P05", text: "Even a midnight close asks the exhausted team for one more thing. Fix the turnover first, then revisit.", cites: ["E3"] },
              { agent: "Nora", agentId: "P30", text: "The quiet mornings ARE the differentiation. Two competitors already own the late slot — be the only calm one.", cites: ["E2", "E4"] },
            ],
          },
          {
            name: "Pro-Extension Holdouts", size: 10, summary: "The demand case survives — go later, with the promo trimmed.",
            args: [
              { agent: "Ethan", agentId: "P06", text: "You'll still close before the two competitors do. Midnight isn't a concession, it's a retreat.", cites: ["E2"] },
              { agent: "Maya", agentId: "P01", text: "Midnight plus a student punch card? Fine — I'll take it, but the review I'd write says 'almost'.", cites: ["E1"] },
            ],
          },
        ],
        digest: {
          about_camp: "Pro-Extension Holdouts",
          bullets: [
            "Midnight remains a retreat: two competitors still own the 12–2 AM window (E2).",
            "The demand case survives — the study crowd takes 'almost' if the late window is real (E1).",
            "A punch card only beats the blanket promo if redemptions are tracked daily.",
          ],
        },
      },
    ],
    demoted: [
      { round: 1, agent: "Felix", agentId: "P40", text: "…a viral study claims late hours lift cafe revenue 40%…", reason: "Cited a viral forum post as evidence (E11) — demoted to neutral weighting by the judge." },
    ],
  },

  /* ---- 05 · verdict (aggregation-first judge, gpt-5.6-sol, temp-0) ---- */
  verdict: {
    recommendation:
      "Don't blanket it. Run a two-week targeted pilot: Fri/Sat close at midnight (not 2 AM), replace the 20% blanket promo with a 10pm–midnight student punch card, and spend the remaining budget on the morning family experience that built the loyalty.",
    confidence: 0.72,
    split: { for: 26, against: 14, shifted: 10 },
    tallies: { pro_extension: 18, staffing_burn: 17, margin_skeptics: 15, shifted_neutral: 10 },
    judge_model: "gpt-5.6-sol",
    round2_alignment: 0.91,
    segment_impacts: [
      { segment: "S1", name: "Weekend Brunch Families",  impact: "+", note: "Saved promo budget funds the Sunday experience they're loyal to." },
      { segment: "S2", name: "Late-Night Study Crowd",   impact: "+", note: "Gets a real late window (10pm–12) with a punch card to anchor it." },
      { segment: "S3", name: "Early Quiet Seekers",      impact: "o", note: "Mornings untouched; watch evening noise spillover during the pilot." },
      { segment: "S4", name: "Coffee-First Commuters",   impact: "=", note: "Indifferent to evening changes; protect their 90-second morning instead." },
      { segment: "S5", name: "Consistency Loyalists",    impact: "−", note: "Midnight close still stresses the rota — pilot needs two-deep staffing." },
      { segment: "S6", name: "Deal-Driven Occasionals",  impact: "−", note: "Loses the blanket promo by design; that churn is intentional." },
    ],
    top_objections: [
      "Midnight still extends the rota while turnover is unresolved (17 agents).",
      "Two competitors already own the 12–2 AM window; a midnight close is a partial concession.",
      "Promo removal will visibly dent Deal-Driven traffic for ~4 weeks.",
    ],
    conditions: [
      "Two-deep staffing on pilot nights, or the pilot is off.",
      "Track punch-card redemptions vs. promo baseline for 14 days.",
      "Kill switch: if morning complaints rise, revert to 11 PM immediately.",
    ],
  },

  /* ---- 06 · the loop (simulated market, seeded truth, belief rewrite) ---- */
  loop: {
    seed: 1337,
    seed2: 8821,
    iterations: [
      { n: 1, proposal: "2 AM + blanket promo (naive)",        predicted: "+31% wknd rev", actual: "+6% wknd rev",  error: 0.25, belief: "promo reaches non-customer deals", kept: false },
      { n: 2, proposal: "Midnight close, no promo",            predicted: "+9% wknd rev",  actual: "+13% wknd rev", error: 0.08, belief: "study crowd caps at midnight", kept: true },
      { n: 3, proposal: "Midnight + student punch card",       predicted: "+15%",          actual: "+19%",          error: 0.05, belief: "punch card ≥ blanket promo", kept: true },
      { n: 4, proposal: "Midnight + card + morning budget",    predicted: "+22%",          actual: "+24%",          error: 0.03, belief: "morning spend protects loyalty", kept: true },
      { n: 5, proposal: "Fri-only midnight (test context)",    predicted: "+23%",          actual: "+21%",          error: 0.04, belief: "hold on 2 nights", kept: false },
    ],
    chart: {
      points: [
        { i: 1, train: 0.25, test: 0.41, regret: 0.19 },
        { i: 2, train: 0.08, test: 0.22, regret: 0.12 },
        { i: 3, train: 0.05, test: 0.17, regret: 0.08 },
        { i: 4, train: 0.03, test: 0.14, regret: 0.06 },
        { i: 5, train: 0.04, test: 0.15, regret: 0.05 },
      ],
      baseline: 0.19,
    },
    iterations2: [
      { n: 1, proposal: "reroll seed 8821: naive",   predicted: "+28%", actual: "+3%",  error: 0.24, kept: false },
      { n: 2, proposal: "midnight + card",           predicted: "+14%", actual: "+11%", error: 0.06, kept: true },
      { n: 3, proposal: "card + morning budget",     predicted: "+20%", actual: "+18%", error: 0.04, kept: true },
      { n: 4, proposal: "Fri-only midnight",         predicted: "+19%", actual: "+20%", error: 0.03, kept: true },
    ],
    chart2: {
      points: [
        { i: 1, train: 0.24, test: 0.39, regret: 0.21 },
        { i: 2, train: 0.06, test: 0.19, regret: 0.10 },
        { i: 3, train: 0.04, test: 0.16, regret: 0.07 },
        { i: 4, train: 0.03, test: 0.12, regret: 0.04 },
      ],
      baseline: 0.21,
    },
  },

  /* ---- chat (per-agent, behind paywall) ---- */
  chat_samples: [
    "Honestly? I said what I said in debate — ask me about the punch card idea though.",
    "I'm one review, not a spreadsheet. But from where I sit {seg_speak}.",
    "My whole take comes down to the {evidence} card. Everything else follows.",
    "I'd trust the 2 AM idea if someone showed me the staffing math. Nobody has.",
  ],
};

/* personas: bind the IIFE to segments (kept simple/explicit) */
(function () {
  const D = window.CS_SESSION_DEMO;
  const names = ["Maya","Jordan","Priya","Ethan","Sofia","Marcus","Ava","Tyler","Nadia","Leo","Grace","Omar","Riley","Chloe","Devon","Hana","Cole","Ines","Theo","Lena","Micah","Rosa","Bryan","Yuki","Felix","Amara","Jonah","Kira","Silas","Nora","Andre","Tessa","Owen","Zara","Caleb","Mira","Dante","Elsa","Gus","Vera","Kofi","Lucia","Reid","Paloma","Hank","Iris","Sean","Bianca","Tobias","Wren"];
  const quotes = {
    S1: ["Brunch is the one place all four of us agree on.","They hold my stroller-wrecked table without a sigh.","Kids' pancakes arrive before the meltdown. That's the product.","Sunday coffee for them, Saturday cartoons for me.","Speed at noon is why we come back.","Our waitress knows the kids by name.","We tried the fancy bakery — this is still the one.","I plan my whole week around that 11am table.","No line, high chairs, decent decaf. Sold."],
    S2: ["Midterms week I'm here until they sweep me out.","Every outlet occupied means I'm staying home.","The 10pm lull is prime time — nobody else gets it.","Library closes, this opens. Simple math.","A later close would be my entire social life.","The refill policy is the unsung hero.","Late + quiet + wifi is a rare triple.","I'd study here past 11 if they let me."],
    S3: ["I come for the silence before 9am. Guard it.","Any crowd-pleasing expansion scares me.","This is the only cafe without morning chaos.","Loud new regulars would ruin my first hour.","My journal page is written here daily. Don't move my chair.","I chose this over three noisier spots.","Early light, no espresso-machine clatter — that's rare.","The calm is the product. Everything else is garnish."],
    S4: ["Order, sip, gone — 90 seconds flat.","Consistency at 7:45am is the whole review.","I don't care what they do at night.","My latte tastes identical every single day.","Drive-past speed matters more than any promo.","Two sugars, no small talk, both perfect.","If the morning line slows, I'm gone by Friday.","Their espresso never misses. That's all I ask."],
    S5: ["The barista learns your name by week two — magic.","Turnover lately shows in the foam quality.","Don't stretch the staff thin for novelty hours.","I stayed through three ownerships because of the people.","A tired barista is a visible barista, sadly.","Recognition is why I tip 30%.","My usual tastes different this month. Coincidence?","Consistent beats trendy, every time.","They fixed my order before I complained. Loyalty earned."],
    S6: ["Show me 20% off and I'll show up — loyalty optional.","I order by which app screams loudest.","The $19 brunch stung; a promo makes it digestible.","I'd add a late dessert order if a discount waved.","Deals decide my Sunday, not vibes.","I compare three delivery apps before tapping.","Coupons are how I find new spots.","Full price, I hesitate; promo, I tap."],
  };
  const stance = { S1: "against", S2: "for", S3: "strong_against", S4: "neutral", S5: "against", S6: "promo_only" };
  const out = [];
  let ni = 0;
  for (const s of D.segments) {
    for (let i = 0; i < s.size; i++) {
      out.push({
        id: "P" + String(out.length + 1).padStart(2, "0"),
        name: names[ni++ % names.length],
        segment: s.id,
        quote: quotes[s.id][i % quotes[s.id].length],
        stance: stance[s.id],
      });
    }
  }
  D.personas = out;
})();

/* chat reply generator (mock — the real one runs on the Groq lane) */
window.CSMock = {
  chat(session, personaId, userText) {
    const p = session && session.personas.find((x) => x.id === personaId);
    if (!p) return "(that agent isn't in this session)";
    const seg = (session.segments.find((s) => s.id === p.segment) || {}).name || "my crowd";
    const evs = (session.evidence || []);
    const ev = evs[Math.abs(personaId.length * personaId.charCodeAt(1)) % evs.length];
    const lines = [
      `You're talking to ${p.name} — ${seg}. "${p.quote}"`,
      `On your point: I'd put it this way — ${p.quote.toLowerCase()}`,
      `I speak for ${seg.toLowerCase()} here, and my one card is «${ev ? ev.claim : "the reviews I came from"}». ${userText ? "Your question doesn't change that much." : ""}`,
    ];
    return lines[personaId.charCodeAt(1) % lines.length];
  },
};