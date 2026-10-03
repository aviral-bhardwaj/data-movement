const { BaseSource, record, state, log } = require('../base');

// DynamoDB source — lazily loads @aws-sdk/client-dynamodb, scans tables.
let sdk = null;
function driver() {
  if (!sdk) {
    try { sdk = require('@aws-sdk/client-dynamodb'); }
    catch { throw new Error('DynamoDB connector requires "@aws-sdk/client-dynamodb": npm i @aws-sdk/client-dynamodb'); }
  }
  return sdk;
}

// DynamoDB AttributeValue -> plain JS
function unmarshall(item) {
  const out = {};
  for (const [k, v] of Object.entries(item || {})) {
    const [type, val] = Object.entries(v)[0] || [];
    switch (type) {
      case 'S': out[k] = val; break;
      case 'N': out[k] = Number(val); break;
      case 'BOOL': out[k] = val; break;
      case 'NULL': out[k] = null; break;
      case 'L': out[k] = val.map(unmarshall); break;
      case 'M': out[k] = unmarshall(val); break;
      case 'SS': out[k] = val; break;
      case 'NS': out[k] = val.map(Number); break;
      case 'BS': out[k] = val; break;
      default: out[k] = val;
    }
  }
  return out;
}

class DynamodbSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-dynamodb';
    this.displayName = 'Amazon DynamoDB';
    this.description = 'Scan DynamoDB tables into records (full refresh or key-based incremental).';
    this.icon = '⚡';
    this.category = 'Databases';
    this.catalogSlug = 'dynamodb';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['region'],
        properties: {
          region: { type: 'string', default: 'us-east-1' },
          accessKeyId: { type: 'string', airbyte_secret: true },
          secretAccessKey: { type: 'string', airbyte_secret: true },
          endpoint: { type: 'string', title: 'Custom endpoint (DynamoDB Local)' },
        },
      },
    };
  }

  _client(cfg) {
    const { DynamoDBClient } = driver();
    return new DynamoDBClient({
      region: cfg.region || 'us-east-1',
      endpoint: cfg.endpoint || undefined,
      credentials: cfg.accessKeyId
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey || '' }
        : undefined,
    });
  }

  async check(cfg) {
    try {
      const { ListTablesCommand } = driver();
      const c = this._client(cfg);
      const res = await c.send(new ListTablesCommand({ Limit: 1 }));
      return { status: 'SUCCEEDED', message: `${res.TableNames?.length ?? 0} tables reachable` };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    }
  }

  async discover(cfg) {
    const { ListTablesCommand, DescribeTableCommand } = driver();
    const c = this._client(cfg);
    const tables = [];
    let last;
    do {
      const res = await c.send(new ListTablesCommand({ ExclusiveStartTableName: last }));
      tables.push(...(res.TableNames || []));
      last = res.LastEvaluatedTableName;
    } while (last);
    const streams = [];
    for (const name of tables.slice(0, 500)) {
      const d = await c.send(new DescribeTableCommand({ TableName: name }));
      const attrs = Object.fromEntries((d.Table?.AttributeDefinitions || []).map((a) => [a.AttributeName, a.AttributeType]));
      const pk = (d.Table?.KeySchema || []).map((k) => k.AttributeName);
      const streamsOut = {
        name, namespace: 'dynamodb',
        jsonSchema: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(attrs).map(([k, t]) => [k, t === 'N' ? { type: 'number' } : { type: 'string' }])),
        },
        supportedSyncModes: this.supportedSyncModes,
        sourceDefinedPrimaryKey: pk,
        availableCursorFields: pk.filter((k) => attrs[k] === 'N'),
      };
      streams.push(streamsOut);
    }
    return { streams };
  }

  async *read(cfg, catalog, state, _ctx) {
    const { ScanCommand } = driver();
    const c = this._client(cfg);
    for (const stream of catalog.streams) {
      const hasCursor = stream.syncMode === 'incremental' && stream.cursorField;
      const st = state?.[stream.name] || {};
      let maxCursor = st.cursor;
      let lastKey;
      do {
        const input = { TableName: stream.name, ExclusiveStartKey: lastKey };
        if (hasCursor && st.cursor !== undefined && st.cursor !== null) {
          input.FilterExpression = `#c > :c`;
          input.ExpressionAttributeNames = { '#c': stream.cursorField };
          input.ExpressionAttributeValues = { ':c': { N: String(st.cursor) } };
        }
        const res = await c.send(new ScanCommand(input));
        for (const item of res.Items || []) {
          const row = unmarshall(item);
          const cv = hasCursor ? row[stream.cursorField] : undefined;
          if (cv !== undefined && cv !== null && (maxCursor === undefined || cv > maxCursor)) maxCursor = cv;
          yield record(stream.name, row);
        }
        lastKey = res.LastEvaluatedKey;
      } while (lastKey);
      if (stream.syncMode === 'incremental' && stream.cursorField) {
        yield state(stream.name, { cursor: maxCursor });
      }
      yield log('info', `finished stream ${stream.name}`);
    }
  }
}

module.exports = new DynamodbSource();
