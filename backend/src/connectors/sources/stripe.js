const axios = require('axios');
const { BaseSource, record, state, log } = require('../base');

const STREAMS = {
  customers: { path: '/v1/customers', cursor: 'created', pk: 'id' },
  charges: { path: '/v1/charges', cursor: 'created', pk: 'id' },
  invoices: { path: '/v1/invoices', cursor: 'created', pk: 'id' },
  subscriptions: { path: '/v1/subscriptions', cursor: 'created', pk: 'id' },
  products: { path: '/v1/products', cursor: 'created', pk: 'id' },
  payouts: { path: '/v1/payouts', cursor: 'created', pk: 'id' },
  refunds: { path: '/v1/refunds', cursor: 'created', pk: 'id' },
  balance_transactions: { path: '/v1/balance_transactions', cursor: 'created', pk: 'id' },
  events: { path: '/v1/events', cursor: 'created', pk: 'id' },
};

class StripeSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-stripe';
    this.displayName = 'Stripe';
    this.description = 'Sync Stripe objects (customers, charges, invoices, subscriptions...) with incremental support on created timestamp.';
    this.icon = '💳';
    this.category = 'Applications';
    this.catalogSlug = 'stripe';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['secretKey'],
        properties: {
          secretKey: { type: 'string', title: 'Secret API key (sk_...)', airbyte_secret: true },
          startDate: { type: 'string', title: 'Start date (ISO, for incremental)', format: 'date' },
        },
      },
    };
  }

  async check(cfg) {
    try {
      await axios.get('https://api.stripe.com/v1/customers', {
        params: { limit: 1 }, headers: { Authorization: `Bearer ${cfg.secretKey}` }, timeout: 15000,
      });
      return { status: 'SUCCEEDED' };
    } catch (e) {
      return { status: 'FAILED', message: e.response?.data?.error?.message || e.message };
    }
  }

  async discover() {
    return {
      streams: Object.entries(STREAMS).map(([name, s]) => ({
        name, namespace: 'stripe',
        jsonSchema: { type: 'object', properties: { id: { type: 'string' }, created: { type: 'integer' }, object: { type: 'string' } }, additionalProperties: true },
        supportedSyncModes: this.supportedSyncModes,
        sourceDefinedPrimaryKey: [s.pk],
        availableCursorFields: [s.cursor],
        defaultCursorField: s.cursor,
      })),
    };
  }

  async *read(cfg, catalog, state, _ctx) {
    const headers = { Authorization: `Bearer ${cfg.secretKey}` };
    for (const stream of catalog.streams) {
      const def = STREAMS[stream.name];
      if (!def) { yield log('warn', `unknown stripe stream ${stream.name}`); continue; }
      const st = state?.[stream.name] || {};
      let maxCursor = st.cursor;
      let startingAfter;
      for (let page = 0; page < 10000; page++) {
        const params = { limit: 100 };
        if (startingAfter) params.starting_after = startingAfter;
        if (stream.syncMode === 'incremental' && st.cursor !== undefined) {
          params['created[gt]'] = st.cursor;
        } else if (cfg.startDate) {
          params['created[gte]'] = Math.floor(new Date(cfg.startDate).getTime() / 1000);
        }
        const res = await axios.get(`https://api.stripe.com${def.path}`, {
          params, headers, timeout: 30000,
          validateStatus: (s) => s < 500,
        });
        if (res.status >= 400) {
          throw new Error(`stripe ${stream.name}: HTTP ${res.status} ${res.data?.error?.message || ''}`);
        }
        const rows = res.data?.data || [];
        for (const row of rows) {
          if (row.created !== undefined && (maxCursor === undefined || row.created > maxCursor)) maxCursor = row.created;
          yield record(stream.name, row, { namespace: 'stripe' });
        }
        if (!res.data?.has_more || !rows.length) break;
        startingAfter = rows[rows.length - 1].id;
        await sleep(80); // stay under 100 req/s
      }
      if (stream.syncMode === 'incremental') yield state(stream.name, { cursor: maxCursor });
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = new StripeSource();
