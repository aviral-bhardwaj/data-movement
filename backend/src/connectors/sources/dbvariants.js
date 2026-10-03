// Managed/cloud database variants. These are wire-compatible with the base
// connectors (same protocol, different product) — exactly how the commercial
// platforms model them — so each variant subclasses the base implementation
// and only renames itself and links to the right catalog entry.

const { PostgresSource } = require('./postgres');
const { MysqlSource } = require('./mysql');
const { MongodbSource } = require('./mongodb');
const { MssqlSource } = require('./mssql');
const { OracleSource } = require('./oracle');

function variant(Base, { name, displayName, catalogSlug, catalogName, description, icon }) {
  class V extends Base {
    constructor() {
      super();
      this.name = name;
      this.displayName = displayName;
      this.catalogSlug = catalogSlug;
      this.catalogName = catalogName || displayName;
      this.description = description || `Sync tables from ${displayName} (${Base.prototype?.constructor?.name || 'base'} protocol).`;
      if (icon) this.icon = icon;
      this.category = 'Databases';
    }
  }
  return new V();
}

module.exports = [
  // ---- PostgreSQL wire protocol ----
  variant(PostgresSource, { name: 'source-aurora-postgres', displayName: 'Aurora PostgreSQL', catalogSlug: 'postgresql', icon: '🐘', description: 'Amazon Aurora PostgreSQL via the PostgreSQL wire protocol (full, incremental, CDC).' }),
  variant(PostgresSource, { name: 'source-azure-postgres', displayName: 'Azure PostgreSQL', catalogSlug: 'postgresql', icon: '🐘', description: 'Azure Database for PostgreSQL (full, incremental, CDC).' }),
  variant(PostgresSource, { name: 'source-gcp-postgres', displayName: 'Google Cloud PostgreSQL', catalogSlug: 'postgresql', icon: '🐘', description: 'Cloud SQL for PostgreSQL (full, incremental, CDC).' }),
  variant(PostgresSource, { name: 'source-heroku-postgres', displayName: 'Heroku Postgres', catalogSlug: 'postgresql', icon: '🐘', description: 'Heroku Postgres (full, incremental).' }),
  variant(PostgresSource, { name: 'source-rds-postgres', displayName: 'PostgreSQL RDS', catalogSlug: 'postgresql', icon: '🐘', description: 'Amazon RDS for PostgreSQL (full, incremental, CDC).' }),
  variant(PostgresSource, { name: 'source-cockroachdb', displayName: 'CockroachDB', catalogSlug: 'cockroachdb', icon: '🪳', description: 'CockroachDB via the PostgreSQL wire protocol (full, incremental).' }),

  // ---- MySQL wire protocol ----
  variant(MysqlSource, { name: 'source-mariadb', displayName: 'MariaDB', catalogSlug: 'mariadb', catalogName: 'MariaDB', icon: '🐬', description: 'MariaDB via the MySQL wire protocol.' }),
  variant(MysqlSource, { name: 'source-aurora-mysql', displayName: 'Amazon Aurora MySQL', catalogSlug: 'mysql', icon: '🐬' }),
  variant(MysqlSource, { name: 'source-azure-mysql', displayName: 'Azure Database for MySQL', catalogSlug: 'mysql', icon: '🐬' }),
  variant(MysqlSource, { name: 'source-gcp-mysql', displayName: 'Google Cloud SQL for MySQL', catalogSlug: 'mysql', icon: '🐬' }),
  variant(MysqlSource, { name: 'source-rds-mysql', displayName: 'MySQL RDS', catalogSlug: 'mysql', icon: '🐬' }),
  variant(MysqlSource, { name: 'source-planetscale', displayName: 'PlanetScale', catalogSlug: 'planetscale', icon: '🌐', description: 'PlanetScale via the MySQL wire protocol (full, incremental).' }),
  variant(MysqlSource, { name: 'source-singlestore', displayName: 'SingleStore', catalogSlug: 'singlestore', icon: '🐬', description: 'SingleStore (MemSQL) via the MySQL wire protocol.' }),

  // ---- SQL Server (TDS) ----
  variant(MssqlSource, { name: 'source-sqlserver-rds', displayName: 'Amazon RDS for SQL Server', catalogSlug: 'sql-server', icon: '🗄️' }),
  variant(MssqlSource, { name: 'source-azure-sql-db', displayName: 'Azure SQL Database', catalogSlug: 'sql-server', icon: '🗄️' }),
  variant(MssqlSource, { name: 'source-azure-sql-mi', displayName: 'Azure SQL Managed Instance', catalogSlug: 'sql-server', icon: '🗄️' }),
  variant(MssqlSource, { name: 'source-gcp-sqlserver', displayName: 'Google Cloud SQL for SQL Server', catalogSlug: 'sql-server', icon: '🗄️' }),

  // ---- Oracle ----
  variant(OracleSource, { name: 'source-oracle-rac', displayName: 'Oracle RAC', catalogSlug: 'oracle', icon: '🔶' }),
  variant(OracleSource, { name: 'source-oracle-rds', displayName: 'Oracle RDS', catalogSlug: 'oracle', icon: '🔶' }),

  // ---- MongoDB ----
  variant(MongodbSource, { name: 'source-mongodb-sharded', displayName: 'MongoDB Sharded', catalogSlug: 'mongodb', icon: '🍃', description: 'Sharded MongoDB cluster (full, incremental on replica keys).' }),
];
