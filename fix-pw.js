const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const hash = await bcrypt.hash("PromoCEO2025!", 12);
  console.log("Hash len:", hash.length);
  await pool.query("UPDATE users SET password_hash = \$1 WHERE email = \$2", [hash, "n.moiseev@gmx.de"]);
  const r = await pool.query("SELECT LENGTH(password_hash) as len, role FROM users WHERE email = \$1", ["n.moiseev@gmx.de"]);
  console.log("DB result:", r.rows[0]);
  pool.end();
})();
