import fs from "node:fs";
import path from "node:path";
import initSqlJs, { Database, SqlJsStatic, SqlValue } from "sql.js";

export type DbParams = Record<string, SqlValue> | SqlValue[];
export type DbRow = Record<string, SqlValue>;

const MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('super_admin','operator','support')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      password_changed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cdk_packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK(max_uses > 0),
      allowed_panel TEXT,
      allowed_category TEXT,
      validity_days INTEGER CHECK(validity_days IS NULL OR validity_days > 0),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cdk_batches (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES cdk_packages(id),
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      created_by TEXT REFERENCES admins(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cdks (
      id TEXT PRIMARY KEY,
      batch_id TEXT REFERENCES cdk_batches(id),
      package_id TEXT NOT NULL REFERENCES cdk_packages(id),
      code_hash TEXT NOT NULL UNIQUE,
      code_hint TEXT NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','refunded')),
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cdk_grants (
      id TEXT PRIMARY KEY,
      cdk_id TEXT NOT NULL REFERENCES cdks(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      task_key TEXT UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('validated','locked','consumed','released','expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      locked_at TEXT,
      consumed_at TEXT,
      released_at TEXT
    );

    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id TEXT REFERENCES admins(id),
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      ip TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token ON admin_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON admin_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_cdks_hash ON cdks(code_hash);
    CREATE INDEX IF NOT EXISTS idx_grants_token ON cdk_grants(token_hash);
    CREATE INDEX IF NOT EXISTS idx_grants_cdk_status ON cdk_grants(cdk_id, status);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS deployment_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      server_key TEXT NOT NULL,
      grant_hash TEXT,
      task_key TEXT,
      idempotency_key TEXT UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','succeeded','failed','cancelled','timed_out','interrupted','manual')),
      recovery_status TEXT NOT NULL DEFAULT 'none' CHECK(recovery_status IN ('none','pending','manual','recovered')),
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER NOT NULL DEFAULT 1200000,
      progress INTEGER NOT NULL DEFAULT 0,
      current_step TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      error_message TEXT,
      residue_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deployment_steps (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','skipped','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      residue_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(job_id, step_key)
    );

    CREATE TABLE IF NOT EXISTS deployment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      step_key TEXT,
      message TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(job_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS deployment_locks (
      server_key TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES deployment_jobs(id) ON DELETE CASCADE,
      acquired_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deployment_jobs_status ON deployment_jobs(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deployment_jobs_server ON deployment_jobs(server_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deployment_steps_job ON deployment_steps(job_id, id);
    CREATE INDEX IF NOT EXISTS idx_deployment_events_job ON deployment_events(job_id, sequence);
  `,
  `
    ALTER TABLE admins ADD COLUMN totp_secret TEXT;
    ALTER TABLE admins ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS catalog_overrides (
      adapter_id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      category TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 100,
      updated_by TEXT REFERENCES admins(id),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recommended_resources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('vps','domain','cdn','other')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      badge TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 100,
      click_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_reviews (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES deployment_jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pending','reviewed','resolved')),
      refund_status TEXT NOT NULL DEFAULT 'none' CHECK(refund_status IN ('none','refunded','not_applicable')),
      note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT REFERENCES admins(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backup_records (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL CHECK(reason IN ('manual','scheduled','pre_update','pre_restore','uploaded')),
      size_bytes INTEGER NOT NULL,
      created_by TEXT REFERENCES admins(id),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_resources_enabled_sort ON recommended_resources(enabled, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_reviews_status ON job_reviews(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_backups_created ON backup_records(created_at DESC);
  `,
];

export class PanelArkDatabase {
  private transactionDepth = 0;

  private constructor(private db: Database, readonly filePath: string, private readonly SQL: SqlJsStatic) {}

  static async open(filePath: string) {
    const wasmPath = path.resolve(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm");
    if (!fs.existsSync(wasmPath)) throw new Error(`PanelArk 数据库运行时缺失：${wasmPath}`);
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const bytes = fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined;
    const instance = new PanelArkDatabase(new SQL.Database(bytes), filePath, SQL);
    instance.db.run("PRAGMA foreign_keys = ON");
    instance.migrate();
    return instance;
  }

  run(sql: string, params?: DbParams) {
    this.db.run(sql, params);
    if (this.transactionDepth === 0) this.persist();
  }

  get<T extends DbRow = DbRow>(sql: string, params?: DbParams): T | undefined {
    const statement = this.db.prepare(sql, params);
    try {
      return statement.step() ? statement.getAsObject() as T : undefined;
    } finally {
      statement.free();
    }
  }

  all<T extends DbRow = DbRow>(sql: string, params?: DbParams): T[] {
    const statement = this.db.prepare(sql, params);
    const rows: T[] = [];
    try {
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  }

  transaction<T>(callback: () => T): T {
    const outer = this.transactionDepth === 0;
    if (outer) this.db.run("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = callback();
      this.transactionDepth -= 1;
      if (outer) {
        this.db.run("COMMIT");
        this.persist();
      }
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (outer) this.db.run("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.persist();
    this.db.close();
  }

  exportBytes() {
    return Buffer.from(this.db.export());
  }

  replaceFromBytes(bytes: Uint8Array) {
    const candidate = new this.SQL.Database(bytes);
    candidate.run("PRAGMA foreign_keys = ON");
    const required = candidate.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('admins','cdks','site_settings','schema_migrations')");
    const names = new Set((required[0]?.values || []).map(row => String(row[0])));
    if (!["admins", "cdks", "site_settings", "schema_migrations"].every(name => names.has(name))) {
      candidate.close();
      throw new Error("备份数据库缺少 PanelArk 核心数据表");
    }
    const previous = this.db;
    this.db = candidate;
    try {
      this.migrate();
      this.persist();
      previous.close();
    } catch (error) {
      this.db = previous;
      candidate.close();
      throw error;
    }
  }

  private migrate() {
    this.db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (this.get("SELECT version FROM schema_migrations WHERE version = ?", [version])) return;
      this.transaction(() => {
        this.db.run(sql);
        this.db.run("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", [version, new Date().toISOString()]);
      });
    });
    this.seedSettings();
  }

  private seedSettings() {
    const now = new Date().toISOString();
    const defaults: Record<string, string> = {
      purchase_enabled: "true",
      purchase_button_text: "购买 CDK",
      purchase_url: "",
      support_url: "",
      site_notice: "",
      backup_schedule_enabled: "false",
      backup_last_scheduled_at: "",
    };
    this.transaction(() => {
      for (const [key, value] of Object.entries(defaults)) {
        this.db.run("INSERT OR IGNORE INTO site_settings(key, value, updated_at) VALUES (?, ?, ?)", [key, value, now]);
      }
    });
  }

  private persist() {
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, Buffer.from(this.db.export()));
    fs.renameSync(temporary, this.filePath);
  }
}
