import fs from 'node:fs';
import path from 'node:path';
import { ensureOut, readJson, slug, toCsv } from './util.mjs';

const PLACEHOLDERS = {
  name: '[YOUR NAME]',
  business: '[YOUR BUSINESS NAME]',
  email: '[YOUR EMAIL]',
  phone: '[YOUR PHONE]',
  address: '[YOUR PHYSICAL MAILING ADDRESS]',
  portfolio: '[LINK TO YOUR PORTFOLIO]',
};

export function loadSender() {
  const s = readJson('sender.json', {});
  const sender = { ...PLACEHOLDERS, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v)) };
  const missing = Object.keys(PLACEHOLDERS).filter((k) => sender[k] === PLACEHOLDERS[k]);
  return { sender, missing };
}

const bullets = (items) => items.map((i) => `  - ${i}`).join('\n');

// First-person fragments that read naturally after "I noticed that ...".
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function subjectFor(p) {
  const top = p.issues[0]?.code;
  switch (top) {
    case 'no_website': return `Quick idea for ${p.name}'s online presence`;
    case 'social_only': return `${p.name}: getting found beyond Facebook`;
    case 'site_down': return `${p.name}'s website wasn't loading`;
    case 'parked': return `${p.name}'s website is showing a placeholder page`;
    case 'tls_error': return `${p.name}'s website is showing a security warning`;
    case 'no_https': return `${p.name}'s website shows "Not secure" in browsers`;
    case 'no_viewport': case 'mobile_overflow': return `${p.name}'s website on mobile phones`;
    case 'slow_load': case 'slow_server': case 'heavy_page': case 'psi_poor': return `${p.name}'s website speed on mobile`;
    default: return `A few quick fixes for ${p.name}'s website`;
  }
}

export function draftFor(p, sender) {
  const top = p.issues.slice(0, 3);
  const noSite = ['no_website', 'social_only', 'site_down', 'parked'].includes(p.status);
  const lines = [];
  lines.push(`Hi ${p.contactName || 'there'},`, '');
  // No claims about the sender beyond what's true for anyone using this (no "Denver-based", no years of experience).
  lines.push(`I'm a web developer, and I was looking at local businesses when I came across ${p.name}.`);
  if (noSite) {
    lines.push('', `I noticed that ${top[0].pitch}.`);
    lines.push('', 'A simple, fast site with your hours, location, photos and a way to call or book would make it much easier for new customers to find and choose you.');
  } else {
    lines.push('', 'While I was looking at your website I noticed a few things that are probably costing you customers:', '', bullets(top.map((i) => cap(i.pitch))));
    lines.push('', 'These are all fixable without starting from scratch.');
  }
  lines.push(
    '',
    `I'd be happy to send over a short, no-cost write-up of what I'd change, with rough pricing, so you can decide if it's worth it. Would that be useful?`,
  );
  if (sender.portfolio !== PLACEHOLDERS.portfolio) lines.push('', `A few examples of my work: ${sender.portfolio}`);
  lines.push('', 'Thanks for your time,', sender.name, sender.business, `${sender.phone} · ${sender.email}`);
  lines.push(
    '', '---',
    `You're receiving this one-time message because ${p.name} is a local business with a publicly listed contact. ` +
      `If you'd rather not hear from me, reply "no thanks" and I won't contact you again.`,
    sender.address,
  );
  return lines.join('\n');
}

/** Write one markdown draft per prospect plus drafts.csv. Nothing is ever sent. */
export function writeDrafts(prospects, { minTier = 'warm', limit = 100, requireEmail = false } = {}) {
  const order = { hot: 3, warm: 2, cold: 1, none: 0 };
  const picked = prospects
    .filter((p) => order[p.tier] >= order[minTier] && (!requireEmail || p.email))
    .slice(0, limit);
  const { sender, missing } = loadSender();
  const dir = ensureOut('drafts');
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) fs.unlinkSync(path.join(dir, f));
  const rows = picked.map((p, i) => {
    const subject = subjectFor(p);
    const body = draftFor(p, sender);
    const file = `${String(i + 1).padStart(3, '0')}-${slug(p.name)}.md`;
    fs.writeFileSync(path.join(dir, file), `To: ${p.email || '(no email found — call, visit, or use their contact form)'}\nSubject: ${subject}\n\n${body}\n`);
    return { rank: i + 1, tier: p.tier, name: p.name, to: p.email, subject, phone: p.phone, website: p.website, body, file };
  });
  fs.writeFileSync(path.join(ensureOut(), 'drafts.csv'), toCsv(rows, ['rank', 'tier', 'name', 'to', 'subject', 'phone', 'website', 'body', 'file']));
  return { count: rows.length, withEmail: rows.filter((r) => r.to).length, missingSenderFields: missing };
}
