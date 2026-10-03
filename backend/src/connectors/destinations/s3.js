const { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { BaseDestination } = require('../base');
const { sanitizeName } = require('../../engine/normalize');

// S3 destination: lands each stream as a JSONL object — data lake style.
// Works with AWS S3 and S3-compatible stores (MinIO, LocalStack, R2).
class S3Destination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-s3';
    this.displayName = 'S3 / Data Lake';
    this.description = 'Write streams as JSONL objects to S3 or any S3-compatible object store.';
    this.icon = '🪣';
    this.category = 'Data Lake';
    this.catalogSlug = 'amazon-s3';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['bucket'],
        properties: {
          bucket: { type: 'string' },
          prefix: { type: 'string', default: 'datamove' },
          region: { type: 'string', default: 'us-east-1' },
          accessKeyId: { type: 'string', airbyte_secret: true },
          secretAccessKey: { type: 'string', airbyte_secret: true },
          endpoint: { type: 'string', title: 'Custom endpoint (MinIO/LocalStack/R2)' },
          forcePathStyle: { type: 'boolean', default: false },
        },
      },
    };
  }

  _client(cfg) {
    return new S3Client({
      region: cfg.region || 'us-east-1',
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: !!cfg.forcePathStyle || !!cfg.endpoint,
      credentials: cfg.accessKeyId
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey || '' }
        : undefined,
    });
  }

  async check(cfg) {
    try {
      const c = this._client(cfg);
      await c.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      return { status: 'SUCCEEDED' };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const client = this._client(cfg);
    const stats = { streams: {}, bytes: 0 };
    const buffers = new Map();
    const prefix = (cfg.prefix || 'datamove').replace(/\/+$/, '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    const push = (stream, data) => {
      const buf = buffers.get(stream) || [];
      buf.push(JSON.stringify(data));
      buffers.set(stream, buf);
      stats.bytes += buf[buf.length - 1].length;
      (stats.streams[stream] ||= { written: 0, failed: 0 }).written++;
    };

    for await (const msg of messageStream) {
      if (msg.type === 'STATE') { if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state); continue; }
      if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
      if (msg.type === 'RECORD') push(msg.stream, msg.data);
    }

    for (const [stream, lines] of buffers) {
      const sc = catalog.streams.find((s) => s.name === stream) || {};
      const key = `${prefix}/${sanitizeName(sc.destinationName || stream)}/${ts}.jsonl`;
      try {
        await client.send(new PutObjectCommand({
          Bucket: cfg.bucket, Key: key,
          Body: lines.join('\n') + '\n', ContentType: 'application/x-ndjson',
        }));
        ctx.logger?.('info', `uploaded ${lines.length} records -> s3://${cfg.bucket}/${key}`);
      } catch (e) {
        stats.streams[stream].failed += lines.length;
        stats.streams[stream].written = 0;
        ctx.logger?.('error', `s3 put failed for ${stream}: ${e.message}`);
      }
    }
    return stats;
  }
}

module.exports = new S3Destination();
