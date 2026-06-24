'use strict';

const COLORS = ['#7c5cff', '#18e0d8', '#ff5cc8', '#35e08b', '#ffc24b', '#5b9bff', '#ff8d5c'];
const state = { view: 'overview', projectId: null, overview: null, refreshTimer: null, machines: null, machineId: null };

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
  opts = opts || {};
  // Tag every proxied request with the machine the user is viewing. Harmless on
  // the local agent (which ignores it) and in single-machine broker mode.
  if (state.machineId) opts.headers = { ...(opts.headers || {}), 'X-CC-Machine': state.machineId };
  const res = await fetch(path, opts);
  if (res.status === 401 && !path.startsWith('/api/auth/')) lockApp();
  return res.json();
}

// ---- SVG charts ------------------------------------------------------------
function areaChart(dailyMap, { height = 150, unit = 'tokens' } = {}) {
  const days = Object.keys(dailyMap).sort();
  if (days.length === 0) return el('div', { class: 'empty' }, 'No activity yet');
  // keep last 30 days
  const slice = days.slice(-30);
  const vals = slice.map((d) => dailyMap[d]);
  const n = slice.length;
  const max = Math.max(...vals, 1);
  const peakIdx = vals.indexOf(Math.max(...vals));
  const avg = vals.reduce((s, v) => s + v, 0) / n;
  const W = 600, H = height, pad = 8, topPad = 14;
  const stepX = n > 1 ? (W - pad * 2) / (n - 1) : 0;
  const y = (v) => H - pad - (v / max) * (H - pad * 2 - topPad);
  const x = (i) => pad + i * stepX;
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`);
  const linePath = 'M' + pts.join(' L');
  const areaPath = `M${x(0)},${H - pad} L` + pts.join(' L') + ` L${x(n - 1)},${H - pad} Z`;
  const grid = [0.25, 0.5, 0.75, 1].map((f) => {
    const gy = H - pad - f * (H - pad * 2 - topPad);
    return `<line x1="${pad}" y1="${gy}" x2="${W - pad}" y2="${gy}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>`;
  }).join('');
  const avgY = y(avg);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = `width:100%;height:${H}px;display:block`;
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
    ${grid}
    <line x1="${pad}" y1="${avgY}" x2="${W - pad}" y2="${avgY}" stroke="#ffc24b" stroke-width="1" stroke-dasharray="4 4" opacity="0.6"/>
    <path d="${areaPath}" fill="url(#areaGrad)"/>
    <path d="${linePath}" fill="none" stroke="url(#lineGrad)" stroke-width="2.5"
      stroke-linejoin="round" stroke-linecap="round"
      style="filter: drop-shadow(0 0 6px rgba(124,92,255,.5))"/>
    <circle cx="${x(peakIdx)}" cy="${y(vals[peakIdx])}" r="3.5" fill="#ff5cc8"/>
    <circle cx="${x(n - 1)}" cy="${y(vals[n - 1])}" r="4" fill="#18e0d8"/>
  `;
  const wrap = el('div', { class: 'chart-wrap', style: `position:relative;height:${H}px` });
  wrap.append(svg);
  wrap.append(el('div', { class: 'chart-ymax' }, fmtNum(max)));
  wrap.append(el('div', { class: 'chart-avg', style: `top:${(avgY / H) * 100}%` }, 'avg ' + fmtNum(avg)));

  // interactive crosshair + tooltip (HTML overlay → no SVG-text distortion)
  const cross = el('div', { class: 'chart-cross' });
  const dot = el('div', { class: 'chart-dot' });
  const tip = el('div', { class: 'chart-tip' });
  cross.style.display = dot.style.display = tip.style.display = 'none';
  wrap.append(cross, dot, tip);
  wrap.addEventListener('mousemove', (e) => {
    const rect = wrap.getBoundingClientRect();
    const vbX = ((e.clientX - rect.left) / rect.width) * W;
    let i = Math.round((vbX - pad) / (stepX || 1));
    i = Math.max(0, Math.min(n - 1, i));
    const leftPx = (x(i) / W) * rect.width;
    const topPx = (y(vals[i]) / H) * rect.height;
    cross.style.display = dot.style.display = tip.style.display = 'block';
    cross.style.left = leftPx + 'px';
    dot.style.left = leftPx + 'px'; dot.style.top = topPx + 'px';
    const d = vals[i] - (i > 0 ? vals[i - 1] : vals[i]);
    const arrow = i > 0 ? (d > 0 ? `▲ ${fmtNum(Math.abs(d))}` : d < 0 ? `▼ ${fmtNum(Math.abs(d))}` : '—') : '';
    tip.innerHTML = `<b>${slice[i].slice(5)}</b>&nbsp; ${fmtNum(vals[i])} ${unit}` + (arrow ? `<span class="ct-d ${d >= 0 ? 'up' : 'dn'}">${arrow}</span>` : '');
    const tw = 150;
    tip.style.left = Math.max(2, Math.min(rect.width - tw, leftPx - tw / 2)) + 'px';
    tip.style.top = Math.max(2, topPx - 38) + 'px';
  });
  wrap.addEventListener('mouseleave', () => { cross.style.display = dot.style.display = tip.style.display = 'none'; });

  const labels = el('div', { style: 'display:flex;justify-content:space-between;font-size:10px;color:var(--dim);margin-top:6px;' },
    el('span', {}, slice[0]?.slice(5)), el('span', {}, slice[n - 1]?.slice(5)));
  wrap.append(labels);
  return wrap;
}

// Cumulative spend this calendar month + dashed projection to month-end.
function burnUpChart(dailyCost, { metered = true, height = 180 } = {}) {
  const now = new Date();
  const Y = now.getFullYear(), Mo = now.getMonth(), today = now.getDate();
  const daysInMonth = new Date(Y, Mo + 1, 0).getDate();
  const p2 = (n) => String(n).padStart(2, '0');
  const key = (day) => `${Y}-${p2(Mo + 1)}-${p2(day)}`;
  const cum = [];
  let run = 0;
  for (let d = 1; d <= today; d++) { run += dailyCost[key(d)] || 0; cum.push(run); }
  const mtd = run;
  const avgDaily = today > 0 ? mtd / today : 0;
  const projected = mtd + avgDaily * (daysInMonth - today);
  const pre = metered ? '' : '≈ ';

  const W = 600, H = height, pad = 8, topPad = 16;
  const max = Math.max(projected, mtd, 0.01);
  const stepX = (W - pad * 2) / (daysInMonth - 1 || 1);
  const x = (day) => pad + (day - 1) * stepX;
  const y = (v) => H - pad - (v / max) * (H - pad * 2 - topPad);
  const actPts = cum.map((v, i) => `${x(i + 1)},${y(v)}`);
  const actLine = 'M' + actPts.join(' L');
  const actArea = `M${x(1)},${H - pad} L` + actPts.join(' L') + ` L${x(today)},${H - pad} Z`;
  const projLine = `M${x(today)},${y(mtd)} L${x(daysInMonth)},${y(projected)}`;
  const grid = [0.25, 0.5, 0.75, 1].map((f) => {
    const gy = H - pad - f * (H - pad * 2 - topPad);
    return `<line x1="${pad}" y1="${gy}" x2="${W - pad}" y2="${gy}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>`;
  }).join('');

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = `width:100%;height:${H}px;display:block`;
  svg.innerHTML = `
    <defs><linearGradient id="burnGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ff5cc8" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#ff5cc8" stop-opacity="0"/></linearGradient></defs>
    ${grid}
    <path d="${actArea}" fill="url(#burnGrad)"/>
    <path d="${actLine}" fill="none" stroke="#ff5cc8" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${projLine}" fill="none" stroke="#ffc24b" stroke-width="2" stroke-dasharray="5 5"/>
    <circle cx="${x(today)}" cy="${y(mtd)}" r="4" fill="#ff5cc8"/>
    <circle cx="${x(daysInMonth)}" cy="${y(projected)}" r="3.5" fill="#ffc24b"/>`;

  const wrap = el('div', { class: 'chart-wrap', style: `position:relative;height:${H}px` });
  wrap.append(svg);
  wrap.append(el('div', { class: 'chart-cross' }));
  const cross = wrap.lastChild; cross.style.display = 'none';
  const tip = el('div', { class: 'chart-tip' }); tip.style.display = 'none';
  wrap.append(tip);
  wrap.addEventListener('mousemove', (e) => {
    const rect = wrap.getBoundingClientRect();
    const vbX = ((e.clientX - rect.left) / rect.width) * W;
    let day = Math.round((vbX - pad) / stepX) + 1;
    day = Math.max(1, Math.min(daysInMonth, day));
    const isProj = day > today;
    const val = isProj ? mtd + avgDaily * (day - today) : cum[day - 1];
    const leftPx = (x(day) / W) * rect.width;
    cross.style.display = tip.style.display = 'block';
    cross.style.left = leftPx + 'px';
    tip.innerHTML = `<b>${p2(Mo + 1)}-${p2(day)}</b> · ${pre}${fmtCost(val)}${isProj ? ' <span class="ct-d">projected</span>' : ''}`;
    const tw = 170;
    tip.style.left = Math.max(2, Math.min(rect.width - tw, leftPx - tw / 2)) + 'px';
    tip.style.top = '6px';
  });
  wrap.addEventListener('mouseleave', () => { cross.style.display = tip.style.display = 'none'; });

  const summary = el('div', { style: 'display:flex;gap:24px;flex-wrap:wrap;margin-top:12px' },
    el('div', {}, el('div', { class: 'kpi-value pink', style: 'font-size:26px' }, pre + fmtCost(mtd)),
      el('div', { class: 'kpi-sub' }, `spent over ${today} day${today > 1 ? 's' : ''}`)),
    el('div', {}, el('div', { class: 'kpi-value', style: 'font-size:26px;color:var(--warn)' }, pre + fmtCost(projected)),
      el('div', { class: 'kpi-sub' }, `projected by ${p2(Mo + 1)}-${daysInMonth}`)),
    el('div', {}, el('div', { class: 'kpi-value', style: 'font-size:26px' }, pre + fmtCost(avgDaily)),
      el('div', { class: 'kpi-sub' }, 'avg / day')));
  return el('div', {}, wrap, summary);
}

// Stacked area of token usage per model over time.
function stackedAreaChart(modelDaily, { height = 170, labelOf = (m) => m } = {}) {
  const days = Object.keys(modelDaily || {}).sort().slice(-30);
  if (!days.length) return el('div', { class: 'empty' }, 'No activity yet');
  // rank models by total over the window; keep top 6, fold the rest into "Other"
  const totals = {};
  for (const d of days) for (const [m, t] of Object.entries(modelDaily[d])) {
    if (m === '<synthetic>' || !t) continue;
    totals[m] = (totals[m] || 0) + t;
  }
  let models = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  if (!models.length) return el('div', { class: 'empty' }, 'No model usage yet');
  const TOP = 6;
  const folded = models.length > TOP;
  const keep = models.slice(0, TOP);
  const valFor = (d, m) => {
    if (m !== '__other__') return modelDaily[d][m] || 0;
    return Object.entries(modelDaily[d]).reduce((s, [mm, t]) => s + (keep.includes(mm) || mm === '<synthetic>' ? 0 : t), 0);
  };
  const layers = folded ? [...keep, '__other__'] : keep;
  const labels = layers.map((m) => (m === '__other__' ? 'Other' : labelOf(m)));

  // per-day stack + max
  const stacks = days.map((d) => layers.map((m) => valFor(d, m)));
  const sums = stacks.map((s) => s.reduce((a, b) => a + b, 0));
  const max = Math.max(...sums, 1);
  const n = days.length;
  const W = 600, H = height, pad = 8, topPad = 12;
  const stepX = n > 1 ? (W - pad * 2) / (n - 1) : 0;
  const x = (i) => pad + i * stepX;
  const y = (v) => H - pad - (v / max) * (H - pad * 2 - topPad);

  // cumulative upper edges per layer
  const cum = days.map(() => 0);
  const paths = [];
  layers.forEach((m, k) => {
    const lower = days.map((_, i) => cum[i]);
    days.forEach((_, i) => { cum[i] += stacks[i][k]; });
    const upper = days.map((_, i) => cum[i]);
    const top = upper.map((v, i) => `${x(i)},${y(v)}`).join(' L');
    const bot = lower.map((v, i) => `${x(i)},${y(v)}`).reverse().join(' L');
    paths.push(`<path d="M${top} L${bot} Z" fill="${COLORS[k % COLORS.length]}" fill-opacity="0.62" stroke="${COLORS[k % COLORS.length]}" stroke-width="0.6"/>`);
  });
  const grid = [0.25, 0.5, 0.75, 1].map((f) => {
    const gy = H - pad - f * (H - pad * 2 - topPad);
    return `<line x1="${pad}" y1="${gy}" x2="${W - pad}" y2="${gy}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>`;
  }).join('');

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = `width:100%;height:${H}px;display:block`;
  svg.innerHTML = grid + paths.join('');

  const wrap = el('div', { class: 'chart-wrap', style: `position:relative;height:${H}px` });
  wrap.append(svg);
  wrap.append(el('div', { class: 'chart-ymax' }, fmtNum(max)));
  const cross = el('div', { class: 'chart-cross' });
  const tip = el('div', { class: 'chart-tip' });
  cross.style.display = tip.style.display = 'none';
  wrap.append(cross, tip);
  wrap.addEventListener('mousemove', (e) => {
    const rect = wrap.getBoundingClientRect();
    const vbX = ((e.clientX - rect.left) / rect.width) * W;
    let i = Math.round((vbX - pad) / (stepX || 1));
    i = Math.max(0, Math.min(n - 1, i));
    const leftPx = (x(i) / W) * rect.width;
    cross.style.display = tip.style.display = 'block';
    cross.style.left = leftPx + 'px';
    const rows = layers.map((m, k) => ({ label: labels[k], v: stacks[i][k], c: COLORS[k % COLORS.length] }))
      .filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
    tip.innerHTML = `<b>${days[i].slice(5)}</b> · ${fmtNum(sums[i])} tok`
      + rows.map((r) => `<div class="ct-row"><span class="ct-sw" style="background:${r.c}"></span>${r.label} <b>${fmtNum(r.v)}</b></div>`).join('');
    const tw = 190;
    tip.style.left = Math.max(2, Math.min(rect.width - tw, leftPx - tw / 2)) + 'px';
    tip.style.top = '6px';
  });
  wrap.addEventListener('mouseleave', () => { cross.style.display = tip.style.display = 'none'; });
  wrap.append(el('div', { style: 'display:flex;justify-content:space-between;font-size:10px;color:var(--dim);margin-top:6px;' },
    el('span', {}, days[0].slice(5)), el('span', {}, days[n - 1].slice(5))));

  const total = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const legend = el('div', { class: 'legend', style: 'margin-top:12px' },
    ...layers.map((m, k) => {
      const v = m === '__other__' ? models.slice(TOP).reduce((s, mm) => s + totals[mm], 0) : totals[m];
      return el('div', { class: 'legend-item' },
        el('span', { class: 'legend-swatch', style: `background:${COLORS[k % COLORS.length]}` }),
        el('span', { class: 'legend-name' }, labels[k]),
        el('span', { class: 'legend-val' }, `${fmtNum(v)} · ${(v / total * 100).toFixed(0)}%`));
    }));
  return el('div', {}, wrap, legend);
}

function sparkline(dailyMap, { w = 120, h = 30 } = {}) {
  const vals = Object.keys(dailyMap).sort().slice(-30).map((d) => dailyMap[d]);
  if (!vals.length || Math.max(...vals) === 0) return el('div', { class: 'spark muted' }, '—');
  const max = Math.max(...vals, 1);
  const stepX = vals.length > 1 ? w / (vals.length - 1) : 0;
  const y = (v) => h - 2 - (v / max) * (h - 4);
  const pts = vals.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = `width:100%;height:${h}px;display:block`;
  const li = vals.length - 1;
  const rising = vals[li] >= (vals[li - 1] ?? vals[li]);
  const stroke = rising ? '#35e08b' : '#ff5cc8';
  svg.innerHTML = `<polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${(li * stepX).toFixed(1)}" cy="${y(vals[li]).toFixed(1)}" r="2" fill="${stroke}"/>`;
  return el('div', { class: 'spark', title: '30-day token trend' }, svg);
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

  // model usage over time (stacked area)
  if (data.modelDaily && Object.keys(data.modelDaily).length) {
    const labelMap = {};
    for (const m of data.models) labelMap[m.model] = m.label;
    v.append(el('div', { class: 'card fade-in' },
      el('div', { class: 'card-title' }, 'Model Usage Over Time', el('span', { class: 'muted' }, 'tokens by model · last 30 days')),
      stackedAreaChart(data.modelDaily, { labelOf: (m) => labelMap[m] || m.replace('claude-', '') })));
  }

  // applications table
  const maxCost = Math.max(...data.projects.map((p) => p.cost), 0.0001);
  const rows = data.projects.map((p) => el('div', { class: 'app-row', onclick: () => navProject(p.id) },
    el('div', { class: 'app-name' },
      el('span', {}, p.name),
      p.liveCount ? el('span', { class: 'chip live' }, el('span', { class: 'chip-dot' }), 'live') : null),
    sparkline(p.daily || {}),
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
function compareBar(label, value, maxValue, color, pre) {
  return el('div', { style: 'margin-bottom:11px' },
    el('div', { style: 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px' },
      el('span', {}, label), el('span', { class: 'muted' }, pre + fmtCost(value))),
    el('div', { class: 'gauge' }, el('span', { class: 'gauge-fill', style: `width:${Math.max(2, (value / maxValue) * 100)}%;background:${color}` })));
}
function cacheSavingsCard(cache, totalCost, metered) {
  if (!cache || !cache.readTokens) return null;
  const pre = metered ? '' : '≈ ';
  const without = totalCost + cache.savings;
  const pct = without > 0 ? (cache.savings / without) * 100 : 0;
  return el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Cache Savings', el('span', { class: 'muted' }, 'what prompt caching saved you')),
    el('div', { style: 'display:flex;gap:28px;align-items:center;flex-wrap:wrap' },
      el('div', {},
        el('div', { class: 'kpi-value neon', style: 'font-size:38px' }, pre + fmtCost(cache.savings)),
        el('div', { class: 'kpi-sub' }, `${pct.toFixed(0)}% off your effective bill · ${fmtNum(cache.readTokens)} tok served from cache`)),
      el('div', { style: 'flex:1;min-width:280px' },
        compareBar('Without caching', without, without, '#ff5cc8', pre),
        compareBar('What you actually paid', totalCost, without, '#35e08b', pre))));
}
function sessionHistogram(sizes) {
  if (!sizes || !sizes.length) return el('div', { class: 'empty' }, 'No sessions yet');
  const EDGES = [0, 50e3, 100e3, 250e3, 500e3, 1e6, 2e6, 5e6, Infinity];
  const LAB = ['<50K', '50–100K', '100–250K', '250–500K', '500K–1M', '1–2M', '2–5M', '5M+'];
  const counts = new Array(LAB.length).fill(0);
  for (const v of sizes) {
    for (let i = 0; i < EDGES.length - 1; i++) { if (v >= EDGES[i] && v < EDGES[i + 1]) { counts[i]++; break; } }
  }
  const max = Math.max(...counts, 1);
  const sorted = [...sizes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const wrap = el('div', { class: 'hist' });
  counts.forEach((c, i) => {
    wrap.append(el('div', { class: 'hist-col', title: `${LAB[i]} tok — ${c} session${c !== 1 ? 's' : ''}` },
      el('div', { class: 'hist-count' }, c || ''),
      el('div', { class: 'hist-bar-wrap' }, el('div', { class: 'hist-bar', style: `height:${Math.max(2, (c / max) * 100)}%` })),
      el('div', { class: 'hist-lab' }, LAB[i])));
  });
  return el('div', {}, wrap,
    el('div', { class: 'kpi-sub', style: 'margin-top:10px' },
      `${sizes.length} sessions · median ${fmtNum(median)} · mean ${fmtNum(mean)} billable tok`));
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

  // month-to-date spend pace + end-of-month projection
  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, (metered ? 'Spend Pace' : 'Value Pace'),
      el('span', { class: 'muted' }, 'month-to-date' + (metered ? '' : ' · API-equiv'))),
    burnUpChart(a.dailyCost || {}, { metered })));

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

  // cache savings
  const cacheCard = cacheSavingsCard(a.cache, a.totals.cost, metered);
  if (cacheCard) v.append(cacheCard);

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

  // session size distribution
  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Session Size Distribution', el('span', { class: 'muted' }, 'how big your sessions run')),
    sessionHistogram(a.sessionSizes)));

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
    const streamEl = el('div', { class: 'cb-stream' });
    const status = el('div', { class: 'cb-status' }, '⏳ launching…');
    ans.append(streamEl, status);
    body.append(ans);
    body.scrollTop = body.scrollHeight;
    ta.value = ''; btn.disabled = true; btn.textContent = '…';
    streamContinue(projectId, curSession, prompt, streamEl, status, body, btn, write, (sid) => { curSession = sid; });
  }
}

function toolSummary(tool, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return String(input.command);
  if (input.file_path) return String(input.file_path);
  if (input.path) return String(input.path);
  if (input.pattern) return String(input.pattern) + (input.path ? ' in ' + input.path : '');
  if (input.url) return String(input.url);
  if (input.description) return String(input.description);
  const k = Object.keys(input);
  return k.length ? k.slice(0, 3).join(', ') : '';
}
// A Claude-Code-style tool line: ⏺ Tool(args) with collapsible output below.
function toolCard(ev) {
  const out = el('pre', { class: 'tc-out' });
  out.style.display = 'none';
  const toggle = el('span', { class: 'tc-toggle' }, '');
  const head = el('div', { class: 'tc-head' },
    el('span', { class: 'tc-mark' }, '⏺'),
    el('span', { class: 'tc-name' }, ev.tool),
    el('span', { class: 'tc-arg' }, toolSummary(ev.tool, ev.input)),
    toggle);
  head.addEventListener('click', () => {
    if (!out.textContent) return;
    const open = out.style.display !== 'none';
    out.style.display = open ? 'none' : 'block';
    toggle.textContent = open ? '▸' : '▾';
  });
  const card = el('div', { class: 'tool-call' }, head, out);
  return {
    el: card,
    setOutput(text, isError) {
      const t = String(text || '');
      out.textContent = t.length > 8000 ? t.slice(0, 8000) + '\n…(truncated)' : t;
      out.style.display = t ? 'block' : 'none';
      toggle.textContent = t ? '▾' : '';
      if (isError) card.classList.add('err');
    },
  };
}

async function streamContinue(projectId, sessionId, prompt, stream, status, body, btn, write, onSession, onStatus, signal) {
  const st = (s) => { if (onStatus) onStatus(s); };
  const restore = () => { btn.disabled = false; btn.textContent = sessionId ? '▶ Continue' : '▶ Start'; };
  const gated = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
  const cards = {}; // tool_use id -> card
  let curText = null;
  const addText = (t) => {
    if (!curText) { curText = el('div', { class: 'cb-text' }); stream.append(curText); }
    curText.textContent += (curText.textContent ? '\n\n' : '') + t;
  };
  try {
    const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal, body: JSON.stringify({ project: projectId, session: sessionId, prompt, write: !!write }) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); status.textContent = '✕ ' + (e.error || res.status); st('error'); restore(); return; }
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
        if (ev.type === 'started') { status.textContent = '🤖 thinking…'; st('running'); if (ev.sessionId && onSession) onSession(ev.sessionId); }
        else if (ev.type === 'tool') {
          curText = null;
          const awaiting = write && gated.has(ev.tool);
          const c = toolCard(ev); stream.append(c.el); if (ev.id) cards[ev.id] = c;
          status.textContent = (awaiting ? '⏳ awaiting approval — ' : '🔧 running ') + ev.tool;
          st(awaiting ? 'awaiting' : 'running');
        }
        else if (ev.type === 'tool_result') { const c = cards[ev.id]; if (c) c.setOutput(ev.output, ev.isError); st('running'); }
        else if (ev.type === 'text') { addText(ev.text); st('running'); }
        else if (ev.type === 'stderr') { /* surfaced via the tool result/output */ }
        else if (ev.type === 'done') { status.textContent = ev.error ? '✕ failed' : `✓ done${ev.cost != null ? ` · API-equiv $${ev.cost.toFixed(4)}` : ''}`; st(ev.error ? 'error' : 'done'); }
        body.scrollTop = body.scrollHeight;
      }
    }
  } catch (e) {
    // Aborting the fetch (Stop button / pane close) is a normal user action, not
    // an error — the server kills the claude child on request-close.
    if (e.name === 'AbortError') { status.textContent = '⏹ stopped'; st('idle'); }
    else { status.textContent = '✕ ' + e.message; st('error'); }
  }
  restore();
}

// ---- workbench: multiple live sessions side by side ----------------------
// Multi-session workbench: a session rail + one focused conversation. Sessions
// live in state.bench so they keep streaming even when you switch views, and
// are persisted to localStorage so they survive a reload / app restart — they
// only go away when you explicitly close them with ✕.
const BENCH_KEY = 'cc.bench.v1';
function ensureBench() {
  if (!state.bench) {
    state.bench = { sessions: [], activeId: null, seq: 1 };
    loadBench();
  }
  return state.bench;
}
function saveBench() {
  const b = state.bench;
  if (!b) return;
  try {
    localStorage.setItem(BENCH_KEY, JSON.stringify({
      seq: b.seq,
      activeId: b.activeId,
      // Only the durable bits — DOM nodes and the detached live stream can't be
      // serialized; we rebuild the pane and reload the transcript on restore.
      sessions: b.sessions.map((s) => ({
        id: s.id, project: s.project, write: s.write, curSession: s.curSession, status: s.status,
      })),
    }));
  } catch { /* storage unavailable or full — sessions just won't persist */ }
}
function loadBench() {
  let data;
  try { data = JSON.parse(localStorage.getItem(BENCH_KEY) || 'null'); } catch { data = null; }
  if (!data || !Array.isArray(data.sessions)) return;
  const b = state.bench;
  b.seq = data.seq || 1;
  b.activeId = data.activeId || null;
  for (const s of data.sessions) {
    if (s && s.project) buildBenchSession(s.project, s.write, s);
  }
}
// Reload a restored session's conversation from its transcript so the pane
// isn't blank when you come back to it.
async function loadBenchHistory(sess) {
  try {
    const r = await api(`/api/session?project=${encodeURIComponent(sess.project.id)}&id=${encodeURIComponent(sess.curSession)}`);
    if (!r || r.error || !Array.isArray(r.messages) || !r.messages.length) return;
    sess.bodyEl.innerHTML = '';
    for (const m of r.messages) sess.bodyEl.append(chatBubble(m));
    sess.bodyEl.scrollTop = sess.bodyEl.scrollHeight;
  } catch { /* leave the placeholder */ }
}
const BENCH_STATUS = {
  idle: { dot: 'idle', label: 'Idle' },
  running: { dot: 'run', label: 'Working…' },
  awaiting: { dot: 'await', label: 'Needs approval' },
  done: { dot: 'done', label: 'Done' },
  error: { dot: 'err', label: 'Error' },
};

function buildBenchSession(project, write, saved) {
  const b = ensureBench();
  // A restored session that was mid-run when the app closed: the live stream is
  // gone, so drop it back to idle rather than show a stuck "Working…".
  let status = saved ? saved.status : 'idle';
  if (status === 'running' || status === 'awaiting') status = 'idle';
  const sess = { id: (saved && saved.id) || ('b' + (b.seq++)), project, write: !!write, curSession: (saved && saved.curSession) || null, status, unread: false };
  const body = el('div', { class: 'chat-body bench-body' }, el('div', { class: 'empty' }, 'New session — send a prompt to begin. ✕ ends it.'));
  const ta = el('textarea', { class: 'q-input', rows: '2', placeholder: 'Prompt…  (Ctrl/⌘+Enter)' });
  const btn = el('button', { class: 'btn', onclick: () => send() }, '▶ Send');
  const stopBtn = el('button', { class: 'btn stop', style: 'display:none', title: 'Stop this prompt', onclick: () => stop() }, '⏹ Stop');
  const toggle = el('button', { class: 'mode-toggle', onclick: () => { sess.write = !sess.write; syncMode(); saveBench(); } });
  function syncMode() { toggle.textContent = sess.write ? '✏️ Write' : '🔒 Plan'; toggle.className = 'mode-toggle' + (sess.write ? ' write' : ''); }
  syncMode();
  // Show Stop only while a prompt is in flight; let the rail/status reflect it too.
  sess.syncStop = () => { const running = sess.status === 'running' || sess.status === 'awaiting'; stopBtn.style.display = running ? '' : 'none'; };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
  const pane = el('div', { class: 'bench-pane' },
    el('div', { class: 'bench-head' },
      el('span', { class: 'bench-title', title: project.cwd || project.name }, project.name),
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, toggle,
        el('button', { class: 'modal-x', style: 'width:28px;height:28px', title: 'Close session', onclick: () => closeBenchSession(sess.id) }, '✕'))),
    body,
    el('div', { class: 'bench-input' }, el('div', { class: 'q-bar' }, ta, stopBtn, btn)));
  sess.paneEl = pane; sess.bodyEl = body; sess.taEl = ta;
  function stop() { if (sess.abort) { try { sess.abort.abort(); } catch { /* */ } } }
  function send() {
    const prompt = ta.value.trim();
    if (!prompt) return;
    if (body.querySelector('.empty')) body.innerHTML = '';
    body.append(chatBubble({ role: 'user', text: prompt }));
    const ans = el('div', { class: 'chat-msg cb-assistant' });
    const streamEl = el('div', { class: 'cb-stream' });
    const status = el('div', { class: 'cb-status' }, '⏳ launching…');
    ans.append(streamEl, status); body.append(ans); body.scrollTop = body.scrollHeight;
    ta.value = ''; btn.disabled = true; btn.textContent = '…';
    sess.abort = new AbortController();
    setBenchStatus(sess, 'running');
    streamContinue(project.id, sess.curSession, prompt, streamEl, status, body, btn, sess.write,
      (sid) => { sess.curSession = sid; saveBench(); }, (st) => setBenchStatus(sess, st), sess.abort.signal);
  }
  b.sessions.push(sess);
  if (saved && sess.curSession) loadBenchHistory(sess);
  saveBench();
  return sess;
}
function setBenchStatus(sess, status) {
  const changed = sess.status !== status;
  sess.status = status;
  if (state.bench.activeId !== sess.id && (status === 'awaiting' || status === 'done' || status === 'error')) sess.unread = true;
  if (sess.syncStop) sess.syncStop();
  refreshRail();
  if (changed) saveBench(); // dedupe the running→running stream spam
}
function closeBenchSession(id) {
  const b = ensureBench();
  const i = b.sessions.findIndex((s) => s.id === id);
  if (i === -1) return;
  // Stop an in-flight prompt so closing the pane doesn't leave claude running.
  const sess = b.sessions[i];
  if (sess && sess.abort) { try { sess.abort.abort(); } catch { /* */ } }
  b.sessions.splice(i, 1);
  if (b.activeId === id) b.activeId = b.sessions.length ? b.sessions[Math.min(i, b.sessions.length - 1)].id : null;
  saveBench();
  renderWorkbench();
}
function setActiveBench(id) {
  const b = ensureBench();
  b.activeId = id;
  const sess = b.sessions.find((s) => s.id === id);
  if (sess) sess.unread = false;
  saveBench();
  renderWorkbenchMain(); refreshRail();
  if (sess) setTimeout(() => sess.taEl && sess.taEl.focus(), 0);
}
function refreshRail() {
  const b = state.bench; if (!b || !b.railListEl) return;
  b.railListEl.innerHTML = '';
  if (!b.sessions.length) { b.railListEl.append(el('div', { class: 'q-hint', style: 'padding:12px' }, 'No sessions yet.')); return; }
  for (const s of b.sessions) {
    const meta = BENCH_STATUS[s.status] || BENCH_STATUS.idle;
    b.railListEl.append(el('div', { class: 'rail-item' + (s.id === b.activeId ? ' active' : '') + (s.unread ? ' unread' : ''), onclick: () => setActiveBench(s.id) },
      el('span', { class: 'rail-dot ' + meta.dot }),
      el('div', { class: 'rail-body' },
        el('div', { class: 'rail-name' }, s.project.name),
        el('div', { class: 'rail-status' }, (s.write ? '✏️ ' : '🔒 ') + meta.label)),
      el('button', { class: 'rail-x', title: 'Close', onclick: (e) => { e.stopPropagation(); closeBenchSession(s.id); } }, '✕')));
  }
}
// Per-app session lists for the workbench picker (full list lives on
// /api/project/:id, not the slim /api/overview). Cached so re-opening the form
// doesn't refetch.
const benchSessionCache = {};
function newSessionForm() {
  const local = ((state.overview && state.overview.projects) || []).filter((p) => p.cwd);
  const picker = el('select', { class: 'q-input', style: 'height:38px' },
    el('option', { value: '' }, '— pick an application —'),
    ...local.map((p) => el('option', { value: p.id }, p.name)));
  const sessPicker = el('select', { class: 'q-input', style: 'height:38px;margin-top:10px;display:none' });
  const writeChk = el('input', { type: 'checkbox', checked: 'checked' });

  function fillSessions(list) {
    sessPicker.innerHTML = '';
    sessPicker.append(el('option', { value: '' }, '✨ New session'));
    for (const s of (list || [])) {
      const label = (s.active ? '🟢 ' : '') + (s.title || '(untitled)').slice(0, 48) + ' · ' + ago(s.mtime);
      sessPicker.append(el('option', { value: s.id }, label));
    }
    sessPicker.style.display = '';
  }
  async function loadSessions(id) {
    sessPicker.style.display = 'none';
    if (!id) return;
    if (benchSessionCache[id]) { fillSessions(benchSessionCache[id]); return; }
    sessPicker.innerHTML = ''; sessPicker.append(el('option', {}, 'loading sessions…')); sessPicker.style.display = '';
    try {
      const p = await api('/api/project/' + encodeURIComponent(id));
      const list = (p && Array.isArray(p.sessions)) ? p.sessions : [];
      benchSessionCache[id] = list;
      if (picker.value === id) fillSessions(list); // ignore if user switched apps meanwhile
    } catch { fillSessions([]); }
  }
  picker.addEventListener('change', () => loadSessions(picker.value));

  const open = el('button', { class: 'btn', style: 'width:100%', onclick: () => {
    const p = local.find((x) => x.id === picker.value);
    if (!p) return;
    const b = ensureBench();
    const project = { id: p.id, name: p.name, cwd: p.cwd };
    const sid = sessPicker.value;
    const sess = sid
      ? buildBenchSession(project, writeChk.checked, { curSession: sid, status: 'idle' })
      : buildBenchSession(project, writeChk.checked);
    b.activeId = sess.id;
    saveBench();
    renderWorkbench();
  } }, '+ Open session');
  return el('div', { class: 'newform' },
    picker,
    sessPicker,
    el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:12.5px;margin:10px 0' }, writeChk, '✏️ write mode (edits gated by approvals)'),
    open);
}
function benchEmpty() {
  const local = ((state.overview && state.overview.projects) || []).filter((p) => p.cwd);
  if (!local.length) return el('div', { class: 'empty' }, el('div', { class: 'big' }, '🛠️'), 'No apps with a local folder yet — create one in Settings → New Project.');
  return el('div', { class: 'bench-empty' },
    el('div', { style: 'font-size:40px' }, '🛠️'),
    el('div', { style: 'font-weight:800;font-size:17px;margin:8px 0 4px' }, 'Workbench'),
    el('div', { class: 'muted', style: 'margin-bottom:20px;max-width:340px;text-align:center' }, 'Run many Claude Code sessions at once. Each keeps working while you focus another. Pick an app to start.'),
    el('div', { style: 'width:300px' }, newSessionForm()));
}
function renderWorkbenchMain() {
  const b = state.bench; if (!b || !b.mainEl) return;
  const sess = b.sessions.find((s) => s.id === b.activeId);
  if (!sess) { b.mainEl.replaceChildren(benchEmpty()); return; }
  b.mainEl.replaceChildren(sess.paneEl);
  setTimeout(() => { sess.bodyEl.scrollTop = sess.bodyEl.scrollHeight; }, 0);
}
function renderWorkbench() {
  $('#crumb').textContent = 'Workbench';
  const v = $('#view'); v.innerHTML = '';
  const b = ensureBench();
  if (!b.activeId && b.sessions.length) b.activeId = b.sessions[0].id;
  const railList = el('div', { class: 'bench-rail-list' });
  const newHost = el('div', { class: 'bench-newform' });
  const toggleNew = () => { newHost.replaceChildren(newHost.childElementCount ? '' : newSessionForm()); };
  const rail = el('div', { class: 'bench-rail' },
    el('div', { class: 'bench-rail-head' },
      el('span', {}, 'Sessions ', el('span', { class: 'muted' }, String(b.sessions.length))),
      el('button', { class: 'btn ghost', style: 'padding:5px 11px;font-size:12px', onclick: toggleNew }, '+ New')),
    newHost, railList);
  const main = el('div', { class: 'bench-main' });
  v.append(el('div', { class: 'bench-shell' }, rail, main));
  b.railListEl = railList; b.mainEl = main;
  refreshRail();
  renderWorkbenchMain();
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

  // per-workspace approval mode
  if (p.cwd) { const gw = await api('/api/gateway'); v.append(approvalModeCard(p, gw)); }

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
    el('div', { class: 'approve-actions' },
      el('button', { class: 'btn', style: 'padding:7px 12px', onclick: () => decide(p.id, 'allow') }, '✓ Allow once'),
      el('button', { class: 'btn ghost', style: 'padding:7px 12px', title: 'Always allow this workspace from now on', onclick: () => alwaysAllow({ project: p.cwd, id: p.id }) }, '✓ Always this app'),
      el('button', { class: 'btn ghost', style: 'padding:7px 12px', title: 'Always allow every workspace from now on', onclick: () => alwaysAllow({ autoAll: true, id: p.id }) }, '✓✓ Always all'),
      el('button', { class: 'btn ghost', style: 'padding:7px 12px', onclick: () => decide(p.id, 'deny') }, '✕ Deny'))));
}

async function decide(id, decision) {
  let reason;
  if (decision === 'deny') reason = prompt('Reason for denial (optional — shown to Claude):') || undefined;
  await api('/api/approval-decide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, decision, reason }) });
  pollPending();
}

async function setGateway(patch) {
  return api('/api/gateway', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
}
// Turn on always-allow (per workspace or globally) and clear the pending call.
async function alwaysAllow({ project, autoAll, id }) {
  if (autoAll) await setGateway({ autoAll: true });
  else if (project) await setGateway({ project, mode: 'auto' });
  if (id) await api('/api/approval-decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, decision: 'allow' }) });
  renderApprovals();
}

function approvalModeCard(p, gw) {
  if (!p.cwd) return null;
  const locked = gw.autoAll;
  const mode = locked ? 'auto' : ((gw.projectMode && gw.projectMode[p.cwd]) || 'manual');
  const opt = (val, label, desc) => el('button', {
    class: 'mode-opt' + (mode === val ? ' on' : ''), ...(locked ? { disabled: 'disabled' } : {}),
    onclick: () => setGateway({ project: p.cwd, mode: val }).then(() => renderProject(p.id)),
  }, el('div', { class: 'mo-t' }, label), el('div', { class: 'mo-d' }, desc));
  return el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, '🛡️ Approvals for this workspace',
      el('span', { class: 'muted' }, gw.enabled ? '' : 'gateway is OFF')),
    el('div', { class: 'mode-opts' },
      opt('manual', 'Manual', 'Ask me on the dashboard each time'),
      opt('auto', 'Always allow', 'Auto-approve Edit / Write / Bash here')),
    locked ? el('div', { class: 'q-hint', style: 'margin-top:10px' }, '“Always allow everything” is ON globally — it overrides this. Turn it off on the Approvals screen to set per-workspace.') : null);
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
        g.enabled ? '● Gateway ON' : '○ Gateway OFF')),
    g.enabled ? el('div', { class: 'mode-row' },
      el('div', {},
        el('div', { style: 'font-weight:600;font-size:13px' }, 'Always allow everything'),
        el('div', { style: 'font-size:12px;color:var(--muted)' }, 'Auto-approve every Edit/Write/Bash across all workspaces — no prompts.')),
      el('button', { class: 'btn ' + (g.autoAll ? '' : 'ghost'), style: 'padding:7px 14px', onclick: () => setGateway({ autoAll: !g.autoAll }).then(renderApprovals) },
        g.autoAll ? '● ON' : '○ OFF')) : null));

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

async function inviteCard() {
  const data = await api('/api/auth/invite').catch(() => ({ invites: [] }));
  const list = el('div', { id: 'inviteList', style: 'margin-top:14px;display:flex;flex-direction:column;gap:8px' });
  const render = (invites) => {
    list.innerHTML = '';
    if (!invites.length) { list.append(el('div', { class: 'q-hint' }, 'No invite codes yet.')); return; }
    for (const i of invites.slice().reverse()) {
      list.append(el('div', { class: 'rule' },
        el('code', { style: i.used ? 'opacity:.5;text-decoration:line-through' : '' }, i.code),
        el('span', { class: 'muted', style: 'font-size:11px' }, i.used ? 'used' : 'unused')));
    }
  };
  render(data.invites || []);
  const msg = el('div', { style: 'font-size:12.5px;margin-top:10px;color:var(--good)' });
  return el('div', { class: 'card fade-in', style: 'max-width:640px;margin-top:18px' },
    el('div', { class: 'card-title' }, '🎟️ Invite Codes'),
    el('p', { style: 'color:var(--muted);font-size:13px;margin-bottom:12px;line-height:1.6' },
      'New people need a valid invite code to sign up. Generate one and share it — each code works once.'),
    el('button', { class: 'btn', onclick: async () => {
      const r = await api('/api/auth/invite', { method: 'POST' });
      if (r && r.ok) {
        msg.textContent = '✓ New code: ' + r.code + '  (copied)';
        try { await navigator.clipboard.writeText(r.code); } catch { /* clipboard may be blocked */ }
        const fresh = await api('/api/auth/invite').catch(() => ({ invites: [] }));
        render(fresh.invites || []);
      }
    } }, '+ Generate invite code'),
    msg, list);
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

  v.append(await inviteCard());

  const mc = await machinesCard();
  if (mc) v.append(mc);

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

// ---- machines card (broker only) -------------------------------------------
async function machinesCard() {
  let r; try { r = await api('/api/machines'); } catch { r = null; }
  if (!r || !r.ok || !Array.isArray(r.machines)) return null; // local agent → no card
  state.machines = r.machines;
  const list = el('div', { id: 'machineList', style: 'margin-top:6px' });
  const out = el('div', { id: 'connectOut', style: 'margin-top:12px' });
  const renderList = (ms) => {
    list.innerHTML = '';
    if (!ms.length) { list.append(el('div', { class: 'empty' }, 'No machines yet. Add one below.')); return; }
    for (const m of ms) {
      list.append(el('div', { class: 'rule' },
        el('span', {},
          el('span', { class: m.connected ? 'chip-dot' : 'chip-dot off' }), '  ', m.name,
          m.connected ? null : el('span', { style: 'color:var(--muted);font-size:11px;margin-left:8px' }, 'offline'),
          m.agentId === state.machineId ? el('span', { style: 'color:var(--neon2);font-size:11px;margin-left:8px' }, 'viewing') : null),
        el('span', {},
          el('button', { class: 'rm', title: 'Rename', onclick: () => renameMachine(m, renderList) }, '✎'),
          el('button', { class: 'rm', title: 'Remove', onclick: () => removeMachine(m, renderList) }, '✕'))));
    }
  };
  renderList(r.machines);
  return el('div', { class: 'card fade-in', style: 'max-width:640px;margin-top:18px' },
    el('div', { class: 'card-title' }, 'Your machines'),
    el('p', { style: 'color:var(--muted);font-size:13px;margin-bottom:6px;line-height:1.6' },
      'Each machine runs the Vibe Center agent and bridges to your account. Add as many as you like — switch between them from the sidebar.'),
    list,
    el('button', { class: 'btn', style: 'margin-top:14px', onclick: () => addMachine(out, renderList) }, '+ Add a machine'),
    out);
}
async function addMachine(out, renderList) {
  const name = (prompt('Name this machine (e.g. "Laptop", "Work desktop")', 'New machine') || '').trim();
  if (!name) return;
  const r = await api('/api/machines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!r || !r.ok) { out.textContent = 'Could not create the machine.'; return; }
  const fresh = await api('/api/machines'); state.machines = fresh.machines; renderList(fresh.machines); renderMachineSwitcher();
  out.innerHTML = '';
  out.append(el('div', { style: 'color:var(--muted);font-size:13px;line-height:1.7' },
    'On ', el('strong', {}, r.name), ', start the agent (', el('code', {}, 'npm start'), '), then run the bridge with this one-time token:',
    el('div', { style: 'margin:10px 0;padding:12px 14px;background:rgba(0,0,0,.3);border-radius:10px;font-family:monospace;color:var(--neon2);word-break:break-all' },
      'node broker/connect.mjs ' + r.token),
    el('div', { style: 'color:var(--warn);font-size:12px' }, 'Copy it now — the token is shown only once.')));
}
async function renameMachine(m, renderList) {
  const name = (prompt('Rename machine', m.name) || '').trim();
  if (!name) return;
  await api('/api/machines/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: m.agentId, name }) });
  const fresh = await api('/api/machines'); state.machines = fresh.machines; renderList(fresh.machines); renderMachineSwitcher();
}
async function removeMachine(m, renderList) {
  if (!confirm(`Remove "${m.name}"? Its pairing token stops working and it disconnects.`)) return;
  await api('/api/machines/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: m.agentId }) });
  if (state.machineId === m.agentId) state.machineId = null;
  const fresh = await api('/api/machines'); state.machines = fresh.machines;
  if (!state.machineId) { const c = fresh.machines.find((x) => x.connected) || fresh.machines[0]; state.machineId = c ? c.agentId : null; }
  renderList(fresh.machines); renderMachineSwitcher();
}

async function saveToken() {
  const val = $('#ghToken').value.trim();
  if (!val) return;
  await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ githubToken: val }) });
  renderSettings();
}

// ---- fleet: every computer + its apps, grouped by GitHub repo --------------
const OS_ICON = { darwin: '', win32: '⊞', linux: '🐧' };
const OS_NAME = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

// Like api(), but pinned to a specific machine (or the local agent when null) —
// the fleet view queries every machine, not just the active one.
async function apiFor(path, agentId, opts) {
  opts = opts || {};
  if (agentId) opts.headers = { ...(opts.headers || {}), 'X-CC-Machine': agentId };
  const res = await fetch(path, opts);
  if (res.status === 401 && !path.startsWith('/api/auth/')) { lockApp(); throw new Error('unauthorized'); }
  return res.json();
}

async function renderFleet() {
  $('#crumb').textContent = 'Fleet';
  const v = $('#view');
  v.innerHTML = '<div class="empty"><div class="big">🖥️</div>Scanning your computers…</div>';
  await loadMachines(); // refresh connectivity before we fan out
  const machines = (state.machines && state.machines.length)
    ? state.machines
    : [{ agentId: null, name: 'This machine', connected: true }];

  const results = await Promise.all(machines.map(async (m) => {
    if (!m.connected) return { machine: m, os: null, apps: [], offline: true };
    try { const r = await apiFor('/api/fleet-apps', m.agentId); return { machine: m, os: r.os, host: r.host, apps: r.apps || [] }; }
    catch { return { machine: m, os: null, apps: [], error: true }; }
  }));
  if (state.view !== 'fleet') return; // navigated away mid-load
  v.innerHTML = '';

  // connected-computers strip
  const strip = el('div', { class: 'fleet-machines' });
  for (const r of results) {
    strip.append(el('div', { class: 'fleet-machine' + (r.machine.connected ? '' : ' off') },
      el('span', { class: 'chip-dot' + (r.machine.connected ? '' : ' off') }),
      el('span', { class: 'fm-os' }, OS_ICON[r.os] || '🖥️'),
      el('div', { class: 'fm-body' },
        el('div', { class: 'fm-name' }, r.machine.name),
        el('div', { class: 'fm-sub' }, r.offline ? 'offline'
          : r.error ? 'unreachable'
          : `${OS_NAME[r.os] || '—'} · ${r.apps.length} app${r.apps.length === 1 ? '' : 's'}`))));
  }
  const online = results.filter((r) => r.machine.connected).length;
  v.append(el('div', { class: 'card fade-in' },
    el('div', { class: 'card-title' }, 'Connected computers', el('span', { class: 'muted' }, `${online} online`)),
    strip));

  // group apps across machines by GitHub repo (fallback: by name)
  const groups = new Map();
  for (const r of results) {
    for (const app of r.apps) {
      const key = app.github ? 'gh:' + app.github.toLowerCase() : 'name:' + (app.name || app.id).toLowerCase();
      if (!groups.has(key)) groups.set(key, { key, github: app.github, name: app.name, stack: app.stack, stackLabel: app.stackLabel, ios: false, android: false, instances: [] });
      const g = groups.get(key);
      g.instances.push({ machine: r.machine, os: r.os, app });
      g.ios = g.ios || app.ios; g.android = g.android || app.android;
      if (!g.github && app.github) g.github = app.github;
      if (!g.stackLabel && app.stackLabel) { g.stack = app.stack; g.stackLabel = app.stackLabel; }
    }
  }
  // shared-across-computers first, then by name
  const list = [...groups.values()].sort((a, b) => {
    const sa = new Set(a.instances.map((i) => i.machine.agentId)).size;
    const sb = new Set(b.instances.map((i) => i.machine.agentId)).size;
    return (sb - sa) || a.name.localeCompare(b.name);
  });

  v.append(el('div', { class: 'nav-label', style: 'margin:20px 0 8px' }, 'Applications'));
  const wrap = el('div', { class: 'fleet-apps' });
  for (const g of list) wrap.append(fleetAppCard(g));
  v.append(wrap.childElementCount ? wrap
    : el('div', { class: 'empty' }, 'No applications found on your connected computers.'));
}

function fleetAppCard(g) {
  const shared = new Set(g.instances.map((i) => i.machine.agentId)).size > 1;
  const card = el('div', { class: 'card fade-in fleet-app' + (shared ? ' shared' : '') });

  const badges = el('div', { class: 'fa-badges' });
  if (shared) badges.append(el('span', { class: 'chip', style: 'color:var(--neon2)' }, '⇄ shared'));
  if (g.stackLabel) badges.append(el('span', { class: 'chip' }, g.stackLabel));
  if (g.ios) badges.append(el('span', { class: 'chip platform' }, ' iOS'));
  if (g.android) badges.append(el('span', { class: 'chip platform' }, '🤖 Android'));
  card.append(el('div', { class: 'fa-head' },
    el('div', {},
      el('div', { class: 'fa-name' }, g.name),
      g.github
        ? el('a', { class: 'chip gh', href: 'https://github.com/' + g.github, target: '_blank' }, g.github)
        : el('span', { class: 'chip local' }, 'local only')),
    badges));

  // which computers have this app
  const chips = el('div', { class: 'fa-machines' });
  for (const inst of g.instances) {
    chips.append(el('span', { class: 'fa-mchip' + (inst.machine.connected ? '' : ' off'), title: inst.app.cwd || '' },
      el('span', { class: 'chip-dot' + (inst.machine.connected ? '' : ' off') }),
      (OS_ICON[inst.os] || '🖥️') + ' ' + inst.machine.name,
      inst.app.liveCount ? el('span', { class: 'fa-live' }, ' ● live') : null));
  }
  card.append(chips);

  // one-click build actions, routed to the right computer
  const actions = el('div', { class: 'fa-actions' });
  if (g.ios) {
    const mac = g.instances.find((i) => i.os === 'darwin' && i.machine.connected);
    actions.append(buildBtn('  Build iOS', mac, g, 'ios',
      'Connect a macOS computer that has this repo to build iOS'));
  }
  if (g.android) {
    const tgt = g.instances.find((i) => i.machine.connected);
    actions.append(buildBtn('🤖 Build Android', tgt, g, 'android',
      'No connected computer has this repo'));
  }
  if (actions.childElementCount) card.append(actions);
  return card;
}

function buildBtn(label, inst, g, platform, disabledTitle) {
  if (!inst) return el('button', { class: 'btn ghost', disabled: 'true', title: disabledTitle }, label + ' · unavailable');
  return el('button', { class: 'btn', title: 'Build on ' + inst.machine.name, onclick: () => runBuild(inst, g, platform) },
    label + ' · ' + inst.machine.name);
}

const BUILD_PROMPT = {
  ios: 'Build the iOS app for this project. Detect the toolchain from the project files (Expo/EAS, React Native, Flutter, or native Xcode) and run the appropriate command to produce an iOS build. Resolve dependencies first if needed (e.g. npm/yarn install, pod install). If code signing, a provisioning profile, or a simulator/device is required, state exactly what is missing instead of guessing. When finished, print the path to the resulting .app or .ipa.',
  android: 'Build the Android app for this project. Detect the toolchain from the project files (Expo/EAS, React Native, Flutter, or native Gradle) and run the appropriate command to produce a release APK or AAB. Resolve dependencies first if needed. When finished, print the path to the resulting .apk or .aab.',
};

async function runBuild(inst, g, platform) {
  const status = el('div', { class: 'q-status' }, '⏳ launching Claude on ' + inst.machine.name + '…');
  const log = el('div', { class: 'q-answer build-log' });
  const overlay = el('div', { class: 'auth-overlay', id: 'buildModal' },
    el('div', { class: 'auth-card build-card' },
      el('div', { class: 'auth-title' }, (platform === 'ios' ? '  iOS' : '🤖 Android') + ' build · ' + g.name),
      el('div', { class: 'auth-sub' }, 'on ' + inst.machine.name + (OS_NAME[inst.os] ? ' (' + OS_NAME[inst.os] + ')' : '') + ' · each command is gated by your approvals settings'),
      status, log,
      el('div', { style: 'display:flex;justify-content:flex-end;margin-top:12px' },
        el('button', { class: 'btn ghost', onclick: () => overlay.remove() }, 'Close'))));
  document.body.append(overlay);

  let acc = '';
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (inst.machine.agentId) headers['X-CC-Machine'] = inst.machine.agentId;
    const res = await fetch('/api/query', { method: 'POST', headers,
      body: JSON.stringify({ project: inst.app.id, prompt: BUILD_PROMPT[platform], write: true }) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); status.textContent = '✕ ' + (e.error || ('HTTP ' + res.status)); return; }
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
        if (ev.type === 'started') status.textContent = '🤖 ' + (ev.model || 'Claude') + ' · building…';
        else if (ev.type === 'tool') status.textContent = '🔧 ' + ev.tool + (ev.input && ev.input.command ? ' · ' + String(ev.input.command).slice(0, 90) : '') + '…';
        else if (ev.type === 'tool_result') { acc += (acc ? '\n' : '') + String(ev.output || '').slice(0, 4000); log.textContent = acc; log.scrollTop = log.scrollHeight; }
        else if (ev.type === 'text') { acc += (acc ? '\n\n' : '') + ev.text; log.textContent = acc; log.scrollTop = log.scrollHeight; }
        else if (ev.type === 'stderr' || ev.type === 'error') status.textContent = '⚠ ' + ev.text;
        else if (ev.type === 'done') status.textContent = ev.error ? '✕ build failed' : ('✓ done' + (ev.durationMs ? ' · ' + (ev.durationMs / 1000).toFixed(1) + 's' : ''));
      }
    }
  } catch (e) { status.textContent = '✕ ' + e.message; }
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
  else if (view === 'fleet') renderFleet();
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

// Auto-reload the desktop window when the UI assets change on disk, so the
// local app always reflects the latest build without a manual hard-reload.
let __build = null;
async function checkForUpdate() {
  try {
    const h = await api('/api/health');
    if (__build == null) { __build = h.build; return; }
    if (h.build && h.build !== __build) location.reload();
  } catch { /* server blip */ }
}

// ---- machines (one account, many computers) --------------------------------
// Only meaningful behind the broker; the local agent answers /api/machines with
// a 404 ('unknown endpoint'), which we treat as "single local machine".
async function loadMachines() {
  let r; try { r = await api('/api/machines'); } catch { r = null; }
  if (!r || !r.ok || !Array.isArray(r.machines)) { state.machines = null; state.machineId = null; renderMachineSwitcher(); return; }
  state.machines = r.machines;
  const ids = r.machines.map((m) => m.agentId);
  if (!state.machineId || !ids.includes(state.machineId)) {
    const conn = r.machines.find((m) => m.connected);
    state.machineId = (conn || r.machines[0] || {}).agentId || null;
  }
  renderMachineSwitcher();
}
function renderMachineSwitcher() {
  const old = $('#machineRow'); if (old) old.remove();
  // Hide the picker when there's nothing to switch between (local or single machine).
  if (!state.machines || state.machines.length < 2) return;
  const sel = el('select', { class: 'machine-select', onchange: (e) => switchMachine(e.target.value) },
    ...state.machines.map((m) => el('option', { value: m.agentId }, (m.connected ? '● ' : '○ ') + m.name)));
  sel.value = state.machineId || '';
  const row = el('div', { id: 'machineRow', class: 'machine-row' }, el('span', { class: 'machine-label' }, 'Machine'), sel);
  const foot = $('.sidebar-footer');
  if (foot) foot.insertAdjacentElement('beforebegin', row);
}
function switchMachine(agentId) {
  if (agentId === state.machineId) return;
  state.machineId = agentId;
  refresh();
  if (state.view) navView(state.view);
}

// ---- auth gate -------------------------------------------------------------
function closeAuthGate() { const g = $('#authGate'); if (g) g.remove(); }
function lockApp() {
  if ($('#authGate')) return;
  clearInterval(state.refreshTimer); clearInterval(state.updateTimer); clearInterval(state.approvalsTimer);
  fetch('/api/auth/status').then((r) => r.json()).then(renderAuthGate).catch(() => renderAuthGate({ hasUsers: true }));
}
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
}
function setOwnerFooter(user) {
  const foot = $('.sidebar-footer');
  if (!foot || $('#ownerRow')) return;
  foot.insertAdjacentElement('beforebegin', el('div', { id: 'ownerRow', class: 'owner-row' },
    el('span', { class: 'owner-email', title: user.email }, user.email),
    el('button', { class: 'owner-logout', onclick: logout, title: 'Sign out' }, 'Sign out')));
}
function renderAuthGate(status, mode) {
  closeAuthGate();
  // First run with no accounts → default to signup; otherwise sign in. Toggleable.
  const isRegister = (mode || (status.hasUsers ? 'login' : 'register')) === 'register';
  const email = el('input', { type: 'email', class: 'q-input', placeholder: 'you@example.com', autocomplete: 'username' });
  const pass = el('input', { type: 'password', class: 'q-input', placeholder: isRegister ? 'Choose a password (8+ characters)' : 'Password', autocomplete: isRegister ? 'new-password' : 'current-password' });
  // Invite required for everyone after the first owner account.
  const needsInvite = isRegister && status.hasUsers;
  const invite = el('input', { type: 'text', class: 'q-input', placeholder: 'INVITE CODE', autocomplete: 'off', style: 'text-transform:uppercase' });
  const msg = el('div', { class: 'auth-msg' });
  const btn = el('button', { class: 'btn', style: 'width:100%;margin-top:14px', onclick: submit }, isRegister ? 'Create account' : 'Sign in');
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  invite.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  const toggle = el('div', { class: 'auth-toggle' },
    isRegister ? 'Already have an account? ' : 'New here? ',
    el('a', { class: 'auth-link', onclick: () => renderAuthGate(status, isRegister ? 'login' : 'register') },
      isRegister ? 'Sign in' : 'Create an account'));
  const card = el('div', { class: 'auth-card' },
    el('div', { class: 'auth-brand' }, '⚡'),
    el('div', { class: 'auth-title' }, isRegister ? 'Create your account' : 'Welcome back'),
    el('div', { class: 'auth-sub' }, isRegister
      ? 'Sign up to access your Vibe Center from any device.'
      : 'Sign in to your Vibe Center.'),
    el('div', { class: 'field' },
      el('label', {}, 'Email'), email,
      el('label', { style: 'margin-top:10px' }, 'Password'), pass,
      needsInvite ? el('label', { style: 'margin-top:10px' }, 'Invite code') : null,
      needsInvite ? invite : null),
    btn, msg, toggle);
  const overlay = el('div', { class: 'auth-overlay', id: 'authGate' }, card);
  document.body.append(overlay);
  email.focus();
  async function submit() {
    if (!email.value.trim() || !pass.value) { msg.textContent = 'Enter your email and password.'; return; }
    btn.disabled = true; btn.textContent = '…';
    const r = await api('/api/auth/' + (isRegister ? 'register' : 'login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim(), password: pass.value, invite: invite.value.trim() }),
    }).catch(() => ({ error: 'network error' }));
    if (!r || !r.ok) { msg.textContent = '✕ ' + ((r && r.error) || 'Failed'); btn.disabled = false; btn.textContent = isRegister ? 'Create account' : 'Sign in'; return; }
    closeAuthGate();
    boot();
  }
}

async function boot() {
  let status;
  try { status = await api('/api/auth/status'); } catch { status = { hasUsers: false, user: null }; }
  if (!status.user) { renderAuthGate(status); return; }
  setOwnerFooter(status.user);
  await loadMachines();
  await refresh();
  navView('overview');
  clearInterval(state.refreshTimer); state.refreshTimer = setInterval(refresh, 5000);
  checkForUpdate();
  clearInterval(state.updateTimer); state.updateTimer = setInterval(checkForUpdate, 4000);
}

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => navView(b.dataset.view)));
boot();
