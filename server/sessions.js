import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { costFor } from './pricing.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // file touched in last 10 min = "live"

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
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function addUsage(target, u) {
  if (!u) return;
  target.input += u.input_tokens || 0;
  target.output += u.output_tokens || 0;
  target.cacheCreation += u.cache_creation_input_tokens || 0;
  target.cacheRead += u.cache_read_input_tokens || 0;
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
  let toolCalls = 0;
  const perModel = {}; // model -> usage
  const dailyTokens = {}; // YYYY-MM-DD -> token count
  const dailyModel = {}; // YYYY-MM-DD -> { model: token count }
  const toolBreakdown = {}; // tool name -> count
  const msgTimes = []; // { t: epochMs, tok, cost } per deduped assistant message
  const assistantById = new Map(); // dedupe streamed rewrites by message.id

  for (const o of lines) {
    if (o.cwd) cwd = o.cwd;
    if (o.gitBranch && o.gitBranch !== 'HEAD') gitBranch = o.gitBranch;
    if (o.type === 'ai-title' && o.title) title = o.title;

    const ts = o.timestamp;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }

    if (o.type === 'user' && o.message) {
      userMessages++;
      if (!firstUserText) {
        const c = o.message.content;
        if (typeof c === 'string') firstUserText = c.slice(0, 120);
        else if (Array.isArray(c)) {
          const t = c.find((b) => b.type === 'text');
          if (t) firstUserText = String(t.text).slice(0, 120);
        }
      }
    }

    if (o.type === 'assistant' && o.message && o.message.usage) {
      // Claude Code rewrites each assistant message to the transcript many
      // times as it streams — every copy carries the same usage. Dedupe by
      // message.id (keeping the copy with the most output tokens = the
      // completed stream) so each API response is counted exactly once.
      const key = o.message.id || `req:${o.requestId || ''}:${ts || ''}`;
      const out = o.message.usage.output_tokens || 0;
      const prev = assistantById.get(key);
      if (!prev || out >= prev.out) {
        assistantById.set(key, { msg: o.message, ts: ts || lastTs, out });
      }
    }
  }

  for (const { msg, ts } of assistantById.values()) {
    assistantMessages++;
    const model = msg.model || 'unknown';
    if (!perModel[model]) perModel[model] = emptyUsage();
    addUsage(perModel[model], msg.usage);
    const u = msg.usage;
    const tok = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const day = (ts || '').slice(0, 10);
    if (day) {
      dailyTokens[day] = (dailyTokens[day] || 0) + tok;
      if (!dailyModel[day]) dailyModel[day] = {};
      dailyModel[day][model] = (dailyModel[day][model] || 0) + tok;
    }
    const mcost = costFor(model, {
      input: u.input_tokens || 0, output: u.output_tokens || 0,
      cacheCreation: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
    });
    msgTimes.push({ t: ts ? Date.parse(ts) : 0, tok, cost: mcost });
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) if (b.type === 'tool_use') {
        toolCalls++;
        toolBreakdown[b.name] = (toolBreakdown[b.name] || 0) + 1;
      }
    }
  }

  // Aggregate tokens + cost across models.
  const totals = emptyUsage();
  let cost = 0;
  let primaryModel = null;
  let primaryModelTokens = -1;
  const models = {};
  for (const [model, u] of Object.entries(perModel)) {
    totals.input += u.input;
    totals.output += u.output;
    totals.cacheCreation += u.cacheCreation;
    totals.cacheRead += u.cacheRead;
    const c = costFor(model, u);
    cost += c;
    const mTok = u.input + u.output + u.cacheCreation;
    models[model] = { usage: u, cost: c, tokens: mTok };
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
    dailyTokens,
    dailyModel,
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

// Short-lived memo: several endpoints (overview, account, recommendations)
// call listProjects() within the same poll cycle — scan the transcript tree
// once and share the result for a couple of seconds.
let listMemo = null; // { at, data }
const LIST_TTL_MS = 2000;

export function listProjects() {
  if (listMemo && Date.now() - listMemo.at < LIST_TTL_MS) return listMemo.data;
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  const projects = [];
  for (const d of dirs) {
    const dirPath = path.join(PROJECTS_DIR, d.name);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) continue;

    const sessions = files.map((f) => {
      try { return parseSession(path.join(dirPath, f)); }
      catch { return null; }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);

    if (sessions.length === 0) continue;

    // Pick the cwd by majority vote — a single resumed/copied session can carry
    // a stray cwd, so "most recent" is unreliable. Most common wins.
    const cwdCounts = {};
    for (const s of sessions) if (s.cwd) cwdCounts[s.cwd] = (cwdCounts[s.cwd] || 0) + 1;
    const cwd = Object.entries(cwdCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || decodeDirName(d.name);
    const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    let cost = 0, toolCalls = 0, billableTokens = 0;
    const modelTokens = {};
    const daily = {};
    const dailyModel = {};
    let lastActivity = 0;
    let liveCount = 0;
    for (const s of sessions) {
      totals.input += s.tokens.input;
      totals.output += s.tokens.output;
      totals.cacheCreation += s.tokens.cacheCreation;
      totals.cacheRead += s.tokens.cacheRead;
      cost += s.cost;
      toolCalls += s.toolCalls;
      billableTokens += s.billableTokens;
      if (s.mtime > lastActivity) lastActivity = s.mtime;
      if (s.active) liveCount++;
      for (const [m, info] of Object.entries(s.models)) {
        modelTokens[m] = (modelTokens[m] || 0) + info.tokens;
      }
      for (const [day, tok] of Object.entries(s.dailyTokens)) {
        daily[day] = (daily[day] || 0) + tok;
      }
      for (const [day, mm] of Object.entries(s.dailyModel || {})) {
        if (!dailyModel[day]) dailyModel[day] = {};
        for (const [m, tok] of Object.entries(mm)) dailyModel[day][m] = (dailyModel[day][m] || 0) + tok;
      }
    }

    projects.push({
      id: d.name,
      name: path.basename(cwd.replace(/[\\/]+$/, '')) || d.name,
      cwd,
      sessionCount: sessions.length,
      liveCount,
      lastActivity,
      cost,
      billableTokens,
      toolCalls,
      tokens: totals,
      modelTokens,
      daily,
      dailyModel,
      sessions,
    });
  }
  projects.sort((a, b) => b.lastActivity - a.lastActivity);
  listMemo = { at: Date.now(), data: projects };
  return projects;
}

export function getProject(id) {
  return listProjects().find((p) => p.id === id) || null;
}

// Injected/meta user entries we don't want to show as chat.
const META_RE = /^<(command|local-command|system-reminder|user-prompt-submit|bash-)/i;

// Reconstruct the human-readable conversation for one session.
export function readSessionChat(projectId, sessionId) {
  const file = path.join(PROJECTS_DIR, projectId, sessionId + '.jsonl');
  if (!fs.existsSync(file)) return null;
  const lines = readJsonLines(file);
  const msgs = [];
  let lastAssistantId = null;
  for (const o of lines) {
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      text = (text || '').trim();
      if (text && !META_RE.test(text)) msgs.push({ role: 'user', text, ts: o.timestamp });
      lastAssistantId = null;
    } else if (o.type === 'assistant' && o.message) {
      const id = o.message.id;
      const blocks = o.message.content || [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const tools = blocks.filter((b) => b.type === 'tool_use').map((b) => b.name);
      if (id && id === lastAssistantId) {
        const last = msgs[msgs.length - 1]; // streamed rewrite → update final state
        if (last && last.role === 'assistant') { last.text = text; last.tools = tools; }
      } else if (text || tools.length) {
        msgs.push({ role: 'assistant', text, tools, ts: o.timestamp });
        lastAssistantId = id;
      }
    }
  }
  return msgs;
}
