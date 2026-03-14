/**
 * DATABASE CLIENT — PostgreSQL via pg.Pool
 * Query builder: db().from('tracks').select('*').eq('id', x)
 * Under the hood: pg.Pool → raw SQL
 */

import pg from 'pg';
import jwt from 'jsonwebtoken';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[pg] Unexpected pool error:', err);
});

export { pool };

// ─── Query Builder (Supabase-compatible API) ───

type Filter = { col: string; op: string; val: any };

class QueryBuilder {
  private table: string;
  private _select: string = '*';
  private _filters: Filter[] = [];
  private _orFilters: string[] = [];
  private _order: { col: string; asc: boolean }[] = [];
  private _limit: number | null = null;
  private _offset: number | null = null;
  private _mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private _data: any = null;
  private _upsertConflict: string = 'id';
  private _returnData: boolean = false;
  private _single: boolean = false;
  private _maybeSingle: boolean = false;

  constructor(table: string) {
    this.table = table;
  }

  select(cols: string = '*') {
    this._mode = 'select';
    this._select = cols;
    return this;
  }

  insert(data: any) {
    this._mode = 'insert';
    this._data = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data: any) {
    this._mode = 'update';
    this._data = data;
    return this;
  }

  delete() {
    this._mode = 'delete';
    return this;
  }

  upsert(data: any, opts?: { onConflict?: string }) {
    this._mode = 'upsert';
    this._data = Array.isArray(data) ? data : [data];
    this._upsertConflict = opts?.onConflict || 'id';
    return this;
  }

  // Filters
  eq(col: string, val: any) { this._filters.push({ col, op: '=', val }); return this; }
  neq(col: string, val: any) { this._filters.push({ col, op: '!=', val }); return this; }
  gt(col: string, val: any) { this._filters.push({ col, op: '>', val }); return this; }
  gte(col: string, val: any) { this._filters.push({ col, op: '>=', val }); return this; }
  lt(col: string, val: any) { this._filters.push({ col, op: '<', val }); return this; }
  lte(col: string, val: any) { this._filters.push({ col, op: '<=', val }); return this; }

  in(col: string, vals: any[]) {
    this._filters.push({ col, op: 'IN', val: vals });
    return this;
  }

  ilike(col: string, pattern: string) {
    this._filters.push({ col, op: 'ILIKE', val: pattern });
    return this;
  }

  like(col: string, pattern: string) {
    this._filters.push({ col, op: 'LIKE', val: pattern });
    return this;
  }

  is(col: string, val: null | boolean) {
    if (val === null) {
      this._filters.push({ col, op: 'IS NULL', val: null });
    } else {
      this._filters.push({ col, op: 'IS', val });
    }
    return this;
  }

  not(col: string, op: string, val: any) {
    if (op === 'is' && val === null) {
      this._filters.push({ col, op: 'IS NOT NULL', val: null });
    } else if (op === 'in') {
      this._filters.push({ col, op: 'NOT IN', val });
    } else {
      this._filters.push({ col, op: `NOT ${op.toUpperCase()}`, val });
    }
    return this;
  }

  contains(col: string, val: any) {
    this._filters.push({ col, op: '@>', val: JSON.stringify(val) });
    return this;
  }

  // Supabase-style .or('title.ilike.%search%,artist_name.ilike.%search%')
  or(condition: string) {
    this._orFilters.push(condition);
    return this;
  }

  // Modifiers
  order(col: string, opts?: { ascending?: boolean }) {
    this._order.push({ col, asc: opts?.ascending ?? true });
    return this;
  }

  limit(n: number) {
    this._limit = n;
    return this;
  }

  range(from: number, to: number) {
    this._offset = from;
    this._limit = to - from + 1;
    return this;
  }

  single() {
    this._single = true;
    this._returnData = true;
    this._limit = 1;
    return this;
  }

  maybeSingle() {
    this._maybeSingle = true;
    this._returnData = true;
    this._limit = 1;
    return this;
  }

  // After insert/update/upsert, return the data
  returning() {
    this._returnData = true;
    return this;
  }

  // Build WHERE clause
  private buildWhere(params: any[]): string {
    const conditions: string[] = [];

    for (const f of this._filters) {
      if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') {
        conditions.push(`"${f.col}" ${f.op}`);
      } else if (f.op === 'IN' || f.op === 'NOT IN') {
        const placeholders = f.val.map((_: any, i: number) => `$${params.length + i + 1}`).join(', ');
        params.push(...f.val);
        conditions.push(`"${f.col}" ${f.op} (${placeholders})`);
      } else if (f.op === '@>') {
        params.push(f.val);
        conditions.push(`"${f.col}" @> $${params.length}::jsonb`);
      } else {
        params.push(f.val);
        conditions.push(`"${f.col}" ${f.op} $${params.length}`);
      }
    }

    // Parse Supabase-style .or() conditions
    for (const orStr of this._orFilters) {
      const orParts = orStr.split(',').map(part => {
        const match = part.match(/^(\w+)\.(\w+)\.(.+)$/);
        if (match) {
          const [, col, op, val] = match;
          if (op === 'ilike') {
            params.push(val);
            return `"${col}" ILIKE $${params.length}`;
          } else if (op === 'eq') {
            params.push(val);
            return `"${col}" = $${params.length}`;
          } else if (op === 'neq') {
            params.push(val);
            return `"${col}" != $${params.length}`;
          }
        }
        return null;
      }).filter(Boolean);
      if (orParts.length) {
        conditions.push(`(${orParts.join(' OR ')})`);
      }
    }

    return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  }

  // Execute the query
  async then(resolve: (val: { data: any; error: any; count?: number }) => void, reject?: (err: any) => void) {
    try {
      const result = await this.execute();
      resolve(result);
    } catch (err) {
      if (reject) reject(err);
      else resolve({ data: null, error: err });
    }
  }

  async execute(): Promise<{ data: any; error: any; count?: number }> {
    try {
      const params: any[] = [];

      if (this._mode === 'select') {
        let sql = `SELECT ${this._select} FROM "${this.table}"`;
        sql += ` ${this.buildWhere(params)}`;
        if (this._order.length) {
          sql += ` ORDER BY ${this._order.map(o => `"${o.col}" ${o.asc ? 'ASC' : 'DESC'}`).join(', ')}`;
        }
        if (this._limit !== null) sql += ` LIMIT ${this._limit}`;
        if (this._offset !== null) sql += ` OFFSET ${this._offset}`;

        const res = await pool.query(sql, params);

        if (this._single) {
          if (res.rows.length === 0) return { data: null, error: { message: 'No rows found', code: 'PGRST116' } };
          return { data: res.rows[0], error: null };
        }
        if (this._maybeSingle) {
          return { data: res.rows[0] || null, error: null };
        }
        return { data: res.rows, error: null, count: res.rowCount || 0 };
      }

      if (this._mode === 'insert') {
        const rows = this._data;
        if (!rows.length) return { data: [], error: null };

        const cols = Object.keys(rows[0]).filter(k => rows[0][k] !== undefined);
        const values: any[] = [];
        const valueSets: string[] = [];

        for (const row of rows) {
          const placeholders: string[] = [];
          for (const col of cols) {
            values.push(row[col] ?? null);
            placeholders.push(`$${values.length}`);
          }
          valueSets.push(`(${placeholders.join(', ')})`);
        }

        let sql = `INSERT INTO "${this.table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES ${valueSets.join(', ')}`;
        if (this._returnData || this._single || this._maybeSingle) sql += ' RETURNING *';

        const res = await pool.query(sql, values);

        if (this._single) return { data: res.rows[0] || null, error: null };
        if (this._maybeSingle) return { data: res.rows[0] || null, error: null };
        return { data: res.rows, error: null };
      }

      if (this._mode === 'update') {
        const setCols = Object.entries(this._data).filter(([, v]) => v !== undefined);
        const setClause = setCols.map(([col], i) => {
          params.push(setCols[i][1]);
          return `"${col}" = $${params.length}`;
        }).join(', ');

        let sql = `UPDATE "${this.table}" SET ${setClause}`;
        sql += ` ${this.buildWhere(params)}`;
        if (this._returnData || this._single || this._maybeSingle) sql += ' RETURNING *';

        const res = await pool.query(sql, params);

        if (this._single) return { data: res.rows[0] || null, error: null };
        if (this._maybeSingle) return { data: res.rows[0] || null, error: null };
        return { data: res.rows, error: null };
      }

      if (this._mode === 'delete') {
        let sql = `DELETE FROM "${this.table}"`;
        sql += ` ${this.buildWhere(params)}`;
        if (this._returnData || this._single || this._maybeSingle) sql += ' RETURNING *';

        const res = await pool.query(sql, params);
        return { data: res.rows, error: null };
      }

      if (this._mode === 'upsert') {
        const rows = this._data;
        if (!rows.length) return { data: [], error: null };

        const cols = Object.keys(rows[0]).filter(k => rows[0][k] !== undefined);
        const values: any[] = [];
        const valueSets: string[] = [];

        for (const row of rows) {
          const placeholders: string[] = [];
          for (const col of cols) {
            values.push(row[col] ?? null);
            placeholders.push(`$${values.length}`);
          }
          valueSets.push(`(${placeholders.join(', ')})`);
        }

        const updateCols = cols.filter(c => c !== this._upsertConflict);
        const updateClause = updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');

        let sql = `INSERT INTO "${this.table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES ${valueSets.join(', ')} ON CONFLICT ("${this._upsertConflict}") DO UPDATE SET ${updateClause}`;
        if (this._returnData || this._single || this._maybeSingle) sql += ' RETURNING *';

        const res = await pool.query(sql, values);

        if (this._single) return { data: res.rows[0] || null, error: null };
        if (this._maybeSingle) return { data: res.rows[0] || null, error: null };
        return { data: res.rows, error: null };
      }

      return { data: null, error: { message: 'Unknown mode' } };
    } catch (err: any) {
      console.error(`[db] Query error on "${this.table}":`, err.message);
      return { data: null, error: { message: err.message, code: err.code } };
    }
  }
}

// ─── Supabase-compatible client interface ───

class SupabaseCompatClient {
  from(table: string) {
    return new QueryBuilder(table);
  }

  // Auth compatibility (bcrypt + JWT replacing Supabase Auth)
  auth = {
    getUser: async (token: string) => {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
        // Fetch full user from DB
        const res = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.sub]);
        const user = res.rows[0];
        if (!user) return { data: { user: null }, error: { message: 'User not found' } };
        return {
          data: {
            user: {
              id: user.id,
              email: user.email,
              user_metadata: {
                name: user.full_name || user.display_name,
                role: user.role || 'artist',
                accountStatus: user.status || 'active',
                vk_id: user.settings?.vk_id,
                avatar: user.avatar_url,
              },
              role: user.role || 'artist',
            }
          },
          error: null
        };
      } catch {
        return { data: { user: null }, error: { message: 'Invalid token' } };
      }
    },

    admin: {
      listUsers: async (opts?: { perPage?: number }) => {
        const limit = opts?.perPage || 1000;
        const res = await pool.query(
          'SELECT id, email, username, full_name, role::text, status::text, is_verified, avatar_url, settings, created_at FROM users ORDER BY created_at DESC LIMIT $1',
          [limit]
        );
        // Map to Supabase-compatible format
        const users = res.rows.map((u: any) => ({
          id: u.id,
          email: u.email,
          user_metadata: {
            name: u.full_name || u.username,
            role: u.role,
            accountStatus: u.status,
            avatar: u.avatar_url,
            vk_id: u.settings?.vk_id,
          },
          role: u.role,
          created_at: u.created_at,
        }));
        return { data: { users }, error: null };
      },

      getUserById: async (id: string) => {
        const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        const u = res.rows[0];
        if (!u) return { data: { user: null }, error: { message: 'User not found' } };
        return {
          data: {
            user: {
              id: u.id,
              email: u.email,
              user_metadata: {
                name: u.full_name || u.username,
                role: u.role,
                accountStatus: u.status,
                avatar: u.avatar_url,
                vk_id: u.settings?.vk_id,
              },
            }
          },
          error: null,
        };
      },

      updateUserById: async (id: string, updates: any) => {
        const sets: string[] = [];
        const vals: any[] = [];
        let i = 1;

        if (updates.user_metadata) {
          // Merge user_metadata into settings JSONB + update relevant columns
          const meta = updates.user_metadata;
          if (meta.role) { sets.push(`"role" = $${i}::user_role`); vals.push(meta.role); i++; }
          if (meta.name) { sets.push(`"full_name" = $${i}`); vals.push(meta.name); i++; }
          if (meta.accountStatus) { sets.push(`"status" = $${i}::user_status`); vals.push(meta.accountStatus); i++; }
          if (meta.avatar) { sets.push(`"avatar_url" = $${i}`); vals.push(meta.avatar); i++; }

          // Store extra metadata in settings JSONB
          sets.push(`"settings" = COALESCE("settings", '{}') || $${i}::jsonb`);
          vals.push(JSON.stringify(meta));
          i++;
        }
        if (updates.email) { sets.push(`"email" = $${i}`); vals.push(updates.email); i++; }
        if (updates.password) {
          const bcryptModule = await import('bcryptjs');
          const bcrypt = bcryptModule.default || bcryptModule;
          const hash = await bcrypt.hash(updates.password, 10);
          sets.push(`"password_hash" = $${i}`); vals.push(hash); i++;
        }

        if (sets.length) {
          sets.push(`"updated_at" = NOW()`);
          vals.push(id);
          await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
        }
        return { data: { user: { id } }, error: null };
      },

      createUser: async (opts: { email: string; password: string; user_metadata?: any; email_confirm?: boolean }) => {
        try {
          const bcryptModule = await import('bcryptjs');
          const bcrypt = bcryptModule.default || bcryptModule;
          const hash = await bcrypt.hash(opts.password, 10);
          const meta = opts.user_metadata || {};
          const username = meta.name || opts.email.split('@')[0];
          const role = meta.role || 'artist';
          const status = meta.accountStatus || 'active';

          const res = await pool.query(
            `INSERT INTO users (email, password_hash, username, full_name, role, status, is_email_verified, avatar_url, settings, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::user_role, $6::user_status, $7, $8, $9, NOW(), NOW())
             RETURNING id, email, username, full_name, role::text, status::text`,
            [opts.email, hash, username, username, role, status, opts.email_confirm || false, meta.avatar || null, JSON.stringify(meta)]
          );

          if (res.rows.length === 0) {
            return { data: null, error: { message: 'Failed to create user' } };
          }
          const user = res.rows[0];
          return {
            data: {
              user: {
                id: user.id,
                email: user.email,
                user_metadata: meta,
              }
            },
            error: null,
          };
        } catch (err: any) {
          if (err.code === '23505') { // unique violation
            return { data: null, error: { message: 'User already registered' } };
          }
          return { data: null, error: { message: err.message } };
        }
      },

      generateLink: async (opts: { type: string; email: string }) => {
        // Generate a JWT token as a "magic link" — returns hashed_token
        const res = await pool.query('SELECT id, email, role::text FROM users WHERE email = $1', [opts.email]);
        const user = res.rows[0];
        if (!user) return { data: null, error: { message: 'User not found' } };

        const token = jwt.sign(
          { sub: user.id, email: user.email, role: user.role || 'artist' },
          process.env.JWT_SECRET!,
          { expiresIn: '7d' }
        );
        return {
          data: { properties: { hashed_token: token, action_link: `https://promo-music.ru/auth/verify?token=${token}` } },
          error: null,
        };
      },

      deleteUser: async (id: string) => {
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        return { data: null, error: null };
      },
    },

    signUp: async (opts: { email: string; password: string; options?: any }) => {
      // Delegate to admin.createUser
      return instance!.auth.admin.createUser({ email: opts.email, password: opts.password, user_metadata: opts.options?.data });
    },

    signInWithPassword: async (opts: { email: string; password: string }) => {
      try {
        const res = await pool.query('SELECT * FROM users WHERE email = $1', [opts.email]);
        const user = res.rows[0];
        if (!user) return { data: null, error: { message: 'Invalid login credentials', code: 'invalid_credentials' } };

        const bcryptModule = await import('bcryptjs');
          const bcrypt = bcryptModule.default || bcryptModule;
        const valid = await bcrypt.compare(opts.password, user.password_hash);
        if (!valid) return { data: null, error: { message: 'Invalid login credentials', code: 'invalid_credentials' } };

        // Check status
        if (user.status === 'banned') return { data: null, error: { message: 'Account banned' } };

        // Generate JWT
        const accessToken = jwt.sign(
          { sub: user.id, email: user.email, role: user.role || 'artist' },
          process.env.JWT_SECRET!,
          { expiresIn: '7d' }
        );

        // Update last login
        await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

        return {
          data: {
            user: {
              id: user.id,
              email: user.email,
              user_metadata: {
                name: user.full_name || user.username,
                role: user.role,
                accountStatus: user.status,
                avatar: user.avatar_url,
              },
            },
            session: {
              access_token: accessToken,
              expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
            }
          },
          error: null,
        };
      } catch (err: any) {
        return { data: null, error: { message: err.message } };
      }
    },
  };

  // Storage compatibility
  storage = {
    from: (bucket: string) => ({
      upload: async (path: string, data: any, opts?: any) => {
        // Will be handled by storage-routes.tsx
        return { data: { path }, error: null };
      },
      getPublicUrl: (path: string) => {
        const baseUrl = process.env.PUBLIC_URL || 'https://promo-music.ru';
        return { data: { publicUrl: `${baseUrl}/uploads/${path}` } };
      },
      remove: async (paths: string[]) => {
        return { data: null, error: null };
      },
      list: async (prefix?: string) => {
        return { data: [], error: null };
      },
      createSignedUrl: async (path: string, expiresIn: number) => {
        const baseUrl = process.env.PUBLIC_URL || 'https://promo-music.ru';
        return { data: { signedUrl: `${baseUrl}/uploads/${path}` }, error: null };
      }
    }),
    listBuckets: async () => ({ data: [], error: null }),
    createBucket: async (name: string, opts?: any) => ({ data: { name }, error: null }),
  };

  // RPC compatibility (for stored procedures)
  async rpc(fn: string, params?: any) {
    // Map common RPCs to SQL
    return { data: null, error: null };
  }
}

// Singleton
let instance: SupabaseCompatClient | null = null;

export function getDbClient(): SupabaseCompatClient {
  if (!instance) {
    instance = new SupabaseCompatClient();
  }
  return instance;
}

export function createUserClient(accessToken: string): SupabaseCompatClient {
  return getDbClient();
}

export function createAnonDbClient(): SupabaseCompatClient {
  return getDbClient();
}
