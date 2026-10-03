// Destination variants — wire-compatible products reusing base implementations.

const { MysqlDestination } = require('./mysql');
const { MssqlDestination } = require('./mssql');

function variant(Base, { name, displayName, catalogSlug, category, badge, description, icon }) {
  class V extends Base {
    constructor() {
      super();
      this.name = name;
      this.displayName = displayName;
      this.catalogSlug = catalogSlug;
      this.category = category || 'Database';
      this.badge = badge || null;
      this.description = description || `Load data into ${displayName}.`;
      if (icon) this.icon = icon;
    }
  }
  return new V();
}

module.exports = [
  // SingleStore speaks the MySQL wire protocol
  variant(MysqlDestination, {
    name: 'destination-singlestore', displayName: 'SingleStore', catalogSlug: 'singlestore',
    badge: 'Beta', icon: '🐬', description: 'Load data into SingleStore via the MySQL protocol.',
  }),
  // Azure Synapse dedicated SQL pools speak T-SQL
  variant(MssqlDestination, {
    name: 'destination-azure-synapse', displayName: 'Azure Synapse', catalogSlug: 'azure-synapse',
    category: 'Warehouse', icon: '🟦', description: 'Load data into Azure Synapse Analytics via T-SQL.',
  }),
];
