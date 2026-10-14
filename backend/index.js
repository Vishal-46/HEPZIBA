require('dotenv').config();
const app = require('./app');
const pool = require('./db');

const port = process.env.PORT || 3000;

// Local / Render entrypoint only. Vercel uses api/index.js (serverless)
// and must NOT call app.listen().
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Backend API running on port ${port}`);
    pool.connect().then(async (client) => {
      console.log('Connected to Postgres!');
      try {
        const res1 = await client.query('SELECT current_database(), current_schema(), current_user;');
        console.log('DB Debug Info:', res1.rows[0]);
        const res2 = await client.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema');");
        console.log('Visible Tables:', res2.rows);
        client.release();
      } catch (e) {
        console.error('Debug query error:', e.message);
        client.release();
      }
    }).catch(e => console.error('Postgres connection error:', e));
  });
}

module.exports = app;
