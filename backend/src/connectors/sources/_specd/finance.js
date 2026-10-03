// Accounting & billing specs.

module.exports = [
  {
    name: 'source-quickbooks',
    displayName: 'QuickBooks',
    description: 'Customers, invoices, payments, items and accounts via QBO query API.',
    catalogSlug: 'quickbooks', category: 'Applications', icon: 'quickbooks',
    baseUrl: 'https://quickbooks.api.intuit.com/v3/company/{realmId}',
    auth: { type: 'bearer' },
    headers: { Accept: 'application/json' },
    config: [
      { key: 'realmId', title: 'Company (Realm) ID', required: true },
      { key: 'accessToken', title: 'OAuth access token', secret: true, required: true },
      { key: 'sandbox', title: 'Sandbox', type: 'boolean', default: false },
    ],
    check: { path: '/companyinfo/{realmId}' },
    resources: ['Customer', 'Invoice', 'Payment', 'Item', 'Account', 'Vendor', 'Bill', 'Purchase', 'Employee', 'Estimate'].map((e) => ({
      name: e.toLowerCase(),
      path: '/query',
      // QBO pages inside the SQL text (STARTPOSITION/MAXRESULTS), not via params
      params: (_cfg, ctx) => ({
        query: `SELECT * FROM ${e} ORDERBY MetaData.LastUpdatedTime ASC STARTPOSITION ${ctx.offset + 1} MAXRESULTS 1000`,
      }),
      recordsPath: `QueryResponse.${e}`,
      primaryKey: 'Id',
      cursorField: 'MetaData.LastUpdatedTime',
      filterClientSide: true,
      pagination: { type: 'offset', pageSize: 1000 },
    })),
  },

  {
    name: 'source-xero',
    displayName: 'Xero',
    description: 'Contacts, invoices, payments, accounts and bank transactions.',
    catalogSlug: 'xero', category: 'Applications', icon: 'xero',
    baseUrl: 'https://api.xero.com/api.xro/2.0',
    auth: { type: 'bearer' },
    headers: { 'xero-tenant-id': '{tenantId}', Accept: 'application/json' },
    config: [
      { key: 'tenantId', title: 'Tenant ID', required: true },
      { key: 'accessToken', title: 'OAuth access token', secret: true, required: true },
    ],
    check: { path: '/Organisation' },
    resources: [
      { name: 'contacts', path: '/Contacts', recordsPath: 'Contacts', primaryKey: 'ContactID', cursorField: 'UpdatedDateUTC', filterClientSide: true, pagination: { type: 'page', pageParam: 'page', pageSize: 100 } },
      { name: 'invoices', path: '/Invoices', recordsPath: 'Invoices', primaryKey: 'InvoiceID', cursorField: 'UpdatedDateUTC', filterClientSide: true, pagination: { type: 'page', pageParam: 'page', pageSize: 100 } },
      { name: 'payments', path: '/Payments', recordsPath: 'Payments', primaryKey: 'PaymentID', cursorField: 'UpdatedDateUTC', filterClientSide: true, pagination: { type: 'page', pageParam: 'page', pageSize: 100 } },
      { name: 'accounts', path: '/Accounts', recordsPath: 'Accounts', primaryKey: 'AccountID' },
      { name: 'bank_transactions', path: '/BankTransactions', recordsPath: 'BankTransactions', primaryKey: 'BankTransactionID', cursorField: 'UpdatedDateUTC', filterClientSide: true, pagination: { type: 'page', pageParam: 'page', pageSize: 100 } },
      { name: 'items', path: '/Items', recordsPath: 'Items', primaryKey: 'ItemID', cursorField: 'UpdatedDateUTC', filterClientSide: true, pagination: { type: 'page', pageParam: 'page', pageSize: 100 } },
      { name: 'journals', path: '/Journals', recordsPath: 'Journals', primaryKey: 'JournalID', cursorField: 'CreatedDateUTC', filterClientSide: true, pagination: { type: 'offset', offsetParam: 'offset', pageSize: 100 } },
      { name: 'purchase_orders', path: '/PurchaseOrders', recordsPath: 'PurchaseOrders', primaryKey: 'PurchaseOrderID', cursorField: 'UpdatedDateUTC', filterClientSide: true, pagination: { type: 'page', pageParam: 'page', pageSize: 100 } },
    ],
  },

  {
    name: 'source-zuora',
    displayName: 'Zuora',
    description: 'Accounts, subscriptions, invoices and payments via Zuora query.',
    catalogSlug: 'zuora', category: 'Applications', icon: 'zuora',
    baseUrl: 'https://rest.zuora.com',
    auth: {
      type: 'oauth2_cc',
      tokenUrl: 'https://rest.zuora.com/oauth/token',
      extraParams: {},
    },
    config: [
      { key: 'clientId', title: 'Client ID', required: true },
      { key: 'clientSecret', title: 'Client secret', secret: true, required: true },
      { key: 'sandbox', title: 'Sandbox', type: 'boolean', default: false },
    ],
    check: { path: '/v1/accounts', params: { pageSize: 1 } },
    resources: ['Account', 'Subscription', 'Invoice', 'Payment', 'Product', 'RatePlan', 'Amendment', 'CreditMemo'].map((e) => ({
      name: e.toLowerCase(),
      path: '/v1/action/query',
      method: 'POST',
      body: { queryString: `select Id, Name, Status, CreatedDate, UpdatedDate from ${e}` },
      recordsPath: 'records',
      primaryKey: 'Id',
      cursorField: 'UpdatedDate',
      filterClientSide: true,
    })),
  },

  {
    name: 'source-freshbooks',
    displayName: 'FreshBooks',
    description: 'Clients, invoices, expenses, payments and estimates.',
    catalogSlug: 'freshbooks', category: 'Applications', icon: 'freshbooks',
    baseUrl: 'https://api.freshbooks.com',
    auth: { type: 'bearer' },
    headers: { Accept: 'application/json' },
    config: [
      { key: 'accountId', title: 'Account ID', required: true },
      { key: 'accessToken', title: 'OAuth access token', secret: true, required: true },
    ],
    check: { path: '/auth/api/v1/users/me' },
    resources: [
      { name: 'clients', path: '/accounting/account/{accountId}/users/clients', recordsPath: 'response.result.clients', primaryKey: 'id', cursorField: 'updated', incrementalParam: 'updated_since', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 } },
      { name: 'invoices', path: '/accounting/account/{accountId}/invoices/invoices', recordsPath: 'response.result.invoices', primaryKey: 'invoiceid', cursorField: 'updated', incrementalParam: 'updated_since', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 } },
      { name: 'expenses', path: '/accounting/account/{accountId}/expenses/expenses', recordsPath: 'response.result.expenses', primaryKey: 'expenseid', cursorField: 'updated', incrementalParam: 'updated_since', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 } },
      { name: 'payments', path: '/accounting/account/{accountId}/payments/payments', recordsPath: 'response.result.payments', primaryKey: 'id', cursorField: 'updated', incrementalParam: 'updated_since', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 } },
      { name: 'estimates', path: '/accounting/account/{accountId}/estimates/estimates', recordsPath: 'response.result.estimates', primaryKey: 'estimateid', cursorField: 'updated', incrementalParam: 'updated_since', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 } },
      { name: 'items', path: '/accounting/account/{accountId}/items/items', recordsPath: 'response.result.items', primaryKey: 'id', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 } },
      { name: 'staff', path: '/accounting/account/{accountId}/users/staffs', recordsPath: 'response.result.staff', primaryKey: 'id', pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', pageSize: 100 } },
    ],
  },
];
