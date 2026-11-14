// Splitback live page. Read-only: bundled run data plus view calls to the contract.
(() => {
  "use strict";

  const REPO = "https://github.com/dreybuilds/splitback";
  const POLL_MS = 15000;
  const $ = (sel) => document.querySelector(sel);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- small helpers ----------
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
    return el;
  };
  const svg = (tag, attrs) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  };
  const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
  const ceilDiv = (c, k) => (k > 0n ? (c + k - 1n) / k : 0n);
  const usd = (v) => "$" + (Number(big(v)) / 1e6).toFixed(4);
  const usd2 = (v) => "$" + (Number(big(v)) / 1e6).toFixed(2);
  const plain = (v) => String(Number((Number(big(v)) / 1e6).toFixed(4)));
  const label = (id) => String(id || "").split(".")[0];
  const who = (id) => h("span", { title: id || "" }, label(id) || "none");
  const statusOf = (s) => (typeof s === "string" ? s : (s && Object.keys(s)[0]) || "Unknown");

  const state = { cfg: null, run: null, runSource: null, live: null, liveOk: false, liveTried: false, lastKey: "" };

  // ---------- data ----------
  const getJSON = async (url) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(url + " -> " + res.status);
    return res.json();
  };

  const view = async (method, args) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(state.cfg.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "query",
          params: {
            request_type: "call_function", finality: "final", account_id: state.cfg.contract,
            method_name: method, args_base64: btoa(JSON.stringify(args)),
          },
        }),
      });
      const body = await res.json();
      if (!body.result || !body.result.result) throw new Error(method + " failed");
      return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result)));
    } finally {
      clearTimeout(timer);
    }
  };

  const poll = async () => {
    if (!document.hidden) {
      try {
        const [stats, entries, config] = await Promise.all([
          view("get_stats", {}),
          view("get_entries", { from_index: 0, limit: 100 }),
          state.live?.config ?? view("get_config", {}),
        ]);
        state.live = { stats, entries, config };
        state.liveOk = true;
      } catch {
        state.liveOk = false;
      }
      state.liveTried = true;
      renderDynamic();
    }
    setTimeout(poll, POLL_MS);
  };

  // Live data wins over the bundled run for entries and stats.
  const entries = () => (state.liveOk && state.live.entries) || state.run?.entries || [];
  const stats = () => (state.liveOk && state.live.stats) || state.run?.stats || null;

  // ---------- header ----------
  const renderHeader = () => {
    const contract = state.cfg?.contract || state.run?.contract || "";
    $("#net").textContent = state.cfg?.network || state.run?.network || "unknown";
    $("#contract").textContent = contract || "not configured";
    $("#copy").hidden = !contract;
    const dot = $("#dot");
    let text;
    if (state.liveOk) { dot.className = "dot live"; text = "Live chain data"; }
    else if (!state.cfg?.rpcUrl) { dot.className = "dot bundled"; text = "Bundled run data (no deployment configured)"; }
    else if (!state.liveTried) { dot.className = "dot loading"; text = "Loading chain data"; }
    else { dot.className = "dot bundled"; text = "Bundled run data (RPC not reachable)"; }
    $("#status").textContent = text;
  };

  // ---------- mechanism ----------
  const renderMechanism = () => {
    const cNum = Math.min(100000, Math.max(0.000001, Number($("#mc").value) || 12));
    const C = BigInt(Math.round(cNum * 1e6));
    const kNum = Number($("#mk").value);
    const k = BigInt(kNum);
    $("#mkOut").textContent = kNum;

    const share = (j) => ceilDiv(C, BigInt(j));
    const chain = $("#mChain");
    chain.replaceChildren();
    for (let j = 1; j <= kNum; j++) {
      if (j > 1) chain.append(h("span", { class: "arrow" }, " → "));
      chain.append(h("span", { class: j === kNum ? "last" : null }, plain(share(j))));
    }

    const net = share(kNum);
    const back = kNum > 1 ? share(kNum - 1) - net : null;
    const rows = [
      [kNum === 1 ? "The first buyer paid" : `Buyer ${kNum} paid`, plain(net)],
      [kNum > 1 ? `Each of the ${kNum - 1} earlier holder${kNum > 2 ? "s" : ""} got back` : "Earlier holders got back", back == null ? "none yet" : plain(back)],
      ["Every holder has paid net", plain(net)],
      ["The next buyer would pay", plain(ceilDiv(C, k + 1n))],
      ["The provider earned", plain(C)],
    ];
    $("#mRead").replaceChildren(h("dl", null, rows.map(([a, b]) => [h("dt", null, a), h("dd", null, b)])));

    const bars = $("#mBars");
    bars.replaceChildren();
    for (let j = 1; j <= kNum; j++) {
      const first = Number(share(j)) / Number(C);
      const now = Number(net) / Number(share(j));
      bars.append(h("div", { class: "bar", style: `height:${Math.max(2, first * 100)}%`, title: `Holder ${j}: paid ${plain(share(j))} at first, ${plain(net)} net` },
        h("i", { style: `height:${now * 100}%` })));
    }
  };

  // ---------- headline numbers ----------
  const renderTiles = () => {
    const run = state.run;
    const st = stats();
    const src = state.liveOk ? "live from the contract" : "from the run";
    const tile = (name, value, source, key) =>
      tilt(h("div", { class: "tile" + (key ? " key" : "") }, h("div", { class: "label" }, name), h("div", { class: "value" }, value), h("div", { class: "src" }, source)));
    const out = [];
    if (run) {
      out.push(tile("If every agent had computed alone", usd2(run.cost_if_every_agent_computed_alone_micro_usdc), "from the run"));
      out.push(tile("Paid through Splitback", usd2(run.cost_actually_paid_micro_usdc), "from the run"));
      out.push(tile("Saved", run.saving_percent + "%", "from the run", true));
    }
    if (st) {
      out.push(tile("Joins", String(st.joins), src));
      out.push(tile("Entries", String(st.entries), src));
      out.push(tile("Slashed", usd(st.slashed), src));
    }
    $("#tiles").replaceChildren(...(out.length ? out : [h("p", { class: "panel empty" }, "No run data could be loaded.")]));
    if (run) {
      const a = run.agents || {};
      $("#numNote").textContent = `${a.buyers} buyers, ${a.sellers} sellers and ${a.verifiers} verifiers on ${run.network}. ${a.votes_needed} verifier votes decide a challenge.`;
    }
  };

  // ---------- entries ----------
  const stepChart = (cost, holders) => {
    const W = 240, H = 64, n = Math.max(1, holders);
    const c = Number(cost) || 1;
    const y = (k) => H - 4 - (Number(ceilDiv(big(cost), BigInt(k))) / c) * (H - 10);
    const w = W / n;
    let d = `M0,${y(1).toFixed(1)}`;
    for (let k = 1; k <= n; k++) d += ` H${(k * w).toFixed(1)}` + (k < n ? ` V${y(k + 1).toFixed(1)}` : "");
    const el = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img" });
    const t = svg("title");
    t.textContent = `Price per holder fell from ${usd(cost)} to ${usd(ceilDiv(big(cost), BigInt(n)))} over ${n} holder${n > 1 ? "s" : ""}`;
    el.append(t, svg("path", { class: "area", d: `${d} V${H} H0 Z` }), svg("path", { class: "step", d }),
      svg("circle", { cx: (W - 3).toFixed(1), cy: y(n).toFixed(1), r: 3 }));
    return el;
  };

  const renderEntries = () => {
    const list = entries();
    const threshold = state.live?.config?.threshold ?? state.run?.agents?.votes_needed;
    $("#entNote").textContent = state.liveOk
      ? "Read from the contract just now. Each chart is the price per holder as holders joined."
      : "From the bundled run. Each chart is the price per holder as holders joined.";
    const cards = list.map((e) => {
      const status = statusOf(e.status);
      const cost = big(e.cost);
      const holders = Number(e.holders) || 0;
      const net = e.current_share ?? e.each_paid_net ?? ceilDiv(cost, BigInt(Math.max(1, holders)));
      const next = status === "Open" ? usd(e.next_price ?? ceilDiv(cost, BigInt(holders + 1))) : "closed to buyers";
      const bond = e.bond != null ? usd(e.bond) : status === "Voided" ? "slashed" : status === "Closed" ? "returned" : usd(cost * 2n);
      const kv = [
        ["Publisher", who(e.publisher)], ["Cost", usd(cost)],
        ["Holders", String(holders)], ["Each paid net", usd(net)],
        ["Next buyer pays", next], ["Bond", bond],
      ];
      const votes = status === "Challenged" && e.votes_uphold
        ? h("p", { class: "votes" }, `Challenged by ${label(e.challenger)}. Votes to uphold: ${e.votes_uphold.length}, to reject: ${e.votes_reject.length}. ${threshold} decide.`)
        : null;
      return tilt(h("article", { class: "card " + status },
        h("div", { class: "card-head" }, h("span", { class: "id" }, "entry " + e.id), h("span", { class: "badge " + status }, status)),
        h("div", { class: "spec" }, e.spec || ""),
        stepChart(cost, holders),
        h("dl", { class: "kv" }, kv.map(([a, b]) => h("div", null, h("dt", null, a), h("dd", null, b)))),
        votes));
    });
    $("#entries").replaceChildren(...(cards.length ? cards : [h("p", { class: "panel empty" }, "No entries to show.")]));
  };

  // ---------- rounds ----------
  const renderRounds = () => {
    const events = state.run?.events || [];
    const byRound = new Map();
    for (const ev of events) {
      if (!byRound.has(ev.round)) byRound.set(ev.round, []);
      byRound.get(ev.round).push(ev.text);
    }
    const blocks = [...byRound.entries()].map(([round, texts]) =>
      h("div", { class: "round" },
        h("h3", null, "Round " + round, round === 0 ? h("small", null, " · sellers publish") : null),
        h("ol", null, texts.map((t) => {
          const cls = /UPHELD|slashed|wrong result|found it wrong/.test(t) ? "bad" : /challenge/i.test(t) ? "warn" : /^end of round/.test(t) ? "sum" : null;
          return h("li", { class: cls }, t.replace(/\s+/g, " "));
        }))));
    $("#rounds").replaceChildren(...(blocks.length ? blocks : [h("p", { class: "panel empty" }, "No round events in the run data.")]));
  };

  // ---------- receipts ----------
  const renderReceipts = () => {
    const run = state.run;
    const rows = (run?.receipts || []).map((r) => {
      const tx = r.tx && run.explorer_tx_url
        ? h("a", { href: run.explorer_tx_url + encodeURIComponent(r.tx), target: "_blank", rel: "noopener", title: r.tx }, String(r.tx).slice(0, 8) + "…")
        : h("span", { class: "mono", title: r.tx || "" }, r.tx ? String(r.tx).slice(0, 8) + "…" : "none");
      return h("tr", null,
        h("td", { class: "num" }, String(r.round)),
        h("td", null, who(r.buyer)),
        h("td", { class: "spec-cell" }, `${r.bought} (entry ${r.entry})`),
        h("td", null, who(r.from)),
        h("td", { class: "num" }, usd(r.price_micro_usdc)),
        h("td", { class: "num" }, usd(r.alone_would_cost_micro_usdc)),
        h("td", { class: r.hash_check_passed ? "ok" : "no" }, r.hash_check_passed ? "passed" : "FAILED"),
        h("td", { class: "wrap" }, r.audit || ""),
        h("td", null, tx));
    });
    $("#receipts").replaceChildren(...rows);
    $("#recNote").textContent = rows.length
      ? `${rows.length} receipts, one per purchase.` + (run.explorer_tx_url ? " Each links to its transaction." : " This run was local, so there are no explorer links.")
      : "No receipts in the run data.";
  };

  // ---------- the bad actor ----------
  const renderBad = () => {
    const run = state.run;
    const box = $("#bad");
    if (!run) { box.replaceChildren(h("p", { class: "empty" }, "No run data could be loaded.")); return; }
    const texts = (run.events || []).map((e) => e.text);
    const pub = texts.map((t) => t.match(/^(\S+) published entry (\d+) "([^"]*)".*\(wrong result\)/)).find(Boolean);
    const caught = texts.map((t) => t.match(/^(\S+) recomputed entry (\d+), found it wrong, and challenged it/)).find(Boolean);
    const entryId = pub?.[2] ?? caught?.[2];
    const vote = texts.map((t) => t.match(/^verifiers voted on entry (\d+) \(([^)]*)\): (.*)$/)).find((m) => m && m[1] === entryId);
    const sb = run.poisoner_seller_5_balance, cb = run.challenger_balance;
    const move = (b) => {
      const diff = big(b.end) - big(b.start);
      return h("p", { class: "mono" }, `${usd(b.start)} → ${usd(b.end)} `,
        h("span", { class: diff < 0n ? "down" : "up" }, `(${diff < 0n ? "−" : "+"}${usd(diff < 0n ? -diff : diff)})`));
    };
    const block = (title, ...kids) => h("div", null, h("h3", null, title), ...kids);
    const parts = [
      block("Who published it", h("p", null, pub ? `${pub[1]} published entry ${pub[2]} with a wrong result.` : "The run records no wrong result."), pub ? h("p", { class: "mono" }, pub[3]) : null),
      block("Who caught it", h("p", null, caught ? `${caught[1]} recomputed the result, found it wrong and challenged it.` : run.challenger ? `${run.challenger} challenged it.` : "Nobody challenged it.")),
      vote ? block("How the verifiers voted", h("ul", null, vote[2].split(", ").map((v) => h("li", { class: "mono" }, v))), h("p", null, vote[3].replace(/^challenge /, "Challenge ") + ".")) : null,
      sb ? block("The seller's balance", move(sb)) : null,
      cb ? block(`${run.challenger || "The challenger"}'s balance`, move(cb), h("p", { class: "empty" }, "After its own purchases.")) : null,
      run.verifier_earnings ? block("What each verifier earned", h("ul", null, Object.entries(run.verifier_earnings).map(([n, v]) => h("li", { class: "mono" }, `${n} ${usd(v)}`)))) : null,
    ];
    const threshold = state.live?.config?.threshold;
    if (state.liveOk) {
      for (const e of state.live.entries.filter((x) => statusOf(x.status) === "Challenged")) {
        parts.push(h("p", { class: "live" }, `Live: entry ${e.id} is under challenge. Votes to uphold: ${e.votes_uphold.length}, to reject: ${e.votes_reject.length}. ${threshold} decide.`));
      }
    }
    box.replaceChildren(...parts.filter(Boolean));
  };

  // ---------- footer, problems ----------
  const renderFooter = () => {
    const contract = state.cfg?.contract || state.run?.contract;
    const network = state.cfg?.network || state.run?.network;
    const explorer = network === "testnet" ? "https://testnet.nearblocks.io/address/" : network === "mainnet" ? "https://nearblocks.io/address/" : null;
    $("#links").replaceChildren(
      h("a", { href: REPO, target: "_blank", rel: "noopener" }, "Repository"),
      h("a", { href: REPO + "/blob/main/RULES.md", target: "_blank", rel: "noopener" }, "RULES.md"),
      contract && explorer ? h("a", { href: explorer + encodeURIComponent(contract), target: "_blank", rel: "noopener" }, "Contract on the explorer") : null);
  };

  const renderProblems = () => {
    const box = $("#problems");
    const problems = state.run?.problems || [];
    const notes = [];
    if (state.run && state.cfg?.contract && state.run.contract && state.cfg.contract !== state.run.contract) {
      notes.push(`The run history below is from ${state.run.contract}, not the contract being read live.`);
    }
    box.hidden = !problems.length && !notes.length;
    box.replaceChildren(
      problems.length ? h("h2", null, "The run reported problems") : null,
      problems.length ? h("ul", null, problems.map((p) => h("li", null, typeof p === "string" ? p : JSON.stringify(p)))) : null,
      ...notes.map((n) => h("p", null, n)));
  };

  const renderDynamic = () => {
    renderHeader();
    const key = JSON.stringify([state.liveOk, state.liveOk ? state.live.stats : null, state.liveOk ? state.live.entries : null]);
    if (key === state.lastKey) return;
    state.lastKey = key;
    renderTiles();
    renderEntries();
    renderBad();
    buildEquations();
  };

  // ---------- depth: card tilt ----------
  function tilt(el) {
    el.classList.add("tilt");
    el.addEventListener("pointermove", (ev) => {
      if (reduced.matches || ev.pointerType === "touch") return;
      const r = el.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width - 0.5, y = (ev.clientY - r.top) / r.height - 0.5;
      el.style.setProperty("--ry", (x * 7).toFixed(2) + "deg");
      el.style.setProperty("--rx", (-y * 7).toFixed(2) + "deg");
    });
    el.addEventListener("pointerleave", () => { el.style.removeProperty("--rx"); el.style.removeProperty("--ry"); });
    return el;
  }

  // ---------- depth: equation streams ----------
  const BASE_EQ = [
    "share(k) = ⌈C / k⌉", "price(k+1) = ⌈C / (k+1)⌉", "rebate = paid − ⌈C / k⌉ − claimed",
    "Σ ⌈C / j⌉ , j = 2..k", "k · ⌈C / k⌉ ≥ C", "bond = 2C", "stake = ⌈C / 10⌉", "12 → 6 → 4",
  ];
  const DEPTH = { 1: { line: 30, speed: 12, every: 120 }, 2: { line: 44, speed: 24, every: 230 }, 3: { line: 64, speed: 42, every: 380 } };
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function buildEquations() {
    const liveEq = entries().filter((e) => Number(e.holders) > 0).map((e) => {
      const c = big(e.cost), k = BigInt(e.holders);
      return `⌈${c} / ${k}⌉ = ${ceilDiv(c, k)}`;
    });
    const pool = [...BASE_EQ, ...liveEq];
    const rand = rng(20261114);
    document.querySelectorAll(".layer.eq").forEach((layer) => {
      const d = DEPTH[layer.dataset.depth];
      const height = window.innerHeight + Number(layer.dataset.range) + 40;
      const lines = Math.ceil(height / d.line) + 2;
      const count = Math.max(2, Math.round(window.innerWidth / d.every));
      const cols = [];
      for (let i = 0; i < count; i++) {
        const inner = h("div", { class: "col-inner", style: `animation-duration:${Math.round((lines * d.line) / (d.speed * (0.8 + rand() * 0.5)))}s` });
        const start = Math.floor(rand() * pool.length);
        for (let copy = 0; copy < 2; copy++) {
          for (let n = 0; n < lines; n++) inner.append(h("span", null, pool[(start + n * 3 + i) % pool.length]));
        }
        const left = ((i + 0.15 + rand() * 0.5) / count) * 100;
        cols.push(h("div", { class: "col " + (rand() < 0.5 ? "up" : "down"), style: `left:${left.toFixed(1)}%` }, inner));
      }
      layer.replaceChildren(...cols);
    });
  }

  // ---------- depth: parallax on scroll and pointer ----------
  const layers = [...document.querySelectorAll(".layer")];
  layers.forEach((l) => l.style.setProperty("--range", l.dataset.range + "px"));
  let px = 0, py = 0, queued = false;
  const frame = () => {
    queued = false;
    if (reduced.matches) return;
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, window.scrollY / max));
    for (const l of layers) {
      const p = Number(l.dataset.pointer);
      l.style.setProperty("--sy", (-progress * Number(l.dataset.range)).toFixed(1) + "px");
      l.style.setProperty("--px", (-px * p).toFixed(1) + "px");
      l.style.setProperty("--py", (-py * p * 0.6).toFixed(1) + "px");
    }
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(frame); } };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("pointermove", (ev) => {
    if (ev.pointerType === "touch") return;
    px = ev.clientX / window.innerWidth - 0.5;
    py = ev.clientY / window.innerHeight - 0.5;
    queue();
  }, { passive: true });
  let lastW = window.innerWidth, resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; buildEquations(); } queue(); }, 200);
  });

  // ---------- theme, copy, controls ----------
  const setTheme = (t) => {
    document.documentElement.dataset.theme = t;
    $("#theme").textContent = t === "light" ? "Dark theme" : "Light theme";
  };
  let saved = null;
  try { saved = localStorage.getItem("splitback-theme"); } catch { /* storage blocked */ }
  setTheme(saved === "light" ? "light" : "dark");
  $("#theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    setTheme(next);
    try { localStorage.setItem("splitback-theme", next); } catch { /* storage blocked */ }
  });
  $("#copy").addEventListener("click", async () => {
    const btn = $("#copy");
    try { await navigator.clipboard.writeText($("#contract").textContent); btn.textContent = "Copied"; }
    catch { btn.textContent = "Select and copy"; }
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  });
  const bump = (by) => { const el = $("#mk"); el.value = Math.min(20, Math.max(1, Number(el.value) + by)); renderMechanism(); };
  $("#mk").addEventListener("input", renderMechanism);
  $("#mc").addEventListener("input", renderMechanism);
  $("#mkDown").addEventListener("click", () => bump(-1));
  $("#mkUp").addEventListener("click", () => bump(1));

  // ---------- start ----------
  (async () => {
    renderMechanism();
    buildEquations();
    const q = new URLSearchParams(location.search);
    let cfg = await getJSON("deployment.json").catch(() => null);
    if (q.get("rpc") || q.get("contract")) {
      cfg = { ...(cfg || {}), rpcUrl: q.get("rpc") || cfg?.rpcUrl, contract: q.get("contract") || cfg?.contract };
      if (q.get("rpc")) cfg.network = q.get("network") || "custom";
    }
    state.cfg = cfg;
    state.run = await getJSON("data/run.json").catch(() => null);
    state.runSource = state.run ? "run.json" : "run.sample.json";
    if (!state.run) state.run = await getJSON("data/run.sample.json").catch(() => null);
    renderProblems();
    renderRounds();
    renderReceipts();
    renderFooter();
    renderDynamic();
    if (cfg?.rpcUrl && cfg?.contract) poll();
    else { state.liveTried = true; renderHeader(); }
  })();
})();
