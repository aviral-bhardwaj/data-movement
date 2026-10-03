const { BaseDestination } = require('../base');
const { sanitizeName } = require('../../engine/normalize');

// Google Cloud Storage destination — lands each stream as a JSONL object.
// Lazily loads @google-cloud/storage.
let sdk = null;
function driver() {
  if (!sdk) {
    try { sdk = require('@google-cloud/storage'); }
    catch { throw new Error('GCS destination requires "@google-cloud/storage": npm i @google-cloud/storage'); }
  }
  return sdk;
}

class GcsDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-gcs';
    this.displayName = 'Google Cloud Storage';
    this.description = 'Write streams as JSONL objects to a Google Cloud Storage bucket.';
    this.icon = '☁️';
    this.category = 'Data Lake';
    this.catalogSlug = 'google-cloud-storage';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['bucket'],
        properties: {
          bucket: { type: 'string' },
          prefix: { type: 'string', default: 'datamove' },
          projectId: { type: 'string' },
          credentialsJson: { type: 'string', title: 'Service account JSON', airbyte_secret: true },
        },
      },
    };
  }

  _bucket(cfg) {
    const { Storage } = driver();
    const opts = {};
    if (cfg.projectId) opts.projectId = cfg.projectId;
    if (cfg.credentialsJson) opts.credentials = JSON.parse(cfg.credentialsJson);
    return new Storage(opts).bucket(cfg.bucket);
  }

  async check(cfg) {
    try {
      const [exists] = await this._bucket(cfg).exists();
      return exists ? { status: 'SUCCEEDED' } : { status: 'FAILED', message: 'bucket does not exist' };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const bucket = this._bucket(cfg);
    const stats = { streams: {}, bytes: 0 };
    const buffers = new Map();
    const prefix = (cfg.prefix || 'datamove').replace(/\/+$/, '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    for await (const msg of messageStream) {
      if (msg.type === 'STATE') { if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state); continue; }
      if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
      if (msg.type !== 'RECORD') continue;
      const buf = buffers.get(msg.stream) || [];
      buf.push(JSON.stringify(msg.data));
      buffers.set(msg.stream, buf);
      stats.bytes += buf[buf.length - 1].length;
      (stats.streams[msg.stream] ||= { written: 0, failed: 0 }).written++;
    }

    for (const [stream, lines] of buffers) {
      const sc = catalog.streams.find((s) => s.name === stream) || {};
      const key = `${prefix}/${sanitizeName(sc.destinationName || stream)}/${ts}.jsonl`;
      try {
        await bucket.file(key).save(lines.join('\n') + '\n', { contentType: 'application/x-ndjson', resumable: false });
        ctx.logger?.('info', `uploaded ${lines.length} records -> gs://${cfg.bucket}/${key}`);
      } catch (e) {
        stats.streams[stream].failed += lines.length;
        stats.streams[stream].written = 0;
        ctx.logger?.('error', `gcs upload failed for ${stream}: ${e.message}`);
      }
    }
    return stats;
  }
}

module.exports = new GcsDestination();
