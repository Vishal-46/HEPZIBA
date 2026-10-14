// Vercel serverless entrypoint. All routes (/auth, /patients, ...) are served
// from a single function via vercel.json rewrites.
const app = require('../app');

module.exports = app;
