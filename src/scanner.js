'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Scans ~/.claude/projects/**/*.jsonl for assistant messages carrying usage data.
// Results are cached per file (keyed on size + mtime) so polls only re-parse
// files that changed since the last scan.
class UsageScanner {
  constructor(claudeDir) {
    this.claudeDir = claudeDir;
    this.fileCache = new Map(); // filePath -> { size, mtimeMs, entries }
  }

  listTranscriptFiles() {
    const projectsDir = path.join(this.claudeDir, 'projects');
    const out = [];
    let dirs;
    try {
      dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dirPath = path.join(projectsDir, d.name);
      let files;
      try {
        files = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.endsWith('.jsonl')) out.push({ file: path.join(dirPath, f), projectDir: d.name });
      }
    }
    return out;
  }

  async parseFile(filePath, projectDir) {
    const entries = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      // Cheap pre-filter before paying for JSON.parse on every line.
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
      const m = o.message;
      if (!m.model || m.model === '<synthetic>') continue;
      const u = m.usage;
      const cc = u.cache_creation;
      const w5m = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
      const w1h = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
      entries.push({
        ts: Date.parse(o.timestamp) || 0,
        model: m.model,
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        w5m,
        w1h,
        sessionId: o.sessionId || path.basename(filePath, '.jsonl'),
        projectDir,
        sidechain: !!o.isSidechain,
        key: (m.id || o.uuid || '') + ':' + (o.requestId || ''),
      });
    }
    return entries;
  }

  // Returns a deduplicated, time-sorted list of usage entries across all transcripts.
  async scan() {
    const files = this.listTranscriptFiles();
    const seenPaths = new Set();
    for (const { file, projectDir } of files) {
      seenPaths.add(file);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const cached = this.fileCache.get(file);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) continue;
      const entries = await this.parseFile(file, projectDir);
      this.fileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, entries });
    }
    for (const p of [...this.fileCache.keys()]) {
      if (!seenPaths.has(p)) this.fileCache.delete(p);
    }

    // Dedupe across files: streaming can write the same message id more than
    // once with growing token counts — keep the occurrence with the most output.
    const byKey = new Map();
    for (const { entries } of this.fileCache.values()) {
      for (const e of entries) {
        const prev = byKey.get(e.key);
        if (!prev || e.output > prev.output) byKey.set(e.key, e);
      }
    }
    const all = [...byKey.values()];
    all.sort((a, b) => a.ts - b.ts);
    return all;
  }

  // ~/.claude/sessions/*.json map running/recent sessions to titles and cwds.
  readSessionMeta() {
    const dir = path.join(this.claudeDir, 'sessions');
    const meta = new Map(); // sessionId -> { name, cwd, updatedAt, pid }
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return meta;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!o.sessionId) continue;
        const prev = meta.get(o.sessionId);
        if (!prev || (o.updatedAt || 0) > (prev.updatedAt || 0)) {
          meta.set(o.sessionId, { name: o.name, cwd: o.cwd, updatedAt: o.updatedAt, pid: o.pid });
        }
      } catch { /* ignore unreadable session files */ }
    }
    return meta;
  }
}

module.exports = { UsageScanner };
