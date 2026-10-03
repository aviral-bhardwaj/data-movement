const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const axios = require('axios');
const { BaseSource, record, state, inferJsonSchema, mergeJsonSchemas } = require('../base');

// File source: CSV / JSON / JSONL from local paths, directories, or HTTP(S) URLs.
class FileSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-file';
    this.displayName = 'File (CSV/JSON)';
    this.description = 'Read CSV, JSON or JSONL files from disk or HTTP URLs. Each file becomes a stream.';
    this.icon = '📄';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['path', 'format'],
        properties: {
          path: { type: 'string', title: 'File path, directory, or http(s):// URL' },
          format: { type: 'string', enum: ['csv', 'json', 'jsonl'], default: 'csv' },
          csvHasHeader: { type: 'boolean', default: true },
          delimiter: { type: 'string', default: ',' },
          cursorField: { type: 'string', title: 'Cursor field for incremental reads' },
        },
      },
    };
  }

  _files(cfg) {
    if (/^https?:\/\//.test(cfg.path)) return [{ name: path.basename(new URL(cfg.path).pathname) || 'remote', url: cfg.path }];
    const p = path.resolve(cfg.path);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      return fs.readdirSync(p)
        .filter((f) => /\.(csv|json|jsonl|ndjson)$/i.test(f))
        .map((f) => ({ name: f.replace(/\.[^.]+$/, ''), file: path.join(p, f) }));
    }
    return [{ name: path.basename(p).replace(/\.[^.]+$/, ''), file: p }];
  }

  async check(cfg) {
    try {
      const files = this._files(cfg);
      if (!files.length) return { status: 'FAILED', message: 'no readable files found' };
      return { status: 'SUCCEEDED', message: `${files.length} file(s)` };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    }
  }

  _format(cfg, name) {
    if (cfg.format && cfg.format !== 'auto') return cfg.format;
    const ext = name.split('.').pop().toLowerCase();
    return ext === 'jsonl' || ext === 'ndjson' ? 'jsonl' : ext;
  }

  async *_rows(cfg, file) {
    const fmt = this._format(cfg, file.file || file.name);
    let stream;
    if (file.url) {
      const res = await axios.get(file.url, { responseType: 'stream', timeout: 120000 });
      stream = res.data;
    } else {
      stream = fs.createReadStream(file.file);
    }
    if (fmt === 'csv') {
      const parser = stream.pipe(parse({
        columns: cfg.csvHasHeader !== false,
        delimiter: cfg.delimiter || ',',
        relax_quotes: true,
        skip_empty_lines: true,
      }));
      for await (const row of parser) yield row;
    } else if (fmt === 'jsonl') {
      const readline = require('readline');
      const rl = readline.createInterface({ input: stream });
      for await (const line of rl) {
        const t = line.trim();
        if (t) { try { yield JSON.parse(t); } catch (_) {} }
      }
    } else {
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      for (const row of Array.isArray(data) ? data : [data]) yield row;
    }
  }

  async discover(cfg) {
    const streams = [];
    for (const file of this._files(cfg)) {
      let schema = { type: 'object', properties: {} };
      let n = 0;
      for await (const row of this._rows(cfg, file)) {
        schema = mergeJsonSchemas(schema, inferJsonSchema(row));
        if (++n >= 200) break;
      }
      streams.push({
        name: file.name, namespace: 'file', jsonSchema: schema,
        supportedSyncModes: this.supportedSyncModes,
        sourceDefinedPrimaryKey: [],
        availableCursorFields: cfg.cursorField ? [cfg.cursorField] : Object.keys(schema.properties),
      });
    }
    return { streams };
  }

  async *read(cfg, catalog, state, _ctx) {
    const files = this._files(cfg);
    for (const stream of catalog.streams) {
      const file = files.find((f) => f.name === stream.name) || files[0];
      const st = state?.[stream.name] || {};
      let maxCursor = st.cursor;
      for await (const row of this._rows(cfg, file)) {
        const cf = stream.cursorField || cfg.cursorField;
        if (cf && row[cf] !== undefined) {
          if (stream.syncMode === 'incremental' && st.cursor !== undefined && row[cf] <= st.cursor) continue;
          if (maxCursor === undefined || row[cf] > maxCursor) maxCursor = row[cf];
        }
        yield record(stream.name, row, { namespace: 'file' });
      }
      if (stream.syncMode === 'incremental' && (stream.cursorField || cfg.cursorField)) {
        yield state(stream.name, { cursor: maxCursor });
      }
    }
  }
}

module.exports = new FileSource();
