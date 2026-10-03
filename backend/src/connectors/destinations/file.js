const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const { BaseDestination } = require('../base');
const { sanitizeName } = require('../../engine/normalize');
const config = require('../../core/config');

// File destination: writes each stream to CSV or JSONL in a directory.
class FileDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-file';
    this.displayName = 'File (CSV/JSONL)';
    this.description = 'Write streams to local CSV or JSONL files, one file per stream per sync.';
    this.icon = '📁';
    this.category = 'File';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['directory', 'format'],
        properties: {
          directory: { type: 'string', default: './data/out' },
          format: { type: 'string', enum: ['jsonl', 'csv'], default: 'jsonl' },
        },
      },
    };
  }

  _dir(cfg) {
    const d = path.isAbsolute(cfg.directory) ? cfg.directory : path.join(config.dataDir, cfg.directory);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  async check(cfg) {
    try {
      const d = this._dir(cfg);
      fs.accessSync(d, fs.constants.W_OK);
      return { status: 'SUCCEEDED', message: d };
    } catch (e) { return { status: 'FAILED', message: e.message }; }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const dir = this._dir(cfg);
    const stats = { streams: {}, bytes: 0 };
    const streams = new Map();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    const getStream = (streamName) => {
      if (!streams.has(streamName)) {
        const sc = catalog.streams.find((s) => s.name === streamName) || {};
        const fname = `${sanitizeName(sc.destinationName || streamName)}_${ts}.${cfg.format || 'jsonl'}`;
        const file = path.join(dir, fname);
        streams.set(streamName, { file, columns: new Set(), rows: [] });
      }
      return streams.get(streamName);
    };

    for await (const msg of messageStream) {
      if (msg.type === 'STATE') {
        if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state);
        continue;
      }
      if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
      if (msg.type !== 'RECORD') continue;
      const s = getStream(msg.stream);
      s.rows.push(msg.data);
      for (const k of Object.keys(msg.data)) s.columns.add(k);
      const st = (stats.streams[msg.stream] ||= { written: 0, failed: 0 });
      st.written++;
      stats.bytes += JSON.stringify(msg.data).length;
    }

    for (const [name, s] of streams) {
      try {
        if ((cfg.format || 'jsonl') === 'jsonl') {
          fs.writeFileSync(s.file, s.rows.map((r) => JSON.stringify(r)).join('\n') + (s.rows.length ? '\n' : ''));
        } else {
          fs.writeFileSync(s.file, stringify(s.rows, { header: true, columns: [...s.columns] }));
        }
        ctx.logger?.('info', `wrote ${s.rows.length} rows -> ${s.file}`);
      } catch (e) {
        (stats.streams[name] ||= { written: 0, failed: 0 }).failed += s.rows.length;
        (stats.streams[name]).written = 0;
        ctx.logger?.('error', `write ${s.file} failed: ${e.message}`);
      }
    }
    return stats;
  }
}

module.exports = new FileDestination();
