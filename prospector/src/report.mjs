import fs from 'node:fs';
import path from 'node:path';
import { ensureOut, toCsv } from './util.mjs';

export const CSV_COLUMNS = [
  'rank', 'tier', 'score', 'status', 'name', 'category', 'address', 'phone', 'email', 'website',
  'issues', 'pitch', 'mobile_screenshot', 'desktop_screenshot', 'id',
];

export function toRow(p, i) {
  return {
    rank: i + 1,
    tier: p.tier,
    score: p.score,
    status: p.status,
    name: p.name,
    category: p.category,
    address: p.address,
    phone: p.phone,
    email: p.email,
    website: p.website,
    issues: p.issues.map((x) => x.label).join(' | '),
    pitch: p.issues.slice(0, 3).map((x) => x.pitch).join('; '),
    mobile_screenshot: p.mobileShot || '',
    desktop_screenshot: p.desktopShot || '',
    id: p.id,
  };
}

export function writeCsv(prospects) {
  const dir = ensureOut();
  const rows = prospects.map(toRow);
  fs.writeFileSync(path.join(dir, 'prospects.csv'), toCsv(rows, CSV_COLUMNS));
  return rows.length;
}

// Embedded in a <script type="application/json"> block: escaping "<" is enough to stop "</script>" breakouts.
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

export function writeHtml(prospects, stats = {}) {
  const dir = ensureOut();
  const data = prospects.map((p, i) => ({
    rank: i + 1, tier: p.tier, score: p.score, status: p.status, name: p.name, category: p.category,
    address: p.address, phone: p.phone, email: p.email, website: p.website,
    issues: p.issues.map((x) => ({ label: x.label, pts: x.pts })),
    m: p.mobileShot || '', d: p.desktopShot || '',
  }));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Denver Website Prospects</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--mut:#78716c;--card:#fff;--line:#e7e5e4;--hot:#dc2626;--warm:#d97706;--cold:#65a30d;--acc:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--mut:#a8a29e;--card:#1c1917;--line:#292524;--acc:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{padding:20px 16px 8px;max-width:1100px;margin:auto}h1{margin:0 0 4px;font-size:22px}.sub{color:var(--mut)}
.bar{max-width:1100px;margin:auto;padding:8px 16px;display:flex;gap:8px;flex-wrap:wrap;position:sticky;top:0;background:var(--bg);z-index:2}
input,select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}input{flex:1;min-width:180px}
main{max-width:1100px;margin:auto;padding:8px 16px 60px;display:grid;gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;display:grid;grid-template-columns:1fr auto;gap:12px}
.top{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.name{font-weight:650;font-size:17px}
.badge{font-size:12px;font-weight:650;padding:2px 8px;border-radius:99px;color:#fff}.hot{background:var(--hot)}.warm{background:var(--warm)}.cold{background:var(--cold)}.none{background:var(--mut)}
.meta{color:var(--mut);font-size:13px;margin:2px 0 8px}a{color:var(--acc)}ul{margin:6px 0 0;padding-left:18px}li{margin:1px 0}.pts{color:var(--mut);font-size:12px}
.shots{display:flex;gap:8px;align-items:flex-start}.shots img{border:1px solid var(--line);border-radius:6px;display:block}.shots .m{width:84px}.shots .d{width:180px}
@media(max-width:700px){.card{grid-template-columns:1fr}.shots .d{display:none}}
.empty{color:var(--mut);padding:30px;text-align:center}
</style></head><body>
<header><h1>Denver website prospects</h1>
<div class="sub">${stats.total ?? prospects.length} businesses scored &middot; generated ${new Date().toISOString().slice(0, 10)} &middot; higher score = bigger opportunity</div></header>
<div class="bar"><input id="q" placeholder="Search name, category, address, issue…" type="search">
<select id="tier"><option value="">All tiers</option><option>hot</option><option>warm</option><option>cold</option></select>
<select id="status"><option value="">All statuses</option></select>
<select id="has"><option value="">Any contact</option><option value="email">Has email</option><option value="phone">Has phone</option></select></div>
<main id="list"></main>
<script id="data" type="application/json">${safeJson(data)}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent);
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const li=(a)=>a.map(i=>'<li>'+esc(i.label)+' <span class="pts">+'+i.pts+'</span></li>').join('');
const safeUrl=(u)=>/^https?:\\/\\//i.test(u)?u:'';
for(const s of [...new Set(D.map(x=>x.status))].sort()) $('status').insertAdjacentHTML('beforeend','<option>'+esc(s)+'</option>');
function render(){
  const q=$('q').value.toLowerCase(),t=$('tier').value,s=$('status').value,h=$('has').value;
  const rows=D.filter(x=>(!t||x.tier===t)&&(!s||x.status===s)&&(!h||(h==='email'?x.email:x.phone))&&
    (!q||(x.name+' '+x.category+' '+x.address+' '+x.issues.map(i=>i.label).join(' ')).toLowerCase().includes(q))).slice(0,300);
  $('list').innerHTML=rows.length?rows.map(x=>{
    const w=safeUrl(x.website);
    return '<div class="card"><div><div class="top"><span class="name">#'+x.rank+' '+esc(x.name)+'</span><span class="badge '+esc(x.tier)+'">'+esc(x.tier)+' '+x.score+'</span></div>'+
    '<div class="meta">'+esc(x.category)+' &middot; '+esc(x.address||'no address')+' &middot; '+esc(x.status)+'<br>'+
    (w?'<a href="'+esc(w)+'" target="_blank" rel="noopener noreferrer">'+esc(w)+'</a>':'no website')+
    (x.phone?' &middot; '+esc(x.phone):'')+(x.email?' &middot; '+esc(x.email):'')+'</div>'+
    '<ul>'+li(x.issues.slice(0,6))+'</ul>'+(x.issues.length>6?'<details><summary class="pts">+'+(x.issues.length-6)+' more issues</summary><ul>'+li(x.issues.slice(6))+'</ul></details>':'')+'</div>'+
    '<div class="shots">'+(x.m?'<img class="m" loading="lazy" src="'+esc(x.m)+'" alt="mobile">':'')+(x.d?'<img class="d" loading="lazy" src="'+esc(x.d)+'" alt="desktop">':'')+'</div></div>';
  }).join(''):'<div class="empty">No matches.</div>';
}
for(const id of ['q','tier','status','has']) $(id).addEventListener('input',render);
render();
</script></body></html>`;
  fs.writeFileSync(path.join(dir, 'report.html'), html);
}
