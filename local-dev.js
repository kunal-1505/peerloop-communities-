'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const EmbeddedPostgres = require('embedded-postgres').default;

const port = Number(process.env.LOCAL_PG_PORT || 54320);
const password = 'peerloop-local-development-only';
const database = new EmbeddedPostgres({
  databaseDir: process.env.LOCAL_PG_DATA_DIR
    ? path.resolve(process.env.LOCAL_PG_DATA_DIR)
    : path.join(__dirname, '.local', 'postgres'),
  user: 'peerloop',
  password,
  port,
  persistent: true,
  postgresFlags: ['-h', '127.0.0.1']
});

let app;

async function start() {
  await database.initialise();
  await database.start();

  const client = database.getPgClient('postgres', '127.0.0.1');
  await client.connect();
  try {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', ['peerloop']);
    if (!result.rowCount) await database.createDatabase('peerloop');
  } finally {
    await client.end();
  }

  app = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: `postgres://peerloop:${password}@127.0.0.1:${port}/peerloop`,
      SESSION_SECRET: process.env.SESSION_SECRET || require('node:crypto').randomBytes(48).toString('base64')
    }
  });
  app.once('error', error => {
    console.error('Could not start the PEERLOOP server:', error.message);
    void database.stop().then(() => { process.exitCode = 1; });
  });
  app.once('exit', async (code, signal) => {
    await database.stop();
    process.exitCode = code ?? (signal ? 1 : 0);
  });

  process.once('SIGINT', () => app.kill('SIGINT'));
  process.once('SIGTERM', () => app.kill('SIGTERM'));
}

start().catch(async error => {
  console.error('Could not start the local PEERLOOP database:', error.message);
  await database.stop().catch(() => {});
  process.exitCode = 1;
});
