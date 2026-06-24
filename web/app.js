'use strict';

const COLORS = ['#7c5cff', '#18e0d8', '#ff5cc8', '#35e08b', '#ffc24b', '#5b9bff', '#ff8d5c'];
const state = { view: 'overview', projectId: null, overview: null, refreshTimer: null };

// ---- helpers ---------------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
};

function fmtNum(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtCost(n) {
  n = n || 0;
  if (n >= 1000) return '$' + (n / 1000).toFixed(2) + 'k';
  if (n < 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(2);
}
function ago(ms) {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm ago';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h ago';
  return Math.floor(d / 86400e3) + 'd ago';
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}

// ---- SVG charts ------------------------------------------------------------
function areaChart(dailyMap, { height = 150 } = {}) {
  const days = Object.keys(dailyMap).sort();
  if (days.length === 0) return el('div', { class: 'empty' }, 'No activity yet');
  // keep last 30 days
  const slice = days.slice(-30);
  const vals = slice.map((d) => dailyMap[d]);
  const max = Math.max(...vals, 1);
  const W = 600, H = height, pad = 8;
  const stepX = slice.length > 1 ? (W - pad * 2) / (slice.length - 1) : 0;
  const y = (v) => H - pad - (v / max) * (H - pad * 2 - 14);
  const x = (i) => pad + i * stepX;
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`);
  const linePath = 'M' + pts.join(' L');
  const areaPath = `M${x(0)},${H - pad} L` + pts.join(' L') + ` L${x(vals.length - 1)},${H - pad} Z`;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = `
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#7c5cff" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="#7c5cff" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#18e0d8"/>
        <stop offset="100%" stop-color="#7c5cff"/>
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#areaGrad)"/>
    <path d="${linePath}" fill="none" stroke="url(#lineGrad)" stroke-width="2.5"
      stroke-linejoin="round" stroke-linecap="round"
      style="filter: drop-shadow(0 0 6px rgba(124,92,255,.5))"/>
    ${vals.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="${i === vals.length - 1 ? 4 : 0}" fill="#18e0d8"/>`).join('')}
  `;
  const wrap = el('div', { class: 'chart-wrap' });
  wrap.append(svg);
  const labels = el('div', { style: 'display:flex;justify-content:space-between;font-size:10px;color:var(--dim);margin-top:6px;' },
    el('span', {}, slice[0]?.slice(5)), el('span', {}, slice[slice.length - 1]?.slice(5)));
  wrap.append(labels);
  return wrap;
}

function donut(items, { size = 170 } = {}) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.style.maxWidth = size + 'px';
  const cx = size / 2, cy = size / 2, r = size / 2 - 14, sw = 22;
  const C = 2 * Math.PI * r;
  let offset = 0;
  let parts = '';
  items.forEach((it, idx) => {
    const frac = it.value / total;
    const len = frac * C;
    parts += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="${COLORS[idx % COLORS.length]}" stroke-width="${sw}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"
      style="filter: drop-shadow(0 0 4px ${COLORS[idx % COLORS.length]}88)"/>`;
    offset += len;
  });
  svg.innerHTML = parts +
    `<text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#e7ebff" font-size="20" font-weight="800">${fmtNum(total)}</text>
     <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="#8b93b8" font-size="10">tokens</text>`;
  return svg;
}

// ---- KPI card --------------------------------------------------------------
function kpi(label, icon, value, sub, cls = '') {
  return el('div', { class: 'card kpi fade-in' },
    el('div', { class: 'kpi-label' }, el('span', { class: 'kpi-icon' }, icon), label),
    el('div', { class: `kpi-value ${cls}` }, value),
    sub ? el('div', { class: 'kpi-sub' }, sub) : null);
}

// ---- views -----------------------------------------------------------------
function planName(plan) {
  if (!plan || plan.metered) return 'API (metered)';
  const map = { max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise' };
  let n = map[plan.type] || plan.type;
  if (plan.tier && /20x/.test(plan.tier)) n += ' 20×';
  else if (plan.tier && /5x/.test(plan.tier)) n += ' 5×';
  return n;
}

function renderOverview(data) {
  const v = $('#view');
  v.innerHTML = '';
  $('#crumb').textContent = 'Overview';
  const t = data.totals;
  const plan = data.plan || { metered: true, type: 'api' };
  const metered = plan.metered;

  if (!metered) {
    v.append(el('div', { class: 'card fade-in', style: 'margin-bottom:18px;border-color:rgba(255,194,75,.3)' },
      el('div', { style: 'display:flex;gap:12px;align-items:flex-start' },
        el('span', { style: 'font-size:20px' }, '💡'),
        el('div', { style: 'font-size:13px;color:var(--muted);line-height:1.6' },
          el('b', { style: 'color:var(--text)' }, `You're on ${planName(plan)} — a flat-fee subscription.`),
          ' The "API-Equiv. Value" below is what your token usage ',
          el('i', {}, 'would'), ' cost on the metered API. It is ',
          el('b', { style: 'color:var(--warn)' }, 'not money charged to you'),
          '. Your real cost is your monthly subscription fee; you\'re limited by rate limits, not dollars.'))));
  }

  const kpis = el('div', { class: 'kpi-grid' },
    kpi(metered ? 'Total Spend' : 'API-Equiv. Value', '💸', fmtCost(t.cost),
      metered ? `${data.projects.length} applications` : `${planName(plan)} · flat fee`, 'pink'),
    kpi('Billable Tokens', '🔢', fmtNum(t.billableTokens), `${fmtNum(t.tokens.cacheRead)} cache reads`, 'neon'),
    kpi('Sessions', '🗂️', String(t.sessions), `${t.live} live now`),
    kpi('Live', '🟢', String(t.live), t.live ? 'sessions active' : 'all idle'),
    kpi('Tool Calls', '🛠️', fmtNum(t.toolCalls), 'across all apps'));
  v.append(kpis);

  // activity + model split
  const top = el('div', { class: 'row two' },
    el('div', { class: 'card fade-in' },
      el('div', { class: 'card-title' }, 'Token Activity', el('span', { class: 'muted' }, 'last 30 days')),
      areaChart(data.daily)),
    el('div', { class: 'card fade-in' },
      el('div', { class: 'card-title' }, 'Model Mix'),
      modelMix(data.models)));
  v.append(top);

  // applications table
  const maxCost = Math.max(...data.projects.map((p) => p.cost), 0.0001);
  const rows = data.projects.map((p) => el('div', { class: 'app-row', onclick: () => navProject(p.id) },
    el('div', { class: 'app-name' },
      el('span', {}, p.name),
      p.liveCount ? el('span', { class: 'chip live' }, el('span', { class: 'chip-dot' }), 'live') : null),
    el('div', { class: 'app-bar' }, el('span', { style: `width:${Math.max(4, (p.cost / maxCost) * 100)}%` })),
    el('div', { class: 'app-meta' }, fmtCost(p.cost)),
    el('div', { class: 'app-meta' }, `${fmtNum(p.billableTokens)} tok`),
    el('div', { class: 'app-meta' }, ago(p.lastActivity))));
  const table = el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Applications', el('span', { class: 'muted' }, 'click to open')),
    el('div', { class: 'app-list' }, ...rows));
  v.append(table);
}

function modelMix(models) {
  if (!models.length) return el('div', { class: 'empty' }, 'No data');
  const items = models.map((m) => ({ name: m.label, value: m.tokens }));
  const wrap = el('div', { style: 'display:flex;gap:18px;align-items:center;flex-wrap:wrap;' });
  wrap.append(donut(items));
  const legend = el('div', { class: 'legend', style: 'flex:1;min-width:140px;' });
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  items.forEach((it, idx) => legend.append(
    el('div', { class: 'legend-item' },
      el('span', { class: 'legend-swatch', style: `background:${COLORS[idx % COLORS.length]}` }),
      el('span', { class: 'legend-name' }, it.name),
      el('span', { class: 'legend-val' }, `${((it.value / total) * 100).toFixed(0)}%`))));
  wrap.append(legend);
  return wrap;
}

function queryConsole(p) {
  const card = el('div', { class: 'card fade-in q-card' });
  const titleRow = el('div', { class: 'card-title' }, '💬 Ask this application',
    el('span', { class: 'muted' }, 'quick read-only run'));
  if (p.cwd) {
    titleRow.append(el('button', { class: 'btn ghost', style: 'margin-left:auto;padding:6px 12px;font-size:12px',
      onclick: () => openSessionChat(p.id, null, p.name, { write: true, intro: 'New writeable session in ' + p.cwd + ' — describe what to build.' }) },
      '✏️ Start session'));
  }
  card.append(titleRow);
  if (!p.cwd) {
    card.append(el('div', { class: 'empty' }, 'Add a local folder for this app to query it directly.'));
    return card;
  }
  const out = el('div', { class: 'q-out' });
  const ta = el('textarea', { class: 'q-input', rows: '2', placeholder: 'e.g. Where is the webhook signature verified? What would break if I changed X?' });
  const btn = el('button', { class: 'btn', onclick: () => fire() }, '▶ Run');
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) fire(); });
  function fire() {
    const prompt = ta.value.trim();
    if (!prompt) return;
    runAppQuery(p.id, prompt, out, btn);
  }
  card.append(el('div', { class: 'q-bar' }, ta, btn),
    el('div', { class: 'q-hint' }, 'Ctrl/⌘+Enter to run · uses your Max plan'), out);
  return card;
}

async function runAppQuery(projectId, prompt, out, btn) {
  out.innerHTML = '';
  const status = el('div', { class: 'q-status' }, '⏳ launching Claude in the repo…');
  const answer = el('div', { class: 'q-answer' });
  out.append(status, answer);
  let acc = '';
  btn.disabled = true; btn.textContent = '… running';
  try {
    const res = await fetch('/api/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectId, prompt }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      status.textContent = '✕ ' + (e.error || ('HTTP ' + res.status));
      btn.disabled = false; btn.textContent = '▶ Run'; return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'started') status.textContent = `🤖 ${(ev.model || 'Claude')} · exploring…`;
        else if (ev.type === 'tool') status.textContent = `🔧 ${ev.tool}…`;
        else if (ev.type === 'text') { acc += (acc ? '\n\n' : '') + ev.text; answer.textContent = acc; }
        else if (ev.type === 'stderr' || ev.type === 'error') status.textContent = '⚠ ' + ev.text;
        else if (ev.type === 'done') {
          status.textContent = ev.error ? '✕ failed'
            : `✓ done${ev.cost != null ? ` · API-equiv $${ev.cost.toFixed(4)}` : ''}${ev.durationMs ? ` · ${(ev.durationMs / 1000).toFixed(1)}s` : ''}`;
        }
      }
    }
  } catch (e) {
    status.textContent = '✕ ' + e.message;
  }
  btn.disabled = false; btn.textContent = '▶ Run';
}

// ---- account view ----------------------------------------------------------
function vbars(values, labels) {
  const max = Math.max(...values, 1);
  const wrap = el('div', { class: 'vbars' });
  values.forEach((v, i) => {
    wrap.append(el('div', { class: 'vbar-col', title: `${labels[i] ?? i}: ${fmtNum(v)}` },
      el('div', { class: 'vbar', style: `height:${Math.max(2, (v / max) * 100)}%` }),
      el('div', { class: 'vbar-lab' }, labels[i] ?? '')));
  });
  return wrap;
}
function hbars(items) {
  const max = Math.max(...items.map((i) => i.value), 1);
  const wrap = el('div', { class: 'hbars' });
  items.forEach((it) => wrap.append(el('div', { class: 'hbar-row' },
    el('div', { class: 'hbar-name' }, it.label),
    el('div', { class: 'hbar-track' }, el('span', { class: 'hbar-fill', style: `width:${Math.max(3, (it.value / max) * 100)}%` })),
    el('div', { class: 'hbar-val' }, fmtNum(it.value)))));
  return wrap;
}
function statChip(icon, label, val) {
  return el('div', { class: 'stat-chip' }, el('span', { class: 'sc-ico' }, icon),
    el('div', {}, el('div', { class: 'sc-val' }, fmtNum(val)), el('div', { class: 'sc-lab' }, label)));
}
function rangeCard(label, r, metered) {
  return el('div', { class: 'card fade-in' },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value', style: 'font-size:24px;margin:6px 0' }, fmtNum(r.tokens) + ' tok'),
    el('div', { class: 'kpi-sub' }, (metered ? '' : '≈ ') + fmtCost(r.cost)));
}

function gaugeRow(label, used, budget, fallbackPeak) {
  const cap = budget || fallbackPeak || 1;
  const pct = Math.min(100, Math.round((used / cap) * 100));
  const right = budget
    ? `${fmtNum(Math.max(0, budget - used))} left of ${fmtNum(budget)}`
    : `${fmtNum(used)}${fallbackPeak ? ` / peak ${fmtNum(fallbackPeak)}` : ''}`;
  const danger = budget && used >= budget;
  return el('div', { style: 'margin-bottom:15px' },
    el('div', { style: 'display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px' },
      el('span', {}, label), el('span', { class: 'muted', style: danger ? 'color:var(--bad)' : '' }, right)),
    el('div', { class: 'gauge' }, el('span', { class: 'gauge-fill', style: `width:${pct}%` })));
}

function heatColor(t) {
  if (t <= 0) return 'rgba(255,255,255,.04)';
  return `rgba(124,92,255,${(0.14 + t * 0.86).toFixed(2)})`;
}
function heatmapEl(matrix) {
  const max = Math.max(1, ...matrix.flat());
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const wrap = el('div', { class: 'heatmap' });
  const axis = el('div', { class: 'hm-row hm-axis' }, el('div', { class: 'hm-day' }, ''));
  for (let h = 0; h < 24; h++) axis.append(el('div', { class: 'hm-h' }, h % 3 === 0 ? String(h) : ''));
  wrap.append(axis);
  for (let d = 0; d < 7; d++) {
    const row = el('div', { class: 'hm-row' }, el('div', { class: 'hm-day' }, days[d]));
    for (let h = 0; h < 24; h++) {
      const v = matrix[d][h];
      row.append(el('div', { class: 'hm-cell', title: `${days[d]} ${h}:00 — ${fmtNum(v)} tok`, style: `background:${heatColor(v / max)}` }));
    }
    wrap.append(row);
  }
  return wrap;
}
function compositionBar(c) {
  const parts = [
    { label: 'Fresh input', v: c.input, color: '#5b9bff' },
    { label: 'Output', v: c.output, color: '#ff5cc8' },
    { label: 'Cache write', v: c.cacheCreation, color: '#ffc24b' },
    { label: 'Cache read', v: c.cacheRead, color: '#18e0d8' },
  ];
  const tot = parts.reduce((s, p) => s + p.v, 0) || 1;
  const bar = el('div', { class: 'stack-bar' });
  parts.forEach((p) => bar.append(el('div', { class: 'stack-seg', title: `${p.label}: ${fmtNum(p.v)} (${(p.v / tot * 100).toFixed(1)}%)`, style: `width:${(p.v / tot * 100)}%;background:${p.color}` })));
  const legend = el('div', { class: 'legend', style: 'margin-top:12px' },
    ...parts.map((p) => el('div', { class: 'legend-item' },
      el('span', { class: 'legend-swatch', style: `background:${p.color}` }),
      el('span', { class: 'legend-name' }, p.label),
      el('span', { class: 'legend-val' }, `${fmtNum(p.v)} · ${(p.v / tot * 100).toFixed(0)}%`))));
  return el('div', {}, bar, legend);
}
function cumulative(map) {
  const days = Object.keys(map).sort();
  let run = 0; const out = {};
  for (const d of days) { run += map[d]; out[d] = run; }
  return out;
}

async function renderAccount() {
  $('#crumb').textContent = 'Account';
  const v = $('#view');
  v.innerHTML = '<div class="empty"><div class="big">⏳</div>Loading…</div>';
  const a = await api('/api/account');
  v.innerHTML = '';
  const plan = a.plan || { metered: true };
  const metered = plan.metered;

  v.append(el('div', { class: 'kpi-grid' },
    kpi('Total Tokens', '🔢', fmtNum(a.totals.tokens), planName(plan), 'neon'),
    kpi(metered ? 'Total Spend' : 'API-Equiv. Value', '💸', fmtCost(a.totals.cost), metered ? null : 'not metered', 'pink'),
    kpi('Sessions', '🗂️', String(a.totals.sessions), a.totals.firstTs ? 'since ' + new Date(a.totals.firstTs).toLocaleDateString() : null),
    kpi('Active Days', '📅', String(a.totals.activeDays), a.streak ? `${a.streak}-day streak 🔥` : null),
    kpi('Tool Calls', '🛠️', fmtNum(a.totals.tools), null)));

  // rolling 5-hour window
  const w = a.window5h;
  const pct = w.peak ? Math.min(100, Math.round((w.tokens / w.peak) * 100)) : 0;
  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Rolling 5-Hour Window',
      el('span', { class: 'muted' }, plan.type === 'max' ? 'Claude Max paces usage in ~5h windows' : 'recent activity')),
    el('div', { style: 'display:flex;gap:28px;align-items:center;flex-wrap:wrap' },
      el('div', {},
        el('div', { class: 'kpi-value neon', style: 'font-size:34px' }, fmtNum(w.tokens)),
        el('div', { class: 'kpi-sub' }, `${w.messages} messages in the last 5h`)),
      el('div', { style: 'flex:1;min-width:220px' },
        el('div', { class: 'gauge' }, el('span', { class: 'gauge-fill', style: `width:${pct}%` })),
        el('div', { class: 'kpi-sub', style: 'margin-top:7px' }, `${pct}% of your busiest-ever 5h window (${fmtNum(w.peak)} tok)`)))));

  // usage remaining vs budgets
  const b = a.budgets || {};
  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Usage Remaining', el('span', { class: 'muted' }, 'vs your budgets')),
    gaugeRow('Today', a.ranges.today.tokens, b.day, null),
    gaugeRow('Rolling 5-hour window', a.window5h.tokens, b.window5h, a.window5h.peak),
    el('div', { class: 'kpi-sub', style: 'margin-top:4px' },
      b.day ? 'Budgets are your own pacing targets.'
        : 'Set token budgets in Settings to track remaining — Anthropic doesn\'t publish exact Max limits, so these are your own pacing targets.')));

  // time ranges
  v.append(el('div', { class: 'row', style: 'grid-template-columns:repeat(3,1fr)' },
    rangeCard('Last 24 hours', a.ranges.today, metered),
    rangeCard('Last 7 days', a.ranges.week, metered),
    rangeCard('Last 30 days', a.ranges.month, metered)));

  // token composition + cache efficiency
  const c = a.composition;
  const denom = c.input + c.cacheCreation + c.cacheRead;
  const cacheEff = denom ? c.cacheRead / denom : 0;
  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Token Composition & Cache Efficiency', el('span', { class: 'muted' }, 'where your tokens go')),
    el('div', { style: 'display:flex;gap:28px;align-items:center;flex-wrap:wrap' },
      el('div', {},
        el('div', { class: 'kpi-value neon', style: 'font-size:34px' }, (cacheEff * 100).toFixed(1) + '%'),
        el('div', { class: 'kpi-sub' }, 'input served from cache (~0.1× price)')),
      el('div', { style: 'flex:1;min-width:260px' }, compositionBar(c)))));

  // activity heatmap (day × hour)
  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Activity Heatmap', el('span', { class: 'muted' }, 'tokens by day × hour, local time')),
    heatmapEl(a.heatmap)));

  // hour + day-of-week + cumulative
  v.append(el('div', { class: 'row two' },
    el('div', { class: 'card fade-in' },
      el('div', { class: 'card-title' }, 'Activity by Hour'),
      vbars(a.hourly, a.hourly.map((_, i) => (i % 6 === 0 ? String(i) : '')))),
    el('div', { class: 'card fade-in' },
      el('div', { class: 'card-title' }, 'By Day of Week'),
      vbars(a.dow, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']))));

  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Cumulative Tokens', el('span', { class: 'muted' }, 'running total')),
    areaChart(cumulative(a.daily))));

  // top tools + lifetime actions
  const toolItems = a.tools.slice(0, 10).map((t) => ({ label: t.name, value: t.count }));
  v.append(el('div', { class: 'row two' },
    el('div', { class: 'card fade-in' },
      el('div', { class: 'card-title' }, 'Top Tools'),
      toolItems.length ? hbars(toolItems) : el('div', { class: 'empty' }, 'No tool usage yet')),
    el('div', { class: 'card fade-in' },
      el('div', { class: 'card-title' }, 'Lifetime Actions'),
      el('div', { class: 'stat-chips' },
        statChip('✏️', 'Edits', a.derived.edits),
        statChip('💻', 'Commands', a.derived.commands),
        statChip('🔎', 'Searches', a.derived.searches),
        statChip('📖', 'File Reads', a.derived.reads)))));
}

// ---- session chat modal --------------------------------------------------
function chatBubble(m) {
  const wrap = el('div', { class: 'chat-msg ' + (m.role === 'user' ? 'cb-user' : 'cb-assistant') });
  if (m.text) wrap.append(el('div', { class: 'cb-text' }, m.text));
  if (m.tools && m.tools.length) wrap.append(el('div', { class: 'cb-tools' }, ...m.tools.map((t) => el('span', { class: 'cb-tool' }, '🔧 ' + t))));
  if (!m.text && (!m.tools || !m.tools.length)) wrap.append(el('div', { class: 'cb-text muted' }, '…'));
  return wrap;
}
function closeModal() { if (state.modal) { state.modal.remove(); state.modal = null; } }

function openSessionChat(projectId, sessionId, title, opts = {}) {
  closeModal();
  let curSession = sessionId || null;       // resume id; updated once a fresh run reports its id
  let write = !!opts.write;                  // plan (read-only) vs write (edits, gated by approvals)
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } });
  const modal = el('div', { class: 'modal' });
  const body = el('div', { class: 'chat-body' });
  const ta = el('textarea', { class: 'q-input', rows: '2', placeholder: curSession ? 'Continue this conversation…  (Ctrl/⌘+Enter)' : 'Describe what you want to build or change…  (Ctrl/⌘+Enter)' });
  const btn = el('button', { class: 'btn', onclick: () => send() }, curSession ? '▶ Continue' : '▶ Start');
  const hint = el('div', { class: 'q-hint' });
  const toggle = el('button', { class: 'mode-toggle', onclick: () => { write = !write; syncMode(); } });
  function syncMode() {
    toggle.textContent = write ? '✏️ Write' : '🔒 Plan';
    toggle.className = 'mode-toggle' + (write ? ' write' : '');
    hint.textContent = write
      ? 'Write mode — Claude can edit & run; Edit/Write/Bash pause for your approval on the Approvals screen · uses your Max plan'
      : 'Plan mode — read-only: Claude explores & proposes, no file changes · uses your Max plan';
  }
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
  modal.append(
    el('div', { class: 'modal-head' },
      el('div', { class: 'modal-title' }, '💬 ', title || 'Session'),
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, toggle,
        el('button', { class: 'modal-x', onclick: closeModal }, '✕'))),
    body,
    el('div', { class: 'chat-input' },
      el('div', { class: 'q-bar' }, ta, btn), hint));
  overlay.append(modal);
  document.body.append(overlay);
  state.modal = overlay;
  syncMode();

  if (curSession) {
    body.append(el('div', { class: 'empty' }, 'Loading…'));
    (async () => {
      const r = await api(`/api/session?project=${encodeURIComponent(projectId)}&id=${encodeURIComponent(curSession)}`);
      body.innerHTML = '';
      if (r.error) { body.append(el('div', { class: 'empty' }, 'Could not load session')); return; }
      for (const m of r.messages) body.append(chatBubble(m));
      body.scrollTop = body.scrollHeight;
    })();
  } else {
    body.append(el('div', { class: 'empty' }, opts.intro || 'New session — send a prompt to begin.'));
  }

  function send() {
    const prompt = ta.value.trim();
    if (!prompt) return;
    if (body.querySelector('.empty')) body.innerHTML = '';
    body.append(chatBubble({ role: 'user', text: prompt }));
    const ans = el('div', { class: 'chat-msg cb-assistant' });
    const textEl = el('div', { class: 'cb-text' });
    const status = el('div', { class: 'cb-status' }, '⏳ launching…');
    ans.append(textEl, status);
    body.append(ans);
    body.scrollTop = body.scrollHeight;
    ta.value = ''; btn.disabled = true; btn.textContent = '…';
    streamContinue(projectId, curSession, prompt, textEl, status, body, btn, write, (sid) => { curSession = sid; });
  }
}

async function streamContinue(projectId, sessionId, prompt, textEl, status, body, btn, write, onSession) {
  let acc = '';
  const restore = () => { btn.disabled = false; btn.textContent = sessionId ? '▶ Continue' : '▶ Start'; };
  const gated = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
  try {
    const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectId, session: sessionId, prompt, write: !!write }) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); status.textContent = '✕ ' + (e.error || res.status); restore(); return; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'started') { status.textContent = '🤖 thinking…'; if (ev.sessionId && onSession) onSession(ev.sessionId); }
        else if (ev.type === 'tool') status.textContent = (write && gated.has(ev.tool) ? '⏳ awaiting approval — ' : '🔧 ') + ev.tool;
        else if (ev.type === 'text') { acc += (acc ? '\n\n' : '') + ev.text; textEl.textContent = acc; }
        else if (ev.type === 'done') status.textContent = ev.error ? '✕ failed' : `✓ done${ev.cost != null ? ` · API-equiv $${ev.cost.toFixed(4)}` : ''}`;
        body.scrollTop = body.scrollHeight;
      }
    }
  } catch (e) { status.textContent = '✕ ' + e.message; }
  restore();
}

// ---- workbench: multiple live sessions side by side ----------------------
function sessionPane(p, opts = {}) {
  let curSession = null;
  let write = !!opts.write;
  const pane = el('div', { class: 'bench-pane' });
  const body = el('div', { class: 'chat-body bench-body' }, el('div', { class: 'empty' }, 'New session — send a prompt to begin.'));
  const ta = el('textarea', { class: 'q-input', rows: '2', placeholder: 'Prompt…  (Ctrl/⌘+Enter)' });
  const btn = el('button', { class: 'btn', onclick: () => send() }, '▶');
  const toggle = el('button', { class: 'mode-toggle', onclick: () => { write = !write; sync(); } });
  function sync() { toggle.textContent = write ? '✏️ Write' : '🔒 Plan'; toggle.className = 'mode-toggle' + (write ? ' write' : ''); }
  sync();
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
  pane.append(
    el('div', { class: 'bench-head' },
      el('span', { class: 'bench-title', title: p.cwd || p.name }, p.name),
      el('div', { style: 'display:flex;gap:6px;align-items:center' }, toggle,
        el('button', { class: 'modal-x', style: 'width:26px;height:26px', onclick: () => pane.remove() }, '✕'))),
    body,
    el('div', { class: 'bench-input' }, el('div', { class: 'q-bar' }, ta, btn)));
  function send() {
    const prompt = ta.value.trim();
    if (!prompt) return;
    if (body.querySelector('.empty')) body.innerHTML = '';
    body.append(chatBubble({ role: 'user', text: prompt }));
    const ans = el('div', { class: 'chat-msg cb-assistant' });
    const textEl = el('div', { class: 'cb-text' });
    const status = el('div', { class: 'cb-status' }, '⏳ launching…');
    ans.append(textEl, status);
    body.append(ans);
    body.scrollTop = body.scrollHeight;
    ta.value = ''; btn.disabled = true; btn.textContent = '…';
    streamContinue(p.id, curSession, prompt, textEl, status, body, btn, write, (sid) => { curSession = sid; });
  }
  return pane;
}

function renderWorkbench() {
  $('#crumb').textContent = 'Workbench';
  const v = $('#view');
  v.innerHTML = '';
  const projects = (state.overview && state.overview.projects) || [];
  const local = projects.filter((p) => p.cwd);
  const grid = el('div', { class: 'bench-grid' });
  const picker = el('select', { class: 'q-input', style: 'height:38px;max-width:280px' },
    el('option', { value: '' }, '— pick an application —'),
    ...local.map((p) => el('option', { value: p.id }, p.name)));
  const writeChk = el('input', { type: 'checkbox', checked: 'checked' });
  const addBtn = el('button', { class: 'btn', onclick: () => {
    const p = local.find((x) => x.id === picker.value);
    if (p) grid.append(sessionPane(p, { write: writeChk.checked }));
  } }, '+ Open session');
  v.append(el('div', { class: 'card fade-in', style: 'margin-bottom:16px' },
    el('div', { class: 'card-title' }, '🛠️ Workbench', el('span', { class: 'muted' }, 'run multiple Claude Code sessions side by side')),
    el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      picker,
      el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:12.5px' }, writeChk, '✏️ write mode'),
      addBtn),
    el('div', { class: 'q-hint', style: 'margin-top:8px' },
      local.length ? 'Each pane is an independent session. Write-mode edits pause for approval on the Approvals screen. Leaving this view ends running sessions.'
        : 'No apps with a local folder yet — create one in Settings → New Project.')));
  v.append(grid);
}

async function renderProject(id) {
  const v = $('#view');
  v.innerHTML = '<div class="empty"><div class="big">⏳</div>Loading…</div>';
  const p = await api('/api/project/' + encodeURIComponent(id));
  if (p.error) { v.innerHTML = '<div class="empty">Not found</div>'; return; }
  $('#crumb').textContent = p.name;
  v.innerHTML = '';

  const gh = p.github || {};
  const m = gh.metrics;
  const headRight = el('div', { class: 'gh-stats' });
  if (m && !m.error) {
    headRight.append(
      el('a', { class: 'gh-stat', href: m.url, target: '_blank' }, el('div', { class: 'v' }, '★ ' + m.stars), el('div', { class: 'l' }, 'stars')),
      el('div', { class: 'gh-stat' }, el('div', { class: 'v' }, m.openPRs), el('div', { class: 'l' }, 'open PRs')),
      el('div', { class: 'gh-stat' }, el('div', { class: 'v' }, m.openIssues), el('div', { class: 'l' }, 'issues')));
  }
  const repoChip = gh.repo
    ? el('a', { class: 'chip gh', href: m && m.url, target: '_blank' }, `${gh.repo.owner}/${gh.repo.repo}`)
    : el('span', { class: 'chip local' }, 'local only');
  v.append(el('div', { class: 'detail-head fade-in' },
    el('div', {},
      el('h1', {}, p.name, ' ', repoChip),
      el('div', { class: 'path' }, p.cwd)),
    headRight));

  // KPIs
  const metered = !(state.overview && state.overview.plan && state.overview.plan.metered === false);
  v.append(el('div', { class: 'kpi-grid' },
    kpi(metered ? 'Spend' : 'API-Equiv. Value', '💸', fmtCost(p.cost), metered ? null : 'not metered', 'pink'),
    kpi('Billable Tokens', '🔢', fmtNum(p.billableTokens), `${fmtNum(p.tokens.cacheRead)} cache reads`, 'neon'),
    kpi('Sessions', '🗂️', String(p.sessionCount), `${p.liveCount} live`),
    kpi('Tool Calls', '🛠️', fmtNum(p.toolCalls), null)));

  // query console
  v.append(queryConsole(p));

  // activity + model
  const modelsArr = Object.entries(p.modelTokens || {}).filter(([, t]) => t > 0).map(([model, tokens]) => ({ label: model.replace('claude-', ''), tokens }));
  v.append(el('div', { class: 'row two' },
    el('div', { class: 'card fade-in' }, el('div', { class: 'card-title' }, 'Token Activity'), areaChart(p.daily)),
    el('div', { class: 'card fade-in' }, el('div', { class: 'card-title' }, 'Model Mix'), modelMix(modelsArr))));

  // github panel
  if (m && !m.error) {
    const ci = m.ci;
    const ciPill = ci
      ? el('a', { class: 'ci-pill ' + (ci.conclusion === 'success' ? 'good' : ci.conclusion ? 'bad' : 'run'), href: ci.url, target: '_blank' },
          ci.conclusion === 'success' ? '✓ CI passing' : ci.status === 'completed' ? '✕ CI ' + ci.conclusion : '● CI ' + ci.status)
      : el('span', { class: 'chip dim' }, 'no CI');
    const commits = (m.recentCommits || []).map((c) => el('div', { class: 'commit' },
      el('a', { href: c.url, target: '_blank' }, el('code', {}, c.sha)),
      el('span', { class: 'cmsg' }, c.message),
      el('span', { class: 'cdate' }, ago(new Date(c.date).getTime()))));
    v.append(el('div', { class: 'row split' },
      el('div', { class: 'card fade-in' },
        el('div', { class: 'card-title' }, 'GitHub', ciPill),
        gh.local ? el('div', { style: 'font-size:12px;color:var(--muted);margin-bottom:10px;' },
          `branch ${gh.local.branch} · ${gh.local.commits || '?'} commits · ${gh.local.dirtyFiles} uncommitted`) : null,
        ...(commits.length ? commits : [el('div', { class: 'empty' }, 'No commits')])),
      el('div', { class: 'card fade-in' },
        el('div', { class: 'card-title' }, 'Open Pull Requests'),
        ...((m.prs && m.prs.length)
          ? m.prs.map((pr) => el('div', { class: 'commit' },
              el('a', { href: pr.url, target: '_blank' }, el('code', {}, '#' + pr.number)),
              el('span', { class: 'cmsg' }, pr.title),
              el('span', { class: 'cdate' }, pr.draft ? 'draft' : '')))
          : [el('div', { class: 'empty' }, 'No open PRs')]))));
  } else if (gh.local) {
    v.append(el('div', { class: 'card fade-in' },
      el('div', { class: 'card-title' }, 'Local Git'),
      el('div', { style: 'font-size:13px;color:var(--muted);' },
        `branch ${gh.local.branch} · ${gh.local.commits || '?'} commits · ${gh.local.dirtyFiles} uncommitted · last: ${gh.local.lastSubject || '—'}`)));
  }

  // sessions
  const sessionRows = p.sessions.map((s) => el('div', { class: 'session-row clickable', onclick: () => openSessionChat(p.id, s.id, s.title), title: 'Open & continue this chat' },
    el('div', { class: 'st' }, s.active ? el('span', { class: 'chip live', style: 'margin-right:8px' }, el('span', { class: 'chip-dot' }), 'live') : null, s.title),
    el('div', { class: 'app-meta' }, fmtCost(s.cost)),
    el('div', { class: 'app-meta' }, `${fmtNum(s.billableTokens)} tok`),
    el('div', { class: 'app-meta' }, `${s.toolCalls} tools`),
    el('div', { class: 'app-meta' }, ago(s.mtime))));
  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Sessions', el('span', { class: 'muted' }, `${p.sessions.length} total`)),
    el('div', {}, ...sessionRows)));
}

function feedItem(e) {
  return el('div', { class: 'feed-item' },
    el('span', { class: 'feed-kind ' + e.kind }, e.kind === 'Notification' ? 'NEEDS YOU' : 'activity'),
    el('div', { class: 'feed-body' },
      el('div', { class: 'fb-top' }, `${e.project}${e.tool ? ' · ' + e.tool : ''}`),
      el('div', { class: 'fb-sum' }, e.summary || '')),
    el('span', { class: 'feed-time' }, ago(e.time)));
}

function renderPendingNodes(pending) {
  if (!pending.length) return [el('div', { class: 'empty' }, 'Nothing waiting. Turn the gateway ON, then a session\'s next Edit/Write/Bash call appears here for you to approve.')];
  return pending.map((p) => el('div', { class: 'feed-item', style: 'border-color:rgba(255,194,75,.35)' },
    el('span', { class: 'feed-kind Notification' }, p.tool || 'tool'),
    el('div', { class: 'feed-body' },
      el('div', { class: 'fb-top' }, p.project || ''),
      el('div', { class: 'fb-sum' }, p.input || '')),
    el('div', { style: 'display:flex;gap:8px;flex-shrink:0' },
      el('button', { class: 'btn', style: 'padding:7px 14px', onclick: () => decide(p.id, 'allow') }, '✓ Approve'),
      el('button', { class: 'btn ghost', style: 'padding:7px 14px', onclick: () => decide(p.id, 'deny') }, '✕ Deny'))));
}

async function decide(id, decision) {
  let reason;
  if (decision === 'deny') reason = prompt('Reason for denial (optional — shown to Claude):') || undefined;
  await api('/api/approval-decide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, decision, reason }) });
  pollPending();
}

async function toggleGateway() {
  const cur = state.approvalsData && state.approvalsData.gateway && state.approvalsData.gateway.enabled;
  await api('/api/gateway', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !cur }) });
  renderApprovals();
}

async function pollPending() {
  if (state.view !== 'approvals') { clearInterval(state.approvalsTimer); return; }
  try {
    const data = await api('/api/approvals');
    state.approvalsData = data;
    const list = $('#pendingList');
    if (list) list.replaceChildren(...renderPendingNodes(data.pending || []));
    const pc = $('#pendCount');
    if (pc) pc.textContent = String((data.pending || []).length);
  } catch { /* server blip */ }
}

async function renderApprovals() {
  $('#crumb').textContent = 'Approvals';
  const v = $('#view');
  v.innerHTML = '<div class="empty"><div class="big">⏳</div>Loading…</div>';
  const data = await api('/api/approvals');
  v.innerHTML = '';
  state.approvalsData = data;
  const g = data.gateway || { enabled: false };
  const pending = data.pending || [];

  // gateway toggle
  v.append(el('div', { class: 'card fade-in', style: 'margin-bottom:18px;border-color:' + (g.enabled ? 'rgba(53,224,139,.4)' : 'var(--glass-brd)') },
    el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap' },
      el('div', {},
        el('div', { class: 'card-title', style: 'margin-bottom:6px' }, '🛡️ Dashboard Approval Gateway'),
        el('div', { style: 'font-size:12.5px;color:var(--muted);line-height:1.65;max-width:580px' },
          'When ON, Edit / Write / Bash tool calls across your sessions pause and wait here for you to Approve or Deny — clear VS Code permission prompts straight from the dashboard. No response in ~50s → the normal VS Code prompt appears, so it never wedges a session. Needs the hook installed (',
          el('code', {}, 'node hooks/install.mjs'), ').')),
      el('button', { class: 'btn ' + (g.enabled ? '' : 'ghost'), onclick: toggleGateway },
        g.enabled ? '● Gateway ON' : '○ Gateway OFF'))));

  // KPIs
  v.append(el('div', { class: 'kpi-grid' },
    el('div', { class: 'card kpi fade-in' },
      el('div', { class: 'kpi-label' }, el('span', { class: 'kpi-icon' }, '⏳'), 'Pending Now'),
      el('div', { class: 'kpi-value pink', id: 'pendCount' }, String(pending.length)),
      el('div', { class: 'kpi-sub' }, 'awaiting your call')),
    kpi('Allow Rules', '✅', String(data.allowlist.count), 'auto-approved', 'neon'),
    kpi('Recent Events', '📡', String(data.events.length), 'logged by hook')));

  // pending (live)
  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Pending Approvals', el('span', { class: 'muted' }, 'live')),
    el('div', { id: 'pendingList' }, ...renderPendingNodes(pending))));

  // activity feed
  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Live Activity & Notifications', el('span', { class: 'muted' }, 'newest first')),
    data.events.length
      ? el('div', { class: 'feed' }, ...data.events.slice(0, 30).map(feedItem))
      : el('div', { class: 'empty' }, el('div', { class: 'big' }, '🪝'), 'No events yet. Install the hook: ', el('code', {}, 'node hooks/install.mjs'))));

  clearInterval(state.approvalsTimer);
  state.approvalsTimer = setInterval(pollPending, 1500);

  // allowlist manager
  const allowGrid = el('div', { class: 'allow-grid' });
  for (const group of data.allowlist.byTool) {
    allowGrid.append(el('div', { class: 'card allow-tool fade-in' },
      el('h4', {}, group.tool, el('span', { class: 'count' }, `${group.rules.length} rules`)),
      ...group.rules.slice(0, 30).map((r) => el('div', { class: 'rule' },
        el('code', {}, r.arg != null ? r.arg : '(any)'),
        el('button', { class: 'rm', title: 'remove', onclick: () => removeRule(r.raw) }, '✕')))));
  }
  v.append(el('div', { class: 'card-title', style: 'margin:26px 0 14px;font-size:14px' }, 'Permission Allowlist',
    el('span', { class: 'muted' }, 'global settings.json · edits are backed up')));
  v.append(el('div', { class: 'add-rule' },
    el('input', { type: 'text', id: 'newRule', placeholder: 'e.g. Bash(npm run test:*)' }),
    el('button', { class: 'btn', onclick: addRule }, '+ Add rule')));
  v.append(allowGrid);
}

async function addRule() {
  const input = $('#newRule');
  const rule = input.value.trim();
  if (!rule) return;
  await api('/api/allowlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', rule }) });
  renderApprovals();
}
async function removeRule(rule) {
  if (!confirm(`Remove allow rule?\n\n${rule}`)) return;
  await api('/api/allowlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', rule }) });
  renderApprovals();
}

function linkRow(icon, title, sub, href) {
  return el('a', { class: 'billing-link', href, target: '_blank', rel: 'noopener noreferrer' },
    el('span', { class: 'bl-ico' }, icon),
    el('div', { class: 'bl-body' },
      el('div', { class: 'bl-title' }, title),
      el('div', { class: 'bl-sub' }, sub)),
    el('span', { class: 'bl-arrow' }, '↗'));
}

function billingCard(plan) {
  const metered = !(plan && plan.metered === false);
  return el('div', { class: 'card fade-in', style: 'max-width:640px' },
    el('div', { class: 'card-title' }, '💳 Billing & Credits'),
    el('p', { style: 'color:var(--muted);font-size:13px;line-height:1.65;margin-bottom:16px' },
      'Prepaid API credits (for the metered API) are bought in the Anthropic Console — there\'s no purchase API, so these open the right pages directly. ',
      el('b', { style: 'color:var(--text)' }, 'Tip:'),
      ' turn on ', el('b', { style: 'color:var(--text)' }, 'auto-reload'),
      ' to top up automatically when your balance runs low.',
      plan && plan.type === 'max'
        ? el('span', {}, ' Your ', el('b', { style: 'color:var(--neon2)' }, 'Claude Max'),
            ' plan is a separate flat-fee subscription and doesn\'t draw from API credits.')
        : null),
    el('div', { class: 'billing-links' },
      linkRow('💳', 'Add / top-up API credits', 'Buy prepaid credits for the metered API', 'https://console.anthropic.com/settings/billing'),
      linkRow('🔁', 'Auto-reload settings', 'Auto-buy credits when your balance runs low', 'https://console.anthropic.com/settings/billing'),
      linkRow('📊', 'API usage', 'Messages & tokens used on the metered API', 'https://console.anthropic.com/settings/usage'),
      linkRow('🧾', 'API cost', 'Month-to-date spend by model & workspace', 'https://console.anthropic.com/settings/cost'),
      linkRow('⚡', 'Manage Claude Max subscription', 'Your plan & billing on claude.ai (separate from API credits)', 'https://claude.ai/settings/billing')));
}

function budgetCard(budgets) {
  return el('div', { class: 'card fade-in', style: 'max-width:640px;margin-top:18px' },
    el('div', { class: 'card-title' }, '🎯 Usage Budgets'),
    el('p', { style: 'color:var(--muted);font-size:13px;margin-bottom:14px;line-height:1.6' },
      'Pacing targets in tokens. The Account screen shows what\'s remaining against them. Anthropic doesn\'t publish exact Max limits, so these are your own targets — leave blank to disable.'),
    el('div', { class: 'field' },
      el('label', {}, 'Daily token budget'),
      el('input', { type: 'text', id: 'budDay', placeholder: 'e.g. 5000000', value: budgets.day || '' }),
      el('label', { style: 'margin-top:10px' }, 'Rolling 5-hour window budget'),
      el('input', { type: 'text', id: 'bud5h', placeholder: 'e.g. 8000000', value: budgets.window5h || '' }),
      el('button', { class: 'btn', style: 'margin-top:14px', onclick: saveBudgets }, 'Save budgets')));
}
async function saveBudgets() {
  const day = $('#budDay').value.trim();
  const w5 = $('#bud5h').value.trim();
  await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ budgets: { day: day ? Number(day) : 0, window5h: w5 ? Number(w5) : 0 } }) });
  renderSettings();
}

function scaffoldCard(gh) {
  const ghLine = !gh.installed
    ? el('span', { style: 'color:var(--warn)' }, '○ GitHub CLI not installed — creates a local folder only')
    : gh.authed
      ? el('span', { style: 'color:var(--good)' }, `● GitHub CLI ready — repos under github.com/${gh.user}`)
      : el('span', { style: 'color:var(--warn)' }, '○ GitHub CLI installed but signed out — run “gh auth login”, then repos can be created');
  const canRepo = gh.installed && gh.authed;
  const repoCheck = el('input', { type: 'checkbox', id: 'scfRepo', ...(canRepo ? { checked: 'checked' } : { disabled: 'disabled' }) });
  return el('div', { class: 'card fade-in', style: 'max-width:640px;margin-top:18px;border-color:rgba(24,224,216,.28)' },
    el('div', { class: 'card-title' }, '✨ New Project'),
    el('p', { style: 'color:var(--muted);font-size:13px;margin-bottom:14px;line-height:1.6' },
      'Creates a folder under ', el('code', {}, gh.projectsRoot || '~/claude-projects'),
      ', runs ', el('code', {}, 'git init'), ', optionally creates a GitHub repo, then drops you into a writeable Claude Code session — no VS Code needed.'),
    el('div', { class: 'field' },
      el('label', {}, 'Project name'),
      el('input', { type: 'text', id: 'scfName', placeholder: 'my-new-app' }),
      el('label', { style: 'margin-top:12px;display:flex;gap:8px;align-items:center;font-weight:400' },
        repoCheck, 'Create a GitHub repo'),
      el('label', { style: 'margin-top:10px' }, 'Visibility'),
      el('select', { id: 'scfVis', class: 'q-input', style: 'height:38px' },
        el('option', { value: 'private' }, 'Private'),
        el('option', { value: 'public' }, 'Public')),
      el('button', { class: 'btn', style: 'margin-top:14px', onclick: () => createProject() }, '✨ Create & open session')),
    el('div', { id: 'scfMsg', style: 'font-size:12.5px;margin-top:10px;line-height:1.5' }),
    el('div', { style: 'font-size:12px;margin-top:8px' }, ghLine));
}

async function createProject() {
  const name = $('#scfName').value.trim();
  const msg = $('#scfMsg');
  if (!name) { msg.style.color = 'var(--bad)'; msg.textContent = 'Enter a project name.'; return; }
  const createRepo = $('#scfRepo').checked;
  const visibility = $('#scfVis').value;
  msg.style.color = 'var(--muted)'; msg.textContent = '⏳ creating folder' + (createRepo ? ' + GitHub repo…' : '…');
  const r = await api('/api/scaffold', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, createRepo, visibility }) });
  if (!r.ok) { msg.style.color = 'var(--bad)'; msg.textContent = '✕ ' + (r.error || 'failed'); return; }
  msg.style.color = 'var(--good)';
  msg.textContent = `✓ ${r.path}` + (r.github ? `  ·  ${r.github}` : '') + (r.repoError ? `  ·  ⚠ ${r.repoError}` : '');
  await refresh();
  if (r.projectId) {
    navProject(r.projectId);
    openSessionChat(r.projectId, null, name, { write: true, intro: `Fresh project at ${r.path}. Describe what you want to build and I'll start working — edits pause for your approval.` });
  }
}

async function renderSettings() {
  $('#crumb').textContent = 'Settings';
  const v = $('#view');
  v.innerHTML = '';
  v.append(billingCard(state.overview && state.overview.plan));
  const cfg = await api('/api/config');
  v.append(budgetCard(cfg.budgets || {}));
  v.append(el('div', { class: 'card fade-in', style: 'max-width:640px' },
    el('div', { class: 'card-title' }, 'GitHub Integration'),
    el('p', { style: 'color:var(--muted);font-size:13px;margin-bottom:16px;line-height:1.6' },
      'Paste a GitHub Personal Access Token (classic or fine-grained with repo read). It is stored locally in ',
      el('code', {}, 'data/config.json'), ' and never leaves your machine. ',
      cfg.hasToken ? el('span', { style: 'color:var(--good)' }, '● Token configured') : el('span', { style: 'color:var(--warn)' }, '○ Not set')),
    el('div', { class: 'field' },
      el('label', {}, 'Personal Access Token'),
      el('input', { type: 'password', id: 'ghToken', placeholder: cfg.hasToken ? '•••••••••• (saved)' : 'ghp_…' }),
      el('button', { class: 'btn', style: 'margin-top:12px', onclick: saveToken }, 'Save token'))));

  v.append(el('div', { class: 'card fade-in', style: 'max-width:640px;margin-top:18px' },
    el('div', { class: 'card-title' }, 'Live Approvals Hook'),
    el('p', { style: 'color:var(--muted);font-size:13px;line-height:1.7' },
      'To populate the live activity & approvals feed, install the Claude Code hook once:',
      el('div', { style: 'margin:12px 0;padding:12px 14px;background:rgba(0,0,0,.3);border-radius:10px;font-family:monospace;color:var(--neon2)' },
        'node hooks/install.mjs'),
      'This wires a Notification + PreToolUse hook into ~/.claude/settings.json (with a backup). Restart any running sessions afterward.')));

  const gh = await api('/api/gh-status');
  v.append(scaffoldCard(gh));

  const apps = await api('/api/apps');
  v.append(el('div', { class: 'card fade-in', style: 'max-width:640px;margin-top:18px' },
    el('div', { class: 'card-title' }, 'Applications'),
    el('p', { style: 'color:var(--muted);font-size:13px;margin-bottom:14px;line-height:1.6' },
      'Track apps beyond the ones auto-discovered from your Claude history. Add a local folder (to query it directly) and/or a GitHub repo (for metrics).'),
    el('div', { class: 'field' },
      el('label', {}, 'Name (optional)'),
      el('input', { type: 'text', id: 'appName', placeholder: 'My App' }),
      el('label', { style: 'margin-top:10px' }, 'Local folder path (optional)'),
      el('input', { type: 'text', id: 'appPath', placeholder: 'C:\\Users\\Jameson\\my-app' }),
      el('label', { style: 'margin-top:10px' }, 'GitHub URL (optional)'),
      el('input', { type: 'text', id: 'appGh', placeholder: 'https://github.com/you/repo' }),
      el('button', { class: 'btn', style: 'margin-top:14px', onclick: addCustomApp }, '+ Add application')),
    el('div', { id: 'appMsg', style: 'color:var(--bad);font-size:12px;margin-top:8px' }),
    apps.apps.length
      ? el('div', { style: 'margin-top:16px' }, ...apps.apps.map((a) => el('div', { class: 'rule' },
          el('code', {}, a.name + (a.path ? '  ·  ' + a.path : '') + (a.github ? '  ·  [' + a.github + ']' : '')),
          el('button', { class: 'rm', onclick: () => removeCustomApp(a.id) }, '✕'))))
      : null));
}

async function addCustomApp() {
  const name = $('#appName').value.trim();
  const path = $('#appPath').value.trim();
  const github = $('#appGh').value.trim();
  const r = await api('/api/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', name, path, github }) });
  if (!r.ok) { $('#appMsg').textContent = r.error || 'Could not add'; return; }
  await refresh();
  renderSettings();
}
async function removeCustomApp(id) {
  await api('/api/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', id }) });
  await refresh();
  renderSettings();
}

async function saveToken() {
  const val = $('#ghToken').value.trim();
  if (!val) return;
  await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ githubToken: val }) });
  renderSettings();
}

// ---- nav + polling ---------------------------------------------------------
function setActiveNav() {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view && !state.projectId));
  document.querySelectorAll('.project-item').forEach((b) => b.classList.toggle('active', b.dataset.id === state.projectId));
}
function navView(view) {
  clearInterval(state.approvalsTimer);
  state.view = view; state.projectId = null;
  setActiveNav();
  if (view === 'overview') renderOverview(state.overview);
  else if (view === 'workbench') renderWorkbench();
  else if (view === 'account') renderAccount();
  else if (view === 'approvals') renderApprovals();
  else if (view === 'settings') renderSettings();
}
function navProject(id) {
  clearInterval(state.approvalsTimer);
  state.view = 'project'; state.projectId = id;
  setActiveNav();
  renderProject(id);
}

function buildProjectNav(projects) {
  const nav = $('#projectNav');
  nav.innerHTML = '';
  nav.append(el('button', { class: 'project-item', style: 'color:var(--neon2)', onclick: () => navView('settings') },
    el('span', { class: 'pi-name' }, '＋ Add application')));
  for (const p of projects) {
    const item = el('button', { class: 'project-item', 'data-id': p.id, onclick: () => navProject(p.id) },
      el('span', { class: 'pi-name' }, p.name),
      p.liveCount
        ? el('span', { class: 'pi-badge' }, el('span', { class: 'chip-dot' }), p.liveCount)
        : el('span', { class: 'pi-cost' }, fmtCost(p.cost)));
    nav.append(item);
  }
  setActiveNav();
}

async function refresh() {
  const tick = $('#refreshTick');
  tick.classList.add('spin');
  setTimeout(() => tick.classList.remove('spin'), 600);
  try {
    const data = await api('/api/overview');
    state.overview = data;
    buildProjectNav(data.projects);
    $('#updatedAt').textContent = 'updated ' + new Date(data.generatedAt).toLocaleTimeString();
    const dot = $('#liveDot'), txt = $('#liveText');
    if (data.totals.live > 0) { dot.classList.add('on'); txt.textContent = `${data.totals.live} session${data.totals.live > 1 ? 's' : ''} live`; }
    else { dot.classList.remove('on'); txt.textContent = 'all idle'; }
    // re-render current view if it depends on overview / live data
    if (state.view === 'overview' && !state.projectId) renderOverview(data);
  } catch (e) {
    $('#liveText').textContent = 'server offline';
  }
}

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => navView(b.dataset.view)));

refresh().then(() => navView('overview'));
state.refreshTimer = setInterval(refresh, 5000);
