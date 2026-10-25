'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL. Copy .env.example to .env and configure PostgreSQL.'); process.exit(1); }
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) { console.error('SESSION_SECRET must be set to a random string of at least 32 characters.'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','mentor','admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS profiles (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name VARCHAR(80) NOT NULL DEFAULT 'Student', bio VARCHAR(500) NOT NULL DEFAULT '',
    skills VARCHAR(500) NOT NULL DEFAULT '', avatar_url TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state_json JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS community_messages (
    id BIGSERIAL PRIMARY KEY,
    community_id VARCHAR(64) NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message VARCHAR(300) NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS community_messages_recent_idx ON community_messages(community_id, created_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS users_created_at_idx ON users(created_at DESC)');
}
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const authLimiter = rateLimit({ windowMs: 15*60*1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many authentication attempts. Please try again later.' } });
app.disable('x-powered-by');
app.set('trust proxy', production ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb', strict: true }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(session({
  name: 'peerloop.sid', secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true, pruneSessionInterval: 15*60 }),
  cookie: { httpOnly: true, secure: production, sameSite: 'lax', maxAge: 7*24*60*60*1000 },
}));
const publicUser = row => ({ id: String(row.id), email: row.email, role: row.role, createdAt: row.created_at });
const requireAuth = (req,res,next) => req.session.user ? next() : res.status(401).json({ error: 'Please sign in to continue.' });
const requireRole = (...roles) => async (req,res,next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  try {
    const result = await pool.query('SELECT role FROM users WHERE id=$1', [req.session.user.id]);
    const role = result.rows[0]?.role;
    if (!role) return res.status(401).json({ error: 'Please sign in to continue.' });
    req.session.user.role = role;
    return roles.includes(role)
      ? next()
      : res.status(403).json({ error: 'You do not have permission to do that.' });
  } catch (error) {
    return next(error);
  }
};
const normalizeEmail = email => String(email || '').trim().toLowerCase();
const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
const profileShape = row => ({ name: row.display_name, bio: row.bio, skills: row.skills, avatarUrl: row.avatar_url || '' });
const chatCommunities = new Set(['web','dsa','ai','design','english']);
const chatMessageShape = row => ({ id: String(row.id), userId: String(row.user_id), name: row.display_name, message: row.message, createdAt: row.created_at });

app.get('/api/health', asyncRoute(async (_req,res) => { await pool.query('SELECT 1'); res.json({ ok:true, service:'peerloop-api', database:'connected' }); }));
app.post('/api/auth/register', authLimiter, asyncRoute(async (req,res) => {
  const email = normalizeEmail(req.body?.email), password = String(req.body?.password || ''), name = String(req.body?.name || '').trim();
  if (!validEmail(email)) return res.status(400).json({ error:'Enter a valid email address.' });
  if (password.length < 10 || password.length > 72) return res.status(400).json({ error:'Password must be 10–72 characters long.' });
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) return res.status(400).json({ error:'Password must include a lowercase letter, uppercase letter, and number.' });
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error:'Name must be 2–80 characters.' });
  const hash = await bcrypt.hash(password, 12);
  const role = process.env.ADMIN_EMAIL && email === normalizeEmail(process.env.ADMIN_EMAIL) ? 'admin' : 'student';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query('INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3) RETURNING id,email,role,created_at', [email,hash,role]);
    const user = inserted.rows[0];
    await client.query('INSERT INTO profiles(user_id,display_name) VALUES($1,$2)', [user.id,name]);
    await client.query('INSERT INTO app_state(user_id,state_json) VALUES($1,$2::jsonb)', [user.id,JSON.stringify({})]);
    await client.query('COMMIT');
    await new Promise((resolve,reject)=>req.session.regenerate(err=>err?reject(err):resolve()));
    req.session.user = publicUser(user);
    req.session.save(err => err ? res.status(500).json({error:'Account created, but session setup failed. Please sign in.'}) : res.status(201).json({user:req.session.user,profile:{name,bio:'',skills:'',avatarUrl:''}}));
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); if(e.code==='23505') return res.status(409).json({error:'An account with this email already exists.'}); throw e; }
  finally { client.release(); }
}));
app.post('/api/auth/login', authLimiter, asyncRoute(async (req,res) => {
  const email = normalizeEmail(req.body?.email), password = String(req.body?.password || '');
  if (!validEmail(email) || !password) return res.status(400).json({error:'Enter your email and password.'});
  const result = await pool.query('SELECT id,email,password_hash,role,created_at FROM users WHERE email=$1', [email]);
  const row = result.rows[0];
  if (!row || !(await bcrypt.compare(password,row.password_hash))) return res.status(401).json({error:'Email or password is incorrect.'});
  await pool.query('UPDATE users SET last_login_at=NOW() WHERE id=$1',[row.id]);
  await new Promise((resolve,reject)=>req.session.regenerate(err=>err?reject(err):resolve()));
  req.session.user = publicUser(row);
  const p = await pool.query('SELECT display_name,bio,skills,avatar_url FROM profiles WHERE user_id=$1',[row.id]);
  req.session.save(err => err ? res.status(500).json({error:'Could not establish a session. Please try again.'}) : res.json({user:req.session.user,profile:p.rows[0]?profileShape(p.rows[0]):null}));
}));
app.get('/api/auth/me', (req,res) => res.set('Cache-Control','no-store').json({user:req.session.user || null}));
app.post('/api/auth/logout', (req,res) => { if(!req.session) return res.json({ok:true}); req.session.destroy(err=>{ if(err)return res.status(500).json({error:'Could not sign out.'}); res.clearCookie('peerloop.sid',{httpOnly:true,secure:production,sameSite:'lax'}); res.json({ok:true}); }); });

app.get('/api/profile', requireAuth, asyncRoute(async (req,res) => {
  const r = await pool.query('SELECT display_name,bio,skills,avatar_url,updated_at FROM profiles WHERE user_id=$1',[req.session.user.id]);
  if(!r.rows[0]) return res.status(404).json({error:'Profile not found.'}); res.json({profile:profileShape(r.rows[0]),updatedAt:r.rows[0].updated_at});
}));
app.patch('/api/profile', requireAuth, asyncRoute(async (req,res) => {
  const current = await pool.query('SELECT display_name,bio,skills,avatar_url FROM profiles WHERE user_id=$1',[req.session.user.id]);
  if(!current.rows[0]) return res.status(404).json({error:'Profile not found.'});
  const old=current.rows[0], name=req.body?.name===undefined?old.display_name:String(req.body.name).trim(), bio=req.body?.bio===undefined?old.bio:String(req.body.bio).trim(), skills=req.body?.skills===undefined?old.skills:String(req.body.skills).trim(), avatar=req.body?.avatarUrl===undefined?old.avatar_url:String(req.body.avatarUrl).trim();
  if(name.length<2||name.length>80) return res.status(400).json({error:'Name must be 2–80 characters.'});
  if(bio.length>500||skills.length>500) return res.status(400).json({error:'Bio and skills must each be 500 characters or fewer.'});
  if(avatar && (!/^https:\/\//i.test(avatar)||avatar.length>2048)) return res.status(400).json({error:'Avatar URL must be an HTTPS URL.'});
  const r=await pool.query('UPDATE profiles SET display_name=$1,bio=$2,skills=$3,avatar_url=$4,updated_at=NOW() WHERE user_id=$5 RETURNING display_name,bio,skills,avatar_url,updated_at',[name,bio,skills,avatar||null,req.session.user.id]);
  res.json({profile:profileShape(r.rows[0]),updatedAt:r.rows[0].updated_at});
}));
app.get('/api/state', requireAuth, asyncRoute(async (req,res) => { const r=await pool.query('SELECT state_json,updated_at FROM app_state WHERE user_id=$1',[req.session.user.id]); res.set('Cache-Control','no-store'); res.json({state:r.rows[0]?.state_json || {},updatedAt:r.rows[0]?.updated_at || null}); }));
app.put('/api/state', requireAuth, asyncRoute(async (req,res) => {
  const state=req.body?.state;
  if(!state||typeof state!=='object'||Array.isArray(state)) return res.status(400).json({error:'Expected a state object.'});
  const json=JSON.stringify(state); if(Buffer.byteLength(json,'utf8')>900_000) return res.status(413).json({error:'State is too large.'});
  const r=await pool.query(`INSERT INTO app_state(user_id,state_json,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(user_id) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=NOW() RETURNING updated_at`,[req.session.user.id,json]);
  res.json({ok:true,updatedAt:r.rows[0].updated_at});
}));
app.get('/api/chat/:communityId/messages', requireAuth, asyncRoute(async (req,res) => {
  const communityId=String(req.params.communityId||'');
  if(!chatCommunities.has(communityId)) return res.status(404).json({error:'Community chat was not found.'});
  const r=await pool.query(`SELECT id,user_id,display_name,message,created_at FROM (
    SELECT m.id,m.user_id,p.display_name,m.message,m.created_at
    FROM community_messages m JOIN profiles p ON p.user_id=m.user_id
    WHERE m.community_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 60
  ) recent ORDER BY created_at ASC,id ASC`,[communityId]);
  res.set('Cache-Control','no-store').json({
    messages:r.rows.map(row=>({...chatMessageShape(row),isMe:String(row.user_id)===String(req.session.user.id)}))
  });
}));
app.post('/api/chat/:communityId/messages', requireAuth, asyncRoute(async (req,res) => {
  const communityId=String(req.params.communityId||''), message=String(req.body?.message||'').trim();
  if(!chatCommunities.has(communityId)) return res.status(404).json({error:'Community chat was not found.'});
  if(message.length<1||message.length>300) return res.status(400).json({error:'Message must be 1–300 characters.'});
  const r=await pool.query(`WITH inserted AS (
    INSERT INTO community_messages(community_id,user_id,message) VALUES($1,$2,$3)
    RETURNING id,user_id,message,created_at
  )
  SELECT i.id,i.user_id,p.display_name,i.message,i.created_at
  FROM inserted i JOIN profiles p ON p.user_id=i.user_id`,[communityId,req.session.user.id,message]);
  res.status(201).json({message:chatMessageShape(r.rows[0])});
}));
app.get('/api/admin/users', requireRole('admin'), asyncRoute(async (req,res) => { const r=await pool.query('SELECT id,email,role,created_at,last_login_at FROM users ORDER BY created_at DESC LIMIT 200'); res.json({users:r.rows.map(x=>({...publicUser(x),lastLoginAt:x.last_login_at}))}); }));
app.patch('/api/admin/users/:id/role', requireRole('admin'), asyncRoute(async (req,res) => {
  const role=String(req.body?.role||''); if(!['student','mentor','admin'].includes(role)) return res.status(400).json({error:'Role must be student, mentor, or admin.'});
  if(String(req.params.id)===String(req.session.user.id) && role!=='admin') return res.status(400).json({error:'You cannot remove your own admin role.'});
  const r=await pool.query('UPDATE users SET role=$1,updated_at=NOW() WHERE id=$2 RETURNING id,email,role,created_at',[role,req.params.id]); if(!r.rows[0])return res.status(404).json({error:'User not found.'}); res.json({user:publicUser(r.rows[0])});
}));
app.use('/api',(_req,res)=>res.status(404).json({error:'API endpoint not found.'}));
app.use(express.static(path.join(__dirname,'public'),{extensions:['html']}));
app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,_req,res,_next)=>{ console.error(err); if(res.headersSent)return; const status=err.status||500; res.status(status).json({error:status>=500?'The server could not complete the request.':err.message}); });
let server;
initDb().then(()=>{server=app.listen(PORT,()=>console.log(`PEERLOOP Academy listening on http://localhost:${PORT}`));}).catch(err=>{console.error('Database initialization failed:',err.message);process.exit(1);});
async function shutdown(){ if(server) await new Promise(resolve=>server.close(resolve)); await pool.end(); process.exit(0); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
