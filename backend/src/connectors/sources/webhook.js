const { BaseSource, record, state } = require('../base');
const redis = require('../../core/redis');

// Webhook source: the API server exposes POST /webhooks/:token which buffers
// incoming events into a Redis list; read() drains the buffer.
const KEY = (token) => `dm:webhook:${token}`;

class WebhookSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-webhook';
    this.displayName = 'Webhook';
    this.description = 'Receive push events via a generated webhook URL and sync them on schedule.';
    this.icon = '🪝';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: [],
        properties: {
          maxEvents: { type: 'integer', default: 100000, title: 'Max events drained per sync' },
        },
      },
    };
  }

  async check() { return { status: 'SUCCEEDED', message: 'webhook endpoint ready' }; }

  async discover() {
    return {
      streams: [{
        name: 'events', namespace: 'webhook',
        jsonSchema: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            _received_at: { type: 'string', format: 'date-time' },
            _headers: { type: 'object' },
            payload: { type: 'object' },
          },
        },
        supportedSyncModes: this.supportedSyncModes,
        sourceDefinedPrimaryKey: ['_id'],
        availableCursorFields: ['_received_at'],
        defaultCursorField: '_received_at',
      }],
    };
  }

  async *read(cfg, catalog, _state, ctx) {
    const token = ctx?.connection?.webhook_token;
    if (!token) throw new Error('connection has no webhook_token — recreate the connection');
    const max = cfg.maxEvents || 100000;
    let drained = 0, lastReceived = null;
    for (let i = 0; i < max; i++) {
      const raw = await redis.rpop(KEY(token));
      if (!raw) break;
      drained++;
      let evt;
      try { evt = JSON.parse(raw); } catch { evt = { payload: raw }; }
      if (evt._received_at) lastReceived = evt._received_at;
      yield record('events', evt, { namespace: 'webhook' });
    }
    yield { type: 'LOG', level: 'info', message: `drained ${drained} buffered webhook event(s)` };
    if (lastReceived) yield state('events', { cursor: lastReceived });
  }
}

module.exports = new WebhookSource();
module.exports.bufferEvent = async (token, evt) => {
  await redis.lpush(KEY(token), JSON.stringify(evt));
};
