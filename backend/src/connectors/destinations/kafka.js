const { Kafka } = require('kafkajs');
const { BaseDestination } = require('../base');
const { sanitizeName } = require('../../engine/normalize');

// Kafka destination — publishes each record as a JSON message.
// Topic per stream: <prefix>-<stream>.
class KafkaDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-kafka';
    this.displayName = 'Apache Kafka';
    this.description = 'Publish each synced record as a JSON message to per-stream topics.';
    this.icon = '📨';
    this.category = 'Streaming';
    this.catalogSlug = 'apache-kafka';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['brokers'],
        properties: {
          brokers: { type: 'string', title: 'Brokers (comma-separated)', default: 'localhost:9092' },
          topicPrefix: { type: 'string', default: 'datamove' },
          singleTopic: { type: 'string', title: 'Route all streams to one topic (overrides prefix)' },
          clientId: { type: 'string', default: 'datamove-destination' },
          ssl: { type: 'boolean', default: false },
          saslUsername: { type: 'string' },
          saslPassword: { type: 'string', airbyte_secret: true },
          saslMechanism: { type: 'string', enum: ['plain', 'scram-sha-256', 'scram-sha-512'], default: 'plain' },
          keyField: { type: 'string', title: 'Record field used as message key' },
        },
      },
    };
  }

  _client(cfg) {
    return new Kafka({
      clientId: cfg.clientId || 'datamove-destination',
      brokers: String(cfg.brokers || 'localhost:9092').split(',').map((b) => b.trim()),
      ssl: cfg.ssl || undefined,
      sasl: cfg.saslUsername
        ? { mechanism: cfg.saslMechanism || 'plain', username: cfg.saslUsername, password: cfg.saslPassword || '' }
        : undefined,
    });
  }

  _topic(cfg, stream) {
    return cfg.singleTopic || `${cfg.topicPrefix || 'datamove'}-${sanitizeName(stream)}`;
  }

  async check(cfg) {
    const admin = this._client(cfg).admin();
    try {
      await admin.connect();
      const meta = await admin.fetchMetadata();
      return { status: 'SUCCEEDED', message: `${meta.brokers?.length || 0} broker(s)` };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    } finally { await admin.disconnect().catch(() => {}); }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const producer = this._client(cfg).producer();
    await producer.connect();
    const stats = { streams: {}, bytes: 0 };
    const pending = new Map(); // topic -> messages[]

    const flush = async (topic) => {
      const msgs = pending.get(topic);
      if (!msgs?.length) return;
      pending.set(topic, []);
      await producer.send({ topic, messages: msgs });
    };

    try {
      for await (const msg of messageStream) {
        if (msg.type === 'STATE') {
          for (const t of [...pending.keys()]) await flush(t);
          if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state);
          continue;
        }
        if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
        if (msg.type !== 'RECORD') continue;
        const st = (stats.streams[msg.stream] ||= { written: 0, failed: 0 });
        const topic = this._topic(cfg, msg.stream);
        const buf = pending.get(topic) || [];
        const payload = JSON.stringify({
          _stream: msg.stream,
          _emitted_at: msg.emittedAt,
          _cdc: msg.cdc || undefined,
          data: msg.data,
        });
        buf.push({
          key: cfg.keyField && msg.data?.[cfg.keyField] !== undefined ? String(msg.data[cfg.keyField]) : undefined,
          value: payload,
        });
        pending.set(topic, buf);
        st.written++;
        stats.bytes += payload.length;
        if (buf.length >= (ctx.batchSize || 500)) await flush(topic);
      }
      for (const t of [...pending.keys()]) await flush(t);
    } finally {
      await producer.disconnect().catch(() => {});
    }
    return stats;
  }
}

module.exports = new KafkaDestination();
