import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { costFor } from './pricing.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // file touched in last 10 min = "live"
// A running Task/Agent-tool subagent writes its own transcript at
// <projectDir>/<sessionId>/subagents/**/agent-*.jsonl (nested one level deeper
// under subagents/workflows/<id>/ for Workflow-tool runs), separate from the
// parent session's own .jsonl. Those files ARE parsed for usage (they carry
// nearly half of real spend); the time gate below bounds how long we keep
// re-walking them for signature/liveness purposes.
const SUBAGENT_SCAN_WINDOW_MS = 3 * 60 * 60 * 1000;

// Parse cache: avoid re-reading a transcript whose mtime+size are unchanged.
const cache = new Map(); // file -> { sig, data }

function readJsonLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip partial line */ }
  }
  return out;
}

function emptyUsage() {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0,
    cacheCreation5m: 0, cacheCreation1h: 0, thinking: 0 };
}

// Local-time day key, matching the Account view's bucketing (isoDay) so the
// Overview and Account charts agree on what "a day" is.
function localDay(epochMs) {
  const d = new Date(epochMs);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function addUsage(target, u) {
  if (!u) return;
  target.input += u.input_tokens || 0;
  target.output += u.output_tokens || 0;
  target.cacheCreation += u.cache_creation_input_tokens || 0;
  target.cacheRead += u.cache_read_input_tokens || 0;
  const cc = u.cache_creation || {};
  target.cacheCreation5m += cc.ephemeral_5m_input_tokens || 0;
  target.cacheCreation1h += cc.ephemeral_1h_input_tokens || 0;
  target.thinking += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
}

// Meta / injected user entries we don't want to count or show as chat.
const META_RE = /^<(command|local-command|system-reminder|user-prompt-submit|bash-|task-notification)/i;

function userTextOf(message) {
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const t = c.find((b) => b.type === 'text');
    return t ? String(t.text) : '';
  }
  return '';
}

function parseSession(file) {
  const stat = fs.statSync(file);
  const sig = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(file);
  if (hit && hit.sig === sig) return hit.data;

  const lines = readJsonLines(file);
  const id = path.basename(file, '.jsonl');

  let cwd = null;
  let gitBranch = null;
  let title = null;
  let firstUserText = null;
  let firstTs = null;
  let lastTs = null;
  let userMessages = 0;
  let assistantMessages = 0;
  let cliVersion = null;
  const perModel = {}; // model -> { usage, cost, msgs, fastTokens, fastMsgs, webSearch, webFetch, effort: {level: msgs} }
  const dailyTokens = {}; // local YYYY-MM-DD -> token count
  const dailyCost = {};   // local YYYY-MM-DD -> cost
  const dailyModel = {};  // local YYYY-MM-DD -> { model: token count }
  const dailyModelCost = {}; // local YYYY-MM-DD -> { model: cost }
  const toolBreakdown = {}; // tool name -> count
  const msgTimes = []; // per deduped assistant API response
  const assistantById = new Map(); // message.id -> best usage-bearing copy
  const blocksById = new Map();    // message.id -> Map(toolUseKey -> tool name)

  for (const o of lines) {
    if (o.cwd) cwd = o.cwd;
    if (o.gitBranch && o.gitBranch !== 'HEAD') gitBranch = o.gitBranch;
    if (o.type === 'ai-title' && o.title) title = o.title;
    if (o.version) cliVersion = o.version;

    const ts = o.timestamp;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }

    if (o.type === 'user' && o.message) {
      const text = (userTextOf(o.message) || '').trim();
      // Count only genuine human messages — tool_result carriers and injected
      // meta lines (<command…>, <system-reminder…>) are not "user messages".
      if (text && !META_RE.test(text)) {
        userMessages++;
        if (!firstUserText) firstUserText = text.slice(0, 120);
      }
    }

    if (o.type === 'assistant' && o.message) {
      const key = o.message.id || `req:${o.requestId || ''}:${ts || ''}`;

      // Current transcripts write one content block per line (several lines
      // sharing one message.id); older ones rewrote the whole message
      // cumulatively. Union tool_use blocks by their block id so tool counts
      // are exact under both shapes.
      if (Array.isArray(o.message.content)) {
        let tus = blocksById.get(key);
        for (const b of o.message.content) {
          if (b.type !== 'tool_use') continue;
          if (!tus) { tus = new Map(); blocksById.set(key, tus); }
          tus.set(b.id || `${b.name}:${tus.size}`, b.name);
        }
      }

      if (o.message.usage) {
        // Every copy carries the same usage — count each API response exactly
        // once, keeping the copy with the most output tokens (completed stream).
        const out = o.message.usage.output_tokens || 0;
        const prev = assistantById.get(key);
        if (!prev || out >= prev.out) {
          assistantById.set(key, { msg: o.message, ts: ts || lastTs, out, effort: o.effort || null });
        }
      }
    }
  }

  let toolCalls = 0;
  for (const tus of blocksById.values()) {
    toolCalls += tus.size;
    for (const name of tus.values()) toolBreakdown[name] = (toolBreakdown[name] || 0) + 1;
  }

  let webSearch = 0, webFetch = 0, thinkingTokens = 0, fastTokens = 0, fastMsgs = 0;
  const effortCounts = {};
  for (const { msg, ts, effort } of assistantById.values()) {
    assistantMessages++;
    const model = msg.model || 'unknown';
    const u = msg.usage;
    const speed = u.speed === 'fast' ? 'fast' : 'standard';
    if (!perModel[model]) {
      perModel[model] = { usage: emptyUsage(), cost: 0, msgs: 0,
        fastTokens: 0, fastMsgs: 0, webSearch: 0, webFetch: 0, effort: {} };
    }
    const pm = perModel[model];
    addUsage(pm.usage, u);
    pm.msgs++;

    const cc = u.cache_creation || {};
    const cc5m = cc.ephemeral_5m_input_tokens || 0;
    const cc1h = cc.ephemeral_1h_input_tokens || 0;
    const think = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
    const stu = u.server_tool_use || {};
    pm.webSearch += stu.web_search_requests || 0;
    pm.webFetch += stu.web_fetch_requests || 0;
    webSearch += stu.web_search_requests || 0;
    webFetch += stu.web_fetch_requests || 0;
    thinkingTokens += think;
    if (effort) { pm.effort[effort] = (pm.effort[effort] || 0) + 1; effortCounts[effort] = (effortCounts[effort] || 0) + 1; }

    const tok = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (speed === 'fast') { pm.fastTokens += tok; pm.fastMsgs++; fastTokens += tok; fastMsgs++; }

    const mcost = costFor(model, {
      input: u.input_tokens || 0, output: u.output_tokens || 0,
      cacheCreation: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
      cacheCreation5m: cc5m, cacheCreation1h: cc1h,
    }, { speed });
    pm.cost += mcost;

    const t = ts ? Date.parse(ts) : 0;
    if (t) {
      const day = localDay(t);
      dailyTokens[day] = (dailyTokens[day] || 0) + tok;
      dailyCost[day] = (dailyCost[day] || 0) + mcost;
      if (!dailyModel[day]) dailyModel[day] = {};
      dailyModel[day][model] = (dailyModel[day][model] || 0) + tok;
      if (!dailyModelCost[day]) dailyModelCost[day] = {};
      dailyModelCost[day][model] = (dailyModelCost[day][model] || 0) + mcost;
    }
    msgTimes.push({
      t, tok, cost: mcost, model,
      cacheCreation: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cache1h: cc1h, thinking: think, speed,
    });
  }

  // Aggregate tokens + cost across models.
  const totals = emptyUsage();
  let cost = 0;
  let primaryModel = null;
  let primaryModelTokens = -1;
  const models = {};
  for (const [model, pm] of Object.entries(perModel)) {
    const u = pm.usage;
    for (const k of Object.keys(totals)) totals[k] += u[k] || 0;
    cost += pm.cost;
    const mTok = u.input + u.output + u.cacheCreation;
    models[model] = { usage: u, cost: pm.cost, tokens: mTok, msgs: pm.msgs,
      fastTokens: pm.fastTokens, fastMsgs: pm.fastMsgs,
      webSearch: pm.webSearch, webFetch: pm.webFetch, effort: pm.effort };
    if (mTok > primaryModelTokens) { primaryModelTokens = mTok; primaryModel = model; }
  }

  const billableTokens = totals.input + totals.output + totals.cacheCreation;
  const active = (Date.now() - stat.mtimeMs) < ACTIVE_WINDOW_MS;

  const data = {
    id,
    file,
    cwd,
    gitBranch,
    title: title || firstUserText || '(untitled session)',
    startTime: firstTs,
    endTime: lastTs,
    mtime: stat.mtimeMs,
    active,
    userMessages,
    assistantMessages,
    toolCalls,
    tokens: totals,
    billableTokens,
    cost,
    models,
    primaryModel,
    thinkingTokens,
    fastTokens,
    fastMsgs,
    webSearch,
    webFetch,
    effortCounts,
    cliVersion,
    dailyTokens,
    dailyCost,
    dailyModel,
    dailyModelCost,
    toolBreakdown,
    msgTimes,
  };
  cache.set(file, { sig, data });
  return data;
}

// Decode the encoded project-dir name into a readable path as a fallback
// when no transcript carries a cwd.
function decodeDirName(name) {
  // e.g. "C--Users-Jameson-telegramemailbot" -> "C:\Users\Jameson\telegramemailbot"
  const m = name.match(/^([A-Za-z])--(.*)$/);
  if (m) return `${m[1].toUpperCase()}:\\` + m[2].replace(/-/g, '\\');
  return name;
}

// ---- subagent transcripts ---------------------------------------------------
// Everything a session's Task/Agent/Workflow subagents burned, from
// <projectDir>/<sessionId>/subagents/**/*.jsonl (journal.jsonl is workflow
// bookkeeping, not a transcript).
function listSubagentFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { listSubagentFiles(full, out); continue; }
    if (e.name.endsWith('.jsonl') && e.name !== 'journal.jsonl') out.push(full);
  }
  return out;
}

const mergeNumMap = (dst, src) => { for (const [k, v] of Object.entries(src || {})) dst[k] = (dst[k] || 0) + v; };
const mergeNestedNumMap = (dst, src) => {
  for (const [k, mm] of Object.entries(src || {})) {
    if (!dst[k]) dst[k] = {};
    mergeNumMap(dst[k], mm);
  }
};

// Merge parsed subagent transcripts into a session view. Never mutates the
// cached per-file parse results — builds a fresh object.
function withSubagents(main, subDatas) {
  if (!subDatas.length) return { ...main, subagentCount: 0, subagentTokens: 0, subagentCost: 0 };
  const s = {
    ...main,
    tokens: { ...main.tokens },
    models: {},
    dailyTokens: { ...main.dailyTokens },
    dailyCost: { ...main.dailyCost },
    dailyModel: {}, dailyModelCost: {},
    toolBreakdown: { ...main.toolBreakdown },
    effortCounts: { ...main.effortCounts },
    msgTimes: [...main.msgTimes],
    subagentCount: subDatas.length,
    subagentTokens: 0,
    subagentCost: 0,
  };
  for (const [m, info] of Object.entries(main.models)) s.models[m] = { ...info, usage: { ...info.usage }, effort: { ...info.effort } };
  mergeNestedNumMap(s.dailyModel, main.dailyModel);
  mergeNestedNumMap(s.dailyModelCost, main.dailyModelCost);

  for (const sub of subDatas) {
    s.subagentTokens += sub.billableTokens;
    s.subagentCost += sub.cost;
    s.cost += sub.cost;
    s.billableTokens += sub.billableTokens;
    s.toolCalls += sub.toolCalls;
    s.assistantMessages += sub.assistantMessages;
    s.thinkingTokens += sub.thinkingTokens;
    s.fastTokens += sub.fastTokens;
    s.fastMsgs += sub.fastMsgs;
    s.webSearch += sub.webSearch;
    s.webFetch += sub.webFetch;
    for (const k of Object.keys(s.tokens)) s.tokens[k] += sub.tokens[k] || 0;
    mergeNumMap(s.dailyTokens, sub.dailyTokens);
    mergeNumMap(s.dailyCost, sub.dailyCost);
    mergeNestedNumMap(s.dailyModel, sub.dailyModel);
    mergeNestedNumMap(s.dailyModelCost, sub.dailyModelCost);
    mergeNumMap(s.toolBreakdown, sub.toolBreakdown);
    mergeNumMap(s.effortCounts, sub.effortCounts);
    for (const [m, info] of Object.entries(sub.models)) {
      if (!s.models[m]) {
        s.models[m] = { usage: emptyUsage(), cost: 0, tokens: 0, msgs: 0,
          fastTokens: 0, fastMsgs: 0, webSearch: 0, webFetch: 0, effort: {} };
      }
      const t = s.models[m];
      for (const k of Object.keys(t.usage)) t.usage[k] += info.usage[k] || 0;
      t.cost += info.cost; t.tokens += info.tokens; t.msgs += info.msgs;
      t.fastTokens += info.fastTokens; t.fastMsgs += info.fastMsgs;
      t.webSearch += info.webSearch; t.webFetch += info.webFetch;
      mergeNumMap(t.effort, info.effort);
    }
    for (const m of sub.msgTimes) s.msgTimes.push({ ...m, sub: 1 });
  }
  return s;
}

// Memoize the full cross-project aggregation. parseSession already skips
// re-reading unchanged files, but the aggregation below re-runs on every call —
// and the live UI calls listProjects() from several endpoints every few seconds.
// Key the memo on a cheap signature (each transcript's mtime+size, including
// subagent transcripts of recently-touched sessions); it auto-invalidates the
// instant any session or live subagent is written, added, or removed.
let projectsMemo = { sig: null, data: null };

function projectsSignature() {
  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  const parts = [];
  const now = Date.now();
  for (const d of dirs) {
    const dirPath = path.join(PROJECTS_DIR, d.name);
    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      let st;
      try { st = fs.statSync(path.join(dirPath, f)); } catch { continue; /* vanished mid-walk */ }
      parts.push(`${d.name}/${f}:${st.mtimeMs}:${st.size}`);
      // Subagent transcripts only change while their parent session is (or was
      // very recently) running — only those need to be able to bust the memo.
      if ((now - st.mtimeMs) < SUBAGENT_SCAN_WINDOW_MS) {
        const subDir = path.join(dirPath, path.basename(f, '.jsonl'), 'subagents');
        for (const sf of listSubagentFiles(subDir, [])) {
          try { const sst = fs.statSync(sf); parts.push(`${sf}:${sst.mtimeMs}:${sst.size}`); } catch { /* vanished */ }
        }
      }
    }
  }
  return parts.join('|');
}

// Recursively count subagent transcripts under a session's subagents/ dir and
// how many are "live" (written within the active window) — a stat-walk, not a
// content parse, so it's cheap enough to run on every liveness refresh for the
// small set of recently-touched sessions that pass the time gate above.
function scanSubagents(dir, now, counts) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { scanSubagents(full, now, counts); continue; }
    if (!e.name.endsWith('.jsonl') || e.name === 'journal.jsonl') continue;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    counts.total++;
    if ((now - st.mtimeMs) < ACTIVE_WINDOW_MS) counts.live++;
  }
}
function countLiveSubagents(projectDirName, sessionId, now) {
  const counts = { live: 0, total: 0 };
  scanSubagents(path.join(PROJECTS_DIR, projectDirName, sessionId, 'subagents'), now, counts);
  return counts;
}

// "Live" is a function of wall-clock time (now - mtime), not of file contents —
// so it must never be trapped behind the disk-signature memo above. A session
// that goes quiet stops changing its file, which freezes `sig` forever; if
// liveCount were computed only inside the memoized block, a session would
// read as "live" indefinitely after it actually ended (until *some* session,
// anywhere, next touches its transcript and busts the signature). Recomputing
// this pass is cheap — pure arithmetic over already-parsed data, no disk I/O —
// so it runs on every call regardless of memo hit.
function refreshLiveness(projects) {
  const now = Date.now();
  for (const p of projects) {
    let liveCount = 0;
    let liveSubagents = 0;
    for (const s of p.sessions) {
      s.active = (now - s.mtime) < ACTIVE_WINDOW_MS;
      // A subagent can still be mid-run while the parent's own transcript sits
      // quiet (it's waiting on the Task tool call to return) — check subagents
      // for any recently-touched session, not just ones already flagged active.
      s.liveSubagents = (now - s.mtime) < SUBAGENT_SCAN_WINDOW_MS
        ? countLiveSubagents(p.id, s.id, now).live
        : 0;
      if (s.liveSubagents > 0) s.active = true;
      if (s.active) liveCount++;
      liveSubagents += s.liveSubagents;
    }
    p.liveCount = liveCount;
    p.liveSubagents = liveSubagents;
  }
}

function computeProjects() {
  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  const projects = [];
  for (const d of dirs) {
    const dirPath = path.join(PROJECTS_DIR, d.name);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) continue;

    const sessions = files.map((f) => {
      try {
        const main = parseSession(path.join(dirPath, f));
        const subFiles = listSubagentFiles(path.join(dirPath, path.basename(f, '.jsonl'), 'subagents'), []);
        const subDatas = subFiles.map((sf) => { try { return parseSession(sf); } catch { return null; } }).filter(Boolean);
        return withSubagents(main, subDatas);
      }
      catch { return null; }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);

    if (sessions.length === 0) continue;

    // Pick the cwd by majority vote — a single resumed/copied session can carry
    // a stray cwd, so "most recent" is unreliable. Most common wins.
    const cwdCounts = {};
    for (const s of sessions) if (s.cwd) cwdCounts[s.cwd] = (cwdCounts[s.cwd] || 0) + 1;
    const cwd = Object.entries(cwdCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || decodeDirName(d.name);
    const totals = emptyUsage();
    let cost = 0, toolCalls = 0, billableTokens = 0;
    let subagentTokens = 0, subagentCost = 0, thinkingTokens = 0;
    const modelTokens = {};
    const modelStats = {}; // model -> full per-model aggregate for this app
    const daily = {};
    const dailyCost = {};
    const dailyModel = {};
    const dailyModelCost = {};
    let lastActivity = 0;
    for (const s of sessions) {
      for (const k of Object.keys(totals)) totals[k] += s.tokens[k] || 0;
      cost += s.cost;
      toolCalls += s.toolCalls;
      billableTokens += s.billableTokens;
      subagentTokens += s.subagentTokens || 0;
      subagentCost += s.subagentCost || 0;
      thinkingTokens += s.thinkingTokens || 0;
      if (s.mtime > lastActivity) lastActivity = s.mtime;
      for (const [m, info] of Object.entries(s.models)) {
        modelTokens[m] = (modelTokens[m] || 0) + info.tokens;
        if (!modelStats[m]) {
          modelStats[m] = { tokens: 0, cost: 0, msgs: 0, sessions: 0,
            input: 0, output: 0, cacheCreation: 0, cacheRead: 0,
            cacheCreation5m: 0, cacheCreation1h: 0, thinking: 0,
            fastTokens: 0, fastMsgs: 0, webSearch: 0, webFetch: 0, effort: {} };
        }
        const t = modelStats[m];
        t.tokens += info.tokens; t.cost += info.cost; t.msgs += info.msgs; t.sessions++;
        t.input += info.usage.input; t.output += info.usage.output;
        t.cacheCreation += info.usage.cacheCreation; t.cacheRead += info.usage.cacheRead;
        t.cacheCreation5m += info.usage.cacheCreation5m || 0;
        t.cacheCreation1h += info.usage.cacheCreation1h || 0;
        t.thinking += info.usage.thinking || 0;
        t.fastTokens += info.fastTokens; t.fastMsgs += info.fastMsgs;
        t.webSearch += info.webSearch; t.webFetch += info.webFetch;
        mergeNumMap(t.effort, info.effort);
      }
      mergeNumMap(daily, s.dailyTokens);
      mergeNumMap(dailyCost, s.dailyCost);
      mergeNestedNumMap(dailyModel, s.dailyModel);
      mergeNestedNumMap(dailyModelCost, s.dailyModelCost);
    }

    projects.push({
      id: d.name,
      name: path.basename(cwd.replace(/[\\/]+$/, '')) || d.name,
      cwd,
      sessionCount: sessions.length,
      liveCount: 0, // filled in by refreshLiveness() below on every call
      liveSubagents: 0, // filled in by refreshLiveness() below on every call
      lastActivity,
      cost,
      billableTokens,
      toolCalls,
      tokens: totals,
      subagentTokens,
      subagentCost,
      thinkingTokens,
      modelTokens,
      modelStats,
      daily,
      dailyCost,
      dailyModel,
      dailyModelCost,
      sessions,
    });
  }
  projects.sort((a, b) => b.lastActivity - a.lastActivity);
  return projects;
}

export function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const sig = projectsSignature();
  if (projectsMemo.sig !== sig) projectsMemo = { sig, data: computeProjects() };
  refreshLiveness(projectsMemo.data);
  return projectsMemo.data;
}

export function getProject(id) {
  return listProjects().find((p) => p.id === id) || null;
}

// Reconstruct the human-readable conversation for one session. Cached by
// mtime+size: the live UI re-polls this every ~800ms, and re-reading a
// multi-MB transcript each time is wasteful when it hasn't grown. While a
// session streams, the file changes (size/mtime), so the cache correctly
// refreshes; once it goes quiet, polls become a single stat.
//
// Transcript shapes handled:
//  • old: each assistant API response rewritten cumulatively (same message.id,
//    each rewrite's text extending the previous) → keep the longest copy.
//  • current: one content block per line, several lines per message.id
//    ([thinking], [text], one line per [tool_use]) → merge blocks into one row.
const chatCache = new Map(); // file -> { sig, msgs }
export function readSessionChat(projectId, sessionId) {
  const file = path.join(PROJECTS_DIR, projectId, sessionId + '.jsonl');
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const sig = `${stat.mtimeMs}:${stat.size}`;
  const hit = chatCache.get(file);
  if (hit && hit.sig === sig) return hit.msgs;
  const lines = readJsonLines(file);
  const msgs = [];
  const rowById = new Map(); // assistant message.id -> row (rows merge across lines)
  let anon = 0;
  for (const o of lines) {
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      text = (text || '').trim();
      if (text && !META_RE.test(text)) msgs.push({ role: 'user', text, ts: o.timestamp });
    } else if (o.type === 'assistant' && o.message) {
      const id = o.message.id || `anon:${anon++}`;
      let row = rowById.get(id);
      if (!row) {
        row = { role: 'assistant', text: '', tools: [], ts: o.timestamp, _tu: new Set() };
        rowById.set(id, row);
        msgs.push(row);
      }
      for (const b of o.message.content || []) {
        if (b.type === 'text') {
          const t = String(b.text || '').trim();
          if (!t) continue;
          if (t.startsWith(row.text)) row.text = t;             // cumulative rewrite → keep longest
          else if (!row.text.includes(t)) row.text = row.text ? row.text + '\n\n' + t : t; // new fragment
        } else if (b.type === 'tool_use') {
          const k = b.id || b.name;
          if (!row._tu.has(k)) { row._tu.add(k); row.tools.push(b.name); }
        }
      }
    }
  }
  const cleaned = msgs.filter((m) => m.role === 'user' || m.text || (m.tools && m.tools.length));
  for (const m of cleaned) delete m._tu;
  chatCache.set(file, { sig, msgs: cleaned });
  return cleaned;
}
