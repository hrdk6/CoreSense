import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import pg from 'pg';

// Parse Postgres BIGINT (OID 20) & NUMERIC (OID 1700) to JS numbers for seamless parity with SQLite
pg.types.setTypeParser(20, (val: string) => Number(val));
pg.types.setTypeParser(1700, (val: string) => Number(val));

export interface DbRunResult {
  changes: number;
  lastInsertRowid?: number;
}

export interface DbAdapter {
  readonly dialect: 'sqlite' | 'postgres';
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<DbRunResult>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Converts SQLite-style `?` positional placeholders and `INSERT OR IGNORE`
 * into PostgreSQL `$1, $2, ...` placeholders and `ON CONFLICT DO NOTHING`,
 * safely skipping single-quoted string literals.
 */
export function translateSqlForPostgres(sql: string): string {
  let out = '';
  let paramIdx = 1;
  let inSingleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch;
      if (inSingleQuote && sql[i + 1] === "'") {
        // Escaped single quote inside string literal
        out += sql[++i];
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }
    if (!inSingleQuote && ch === '?') {
      out += `$${paramIdx++}`;
      continue;
    }
    out += ch;
  }

  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(out)) {
    out = out.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
    if (!/\bON\s+CONFLICT\b/i.test(out)) {
      out = `${out.replace(/;\s*$/, '')} ON CONFLICT DO NOTHING`;
    }
  }

  return out;
}

export class SqliteAdapter implements DbAdapter {
  public readonly dialect = 'sqlite' as const;
  private readonly sqlite: DatabaseSync;

  constructor(dbPath: string) {
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec('PRAGMA journal_mode = WAL;');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
  }

  public async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.sqlite.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }

  public async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.sqlite.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  public async run(sql: string, ...params: unknown[]): Promise<DbRunResult> {
    const info = this.sqlite.prepare(sql).run(...(params as SQLInputValue[]));
    return {
      changes: Number(info.changes ?? 0),
      lastInsertRowid: info.lastInsertRowid !== undefined ? Number(info.lastInsertRowid) : undefined,
    };
  }

  public async exec(sql: string): Promise<void> {
    this.sqlite.exec(sql);
  }

  public async close(): Promise<void> {
    this.sqlite.close();
  }
}

export class PostgresAdapter implements DbAdapter {
  public readonly dialect = 'postgres' as const;
  public readonly schemaName: string;
  private readonly pool: pg.Pool;
  private readonly initializedClients = new WeakSet<pg.PoolClient>();

  constructor(connectionString: string, schemaName: 'customer_workspace' | 'owner_observability') {
    this.schemaName = schemaName;
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false },
    });
  }

  private async withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      if (!this.initializedClients.has(client)) {
        await client.query(`SET search_path TO ${this.schemaName}, public`);
        this.initializedClients.add(client);
      }
      return await fn(client);
    } finally {
      client.release();
    }
  }

  public async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaName}`);
      await client.query(`SET search_path TO ${this.schemaName}, public`);
      this.initializedClients.add(client);
    } finally {
      client.release();
    }
  }

  public async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const pgSql = translateSqlForPostgres(sql);
    const res = await this.withClient((client) => client.query(pgSql, params));
    return (res.rows[0] as T | undefined) ?? undefined;
  }

  public async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const pgSql = translateSqlForPostgres(sql);
    const res = await this.withClient((client) => client.query(pgSql, params));
    return res.rows as T[];
  }

  public async run(sql: string, ...params: unknown[]): Promise<DbRunResult> {
    const pgSql = translateSqlForPostgres(sql);
    const res = await this.withClient((client) => client.query(pgSql, params));
    return { changes: Number(res.rowCount ?? 0) };
  }

  public async exec(sql: string): Promise<void> {
    await this.withClient((client) => client.query(sql));
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
