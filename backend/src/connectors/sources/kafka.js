const { Kafka } = require('kafkajs');
const { BaseSource, record, state } = require('../base');

// Kafka source: consumes up to maxMessages (or until idle) per sync run.
class KafkaSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-kafka';
    this.displayName = 'Kafka';
    this.description = 'Consume messages from Kafka topics. JSON payloads become records.';
    this.icon = '📨';
    this.category = 'Events';
    this.catalogSlug = 'apache-kafka';
    this.supportedSyncModes = ['full_refresh'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['brokers', 'topic'],
        properties: {
          brokers: { type: 'string', title: 'Comma-separated brokers', default: 'localhost:9092' },
          topic: { type: 'string' },
          groupId: { type: 'string', default: 'datamove' },
          fromBeginning: { type: 'boolean', default: false },
          maxMessages: { type: 'integer', default: 10000 },
          idleSeconds: { type: 'integer', default: 15 },
          saslUsername: { type: 'string' },
          saslPassword: { type: 'string', airbyte_secret: true },
        },
      },
    };
  }

  _kafka(cfg) {
    const opts = { clientId: 'datamove', brokers: String(cfg.brokers).split(',') };
    if (cfg.saslUsername) {
      opts.sasl = { mechanism: 'plain', username: cfg.saslUsername, password: cfg.saslPassword || '' };
    }
    return new Kafka(opts);
  }

  async check(cfg) {
    const admin = this._kafka(cfg).admin();
    try { await admin.connect(); await admin.fetchTopicMetadata({ topics: [cfg.topic] }); return { status: 'SUCCEEDED' }; }
    catch (e) { return { status: 'FAILED', message: e.message }; }
    finally { await admin.disconnect().catch(() => {}); }
  }

  async discover(cfg) {
    return {
      streams: [{
        name: String(cfg.topic).replace(/[^a-zA-Z0-9_]/g, '_'), namespace: 'kafka',
        jsonSchema: { type: 'object', properties: { _key: { type: 'string' }, _offset: { type: 'string' }, _partition: { type: 'integer' }, _timestamp: { type: 'string', format: 'date-time' }, value: { type: 'object' } } },
        supportedSyncModes: this.supportedSyncModes,
        sourceDefinedPrimaryKey: ['_offset'],
        availableCursorFields: ['_timestamp'],
      }],
    };
  }

  async *read(cfg, catalog, _state, _ctx) {
    const stream = catalog.streams[0];
    const consumer = this._kafka(cfg).consumer({ groupId: cfg.groupId || 'datamove' });
    const max = cfg.maxMessages || 10000;
    const idleMs = (cfg.idleSeconds || 15) * 1000;
    const queue = [];
    let resolveWait, stopped = false, lastOffset;
    await consumer.connect();
    await consumer.subscribe({ topic: cfg.topic, fromBeginning: !!cfg.fromBeginning });
    await consumer.run({
      autoCommit: true,
      eachMessage: async ({ message, partition }) => {
        queue.push({ message, partition });
        if (queue.length >= max) stopped = true;
        if (resolveWait) { resolveWait(); resolveWait = null; }
      },
    });
    try {
      const deadline = Date.now() + idleMs;
      while (!stopped && Date.now() < deadline) {
        if (!queue.length) {
          await Promise.race([new Promise((r) => { resolveWait = r; }), new Promise((r) => setTimeout(r, 500))]);
          if (!queue.length && Date.now() >= deadline) break;
          continue;
        }
        const { message, partition } = queue.shift();
        let value;
        const raw = message.value?.toString('utf8');
        try { value = JSON.parse(raw); } catch { value = raw; }
        lastOffset = message.offset;
        yield record(stream?.name || 'messages', {
          _key: message.key?.toString('utf8') || null,
          _offset: message.offset,
          _partition: partition,
          _timestamp: new Date(Number(message.timestamp)).toISOString(),
          value,
        }, { namespace: 'kafka' });
      }
    } finally {
      await consumer.disconnect().catch(() => {});
    }
    if (lastOffset) yield state(stream?.name || 'messages', { cursor: lastOffset });
  }
}

module.exports = new KafkaSource();
