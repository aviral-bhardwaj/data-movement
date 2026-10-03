const { BaseDestination } = require('../base');
const { sanitizeName } = require('../../engine/normalize');

// Azure Blob Storage destination — lands each stream as a JSONL blob.
// Lazily loads @azure/storage-blob.
let sdk = null;
function driver() {
  if (!sdk) {
    try { sdk = require('@azure/storage-blob'); }
    catch { throw new Error('Azure Blob destination requires "@azure/storage-blob": npm i @azure/storage-blob'); }
  }
  return sdk;
}

class AzureBlobDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-azure-blob';
    this.displayName = 'Azure Blob Storage';
    this.description = 'Write streams as JSONL blobs to an Azure Blob container.';
    this.icon = '🟦';
    this.category = 'Data Lake';
    this.catalogSlug = 'azure-blob-storage';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['container'],
        properties: {
          container: { type: 'string' },
          prefix: { type: 'string', default: 'datamove' },
          connectionString: { type: 'string', airbyte_secret: true, title: 'Storage connection string' },
          accountName: { type: 'string' },
          accountKey: { type: 'string', airbyte_secret: true },
        },
      },
    };
  }

  _container(cfg) {
    const { BlobServiceClient, StorageSharedKeyCredential } = driver();
    let svc;
    if (cfg.connectionString) {
      svc = BlobServiceClient.fromConnectionString(cfg.connectionString);
    } else {
      const cred = new StorageSharedKeyCredential(cfg.accountName, cfg.accountKey);
      svc = new BlobServiceClient(`https://${cfg.accountName}.blob.core.windows.net`, cred);
    }
    return svc.getContainerClient(cfg.container);
  }

  async check(cfg) {
    try {
      const exists = await this._container(cfg).exists();
      return exists ? { status: 'SUCCEEDED' } : { status: 'FAILED', message: 'container does not exist' };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const container = this._container(cfg);
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
        const blob = container.getBlockBlobClient(key);
        await blob.upload(lines.join('\n') + '\n', lines.join('\n').length + 1, { blobHTTPHeaders: { blobContentType: 'application/x-ndjson' } });
        ctx.logger?.('info', `uploaded ${lines.length} records -> azure://${cfg.container}/${key}`);
      } catch (e) {
        stats.streams[stream].failed += lines.length;
        stats.streams[stream].written = 0;
        ctx.logger?.('error', `azure upload failed for ${stream}: ${e.message}`);
      }
    }
    return stats;
  }
}

module.exports = new AzureBlobDestination();
