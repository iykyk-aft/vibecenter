// Minimal, dependency-free ZIP writer (deflate) + client-bundle collector, used
// by the broker's /download endpoint to hand invitees the app.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xFFFF); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

// files: [{ name, data:Buffer }] → a Buffer holding a valid .zip
export function makeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const comp = zlib.deflateRawSync(f.data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(comp.length), u32(f.data.length), u16(name.length), u16(0), name]);
    parts.push(local, comp);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(comp.length), u32(f.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...parts, cd, eocd]);
}

// Everything an invitee needs to run their own agent + connect bridge — and
// nothing private (data/, .git, secrets are all skipped).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', '.github', 'deploy', '.claude']);
function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, base, out); continue; }
    if (/\.(cc-backup|log)$/.test(e.name) || e.name === '.env' || e.name.startsWith('.env.')) continue;
    out.push({ name: path.relative(base, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
  }
}
export function collectClientFiles(root) { const out = []; walk(root, root, out); return out; }
