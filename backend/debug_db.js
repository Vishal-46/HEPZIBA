
const { Pool } = require("pg");
require("dotenv").config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT nspname AS schema, relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE nspname = \"public\"")
  .then(res => { console.log("Tables found:", res.rows); pool.end(); })
  .catch(err => { console.error("Error:", err.message); pool.end(); });

