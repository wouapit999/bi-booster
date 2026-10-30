import { neon } from '@neondatabase/serverless';

const ALLOWED_DOMAIN = 'bouquet-innovation.net';
const ADMIN_EMAIL = 'support@bouquet-innovation.net';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const LOGIN_TTL_MINUTES = 15;
const PLATFORMS = new Set(['tiktok', 'facebook', 'instagram', 'linkedin', 'x', 'youtube', 'threads']);

function responseJson(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function getSql(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return neon(env.DATABASE_URL);
}

function randomHex(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isAllowedEmail(email) {
  const parts = email.split('@');
  return parts.length === 2 && parts[0].length > 0 && parts[1] === ALLOWED_DOMAIN && email.length <= 254;
}

function cookieName(request) {
  return new URL(request.url).protocol === 'https:' ? '__Host-bi_booster_session' : 'bi_booster_session';
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const item = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!item) return '';
  try { return decodeURIComponent(item.slice(name.length + 1)); } catch { return ''; }
}

function cookieHeader(request, token, maxAge = SESSION_TTL_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(request)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 16_384) return null;
  try {
    const text = await request.text();
    if (text.length > 16_384) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requestOriginAllowed(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

async function getUser(request, env) {
  const token = getCookie(request, cookieName(request));
  if (!token) return null;
  const tokenHash = await sha256(token);
  const sql = getSql(env);
  const rows = await sql`
    SELECT u.id, u.email, u.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now()
    LIMIT 1`;
  return rows[0] || null;
}

async function rateLimit(sql, key) {
  const rows = await sql`
    INSERT INTO auth_rate_limits (bucket_key, last_requested_at)
    VALUES (${key}, now())
    ON CONFLICT (bucket_key) DO UPDATE
      SET last_requested_at = now()
      WHERE auth_rate_limits.last_requested_at < now() - interval '60 seconds'
    RETURNING bucket_key`;
  return rows.length > 0;
}

async function sendLoginEmail(env, email, token) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.APP_BASE_URL) {
    throw new Error('Email delivery is not configured');
  }
  const loginUrl = `${env.APP_BASE_URL.replace(/\/+$/, '')}/#login_token=${token}`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#22283a"><h1>Sign in to BI Booster</h1><p>Use this one-time link to access the Bouquet Innovation workspace. It expires in ${LOGIN_TTL_MINUTES} minutes.</p><p><a href="${loginUrl}" style="display:inline-block;padding:12px 18px;background:#4c62ee;color:#fff;text-decoration:none;border-radius:6px">Approve sign-in</a></p><p>If you did not request this link, you can ignore this email.</p></body></html>`;
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: 'Your BI Booster sign-in link',
      html,
    }),
  });
  if (!result.ok) throw new Error(`Email delivery failed with status ${result.status}`);
}

async function requestLoginLink(request, env) {
  if (!requestOriginAllowed(request)) return responseJson({ error: 'Request origin is not allowed.' }, 403);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!isAllowedEmail(email) || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return responseJson({ error: `Use a valid @${ALLOWED_DOMAIN} email address.` }, 400);
  }

  const sql = getSql(env);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256(ip);
  const [emailAllowed, ipAllowed] = await Promise.all([
    rateLimit(sql, `email:${email}`),
    rateLimit(sql, `ip:${ipHash}`),
  ]);
  if (!emailAllowed || !ipAllowed) return responseJson({ ok: true });

  const token = randomHex();
  const tokenHash = await sha256(token);
  await sql`
    INSERT INTO login_tokens (token_hash, email, expires_at)
    VALUES (${tokenHash}, ${email}, now() + (${LOGIN_TTL_MINUTES} * interval '1 minute'))`;
  try {
    await sendLoginEmail(env, email, token);
  } catch (error) {
    await sql`DELETE FROM login_tokens WHERE token_hash = ${tokenHash}`;
    console.error('Login email delivery failed. Check the configured email provider and sender domain.');
    return responseJson({ error: 'We could not send the sign-in link. Please try again later.' }, 503);
  }
  return responseJson({ ok: true });
}

async function verifyLoginLink(request, env) {
  if (!requestOriginAllowed(request)) return responseJson({ error: 'Request origin is not allowed.' }, 403);
  const body = await readJson(request);
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!/^[a-f0-9]{64}$/.test(token)) return responseJson({ error: 'This sign-in link is invalid or has expired.' }, 400);

  const sql = getSql(env);
  const tokenHash = await sha256(token);
  const consumed = await sql`
    DELETE FROM login_tokens
    WHERE token_hash = ${tokenHash} AND expires_at > now()
    RETURNING email`;
  const email = consumed[0]?.email;
  if (!email || !isAllowedEmail(email)) {
    return responseJson({ error: 'This sign-in link is invalid or has expired.' }, 400);
  }

  const users = await sql`
    INSERT INTO users (email, role, last_login_at)
    VALUES (${email}, ${email === ADMIN_EMAIL ? 'admin' : 'member'}, now())
    ON CONFLICT (email) DO UPDATE SET
      last_login_at = now(),
      role = CASE WHEN users.email = ${ADMIN_EMAIL} THEN 'admin' ELSE users.role END
    RETURNING id, email, role`;
  const user = users[0];
  const sessionToken = randomHex();
  const sessionHash = await sha256(sessionToken);
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${sessionHash}, ${user.id}, now() + (${SESSION_TTL_SECONDS} * interval '1 second'))`;
  return responseJson({ user: { email: user.email, role: user.role } }, 200, {
    'Set-Cookie': cookieHeader(request, sessionToken),
  });
}

async function logout(request, env) {
  if (!requestOriginAllowed(request)) return responseJson({ error: 'Request origin is not allowed.' }, 403);
  const token = getCookie(request, cookieName(request));
  if (token) {
    const tokenHash = await sha256(token);
    const sql = getSql(env);
    await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
  }
  return responseJson({ ok: true }, 200, { 'Set-Cookie': cookieHeader(request, '', 0) });
}

async function dashboard(request, env, user) {
  const sql = getSql(env);
  const [clients, posts, tasks, stats, series, byPlatform, inbox] = await Promise.all([
    sql`SELECT c.id, c.name, c.industry,
               count(sa.id) FILTER (WHERE sa.status = 'connected')::int AS connected_platforms
        FROM clients c LEFT JOIN social_accounts sa ON sa.client_id = c.id
        GROUP BY c.id ORDER BY lower(c.name)`,
    sql`SELECT p.id, p.client_id, c.name AS client_name, p.content, p.platforms,
               p.status, p.scheduled_at, p.created_at
        FROM posts p JOIN clients c ON c.id = p.client_id
        WHERE p.status IN ('draft', 'review', 'approved', 'scheduled')
        ORDER BY p.scheduled_at NULLS LAST, p.created_at DESC LIMIT 8`,
    sql`SELECT t.id, t.title, t.status, t.due_on, t.client_id, c.name AS client_name,
               u.email AS assigned_email
        FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
        LEFT JOIN users u ON u.id = t.assigned_to
        WHERE t.status = 'todo' ORDER BY t.due_on NULLS LAST, t.created_at LIMIT 12`,
    sql`SELECT COALESCE(sum(reach), 0)::bigint AS reach,
               CASE WHEN sum(impressions) > 0
                    THEN round(sum(engagements)::numeric * 100 / sum(impressions), 2)
                    ELSE 0 END AS engagement_rate,
               COALESCE(sum(followers_gained), 0)::bigint AS followers_gained
        FROM analytics_daily WHERE metric_date >= current_date - interval '29 days'`,
    sql`SELECT metric_date::text AS metric_date, sum(reach)::bigint AS reach,
               CASE WHEN sum(impressions) > 0
                    THEN round(sum(engagements)::numeric * 100 / sum(impressions), 2)
                    ELSE 0 END AS engagement_rate
        FROM analytics_daily WHERE metric_date >= current_date - interval '29 days'
        GROUP BY metric_date ORDER BY metric_date`,
    sql`SELECT platform, sum(reach)::bigint AS reach
        FROM analytics_daily WHERE metric_date >= current_date - interval '29 days'
        GROUP BY platform ORDER BY sum(reach) DESC LIMIT 5`,
    sql`SELECT count(*)::int AS open_count FROM inbox_messages WHERE replied_at IS NULL`,
  ]);
  const postCount = await sql`SELECT count(*)::int AS count FROM posts WHERE status <> 'published'`;
  return responseJson({
    user: { email: user.email, role: user.role },
    stats: {
      reach: Number(stats[0]?.reach || 0),
      engagementRate: Number(stats[0]?.engagement_rate || 0),
      followersGained: Number(stats[0]?.followers_gained || 0),
      plannerPosts: Number(postCount[0]?.count || 0),
    },
    clients,
    posts,
    tasks,
    series,
    byPlatform,
    inboxCount: Number(inbox[0]?.open_count || 0),
  });
}

async function createClient(request, env, user) {
  if (user.role !== 'admin') return responseJson({ error: 'Admin access is required.' }, 403);
  if (!requestOriginAllowed(request)) return responseJson({ error: 'Request origin is not allowed.' }, 403);
  const body = await readJson(request);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const industry = typeof body?.industry === 'string' ? body.industry.trim().slice(0, 80) : '';
  if (name.length < 1 || name.length > 100) return responseJson({ error: 'Client name must be 1–100 characters.' }, 400);
  const sql = getSql(env);
  const rows = await sql`
    INSERT INTO clients (name, industry, created_by)
    VALUES (${name}, ${industry}, ${user.id})
    RETURNING id, name, industry`;
  return responseJson({ client: rows[0] }, 201);
}

async function createPost(request, env, user) {
  if (!requestOriginAllowed(request)) return responseJson({ error: 'Request origin is not allowed.' }, 403);
  const body = await readJson(request);
  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  const clientId = typeof body?.clientId === 'string' ? body.clientId : '';
  const platforms = Array.isArray(body?.platforms) ? [...new Set(body.platforms)] : [];
  const scheduledAt = typeof body?.scheduledAt === 'string' && !Number.isNaN(Date.parse(body.scheduledAt))
    ? new Date(body.scheduledAt).toISOString()
    : null;
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return responseJson({ error: 'Choose a client account.' }, 400);
  if (content.length > 5000) return responseJson({ error: 'Post text must be 5,000 characters or fewer.' }, 400);
  if (platforms.some((platform) => !PLATFORMS.has(platform))) return responseJson({ error: 'One or more selected channels are not supported.' }, 400);
  const sql = getSql(env);
  const clients = await sql`SELECT id FROM clients WHERE id = ${clientId} LIMIT 1`;
  if (!clients.length) return responseJson({ error: 'That client account was not found.' }, 404);
  const rows = await sql`
    INSERT INTO posts (client_id, author_id, content, platforms, scheduled_at, status)
    VALUES (${clientId}, ${user.id}, ${content}, ${platforms}, ${scheduledAt}, 'draft')
    RETURNING id, client_id, content, platforms, status, scheduled_at, created_at`;
  return responseJson({ post: rows[0] }, 201);
}

async function createTask(request, env, user) {
  if (!requestOriginAllowed(request)) return responseJson({ error: 'Request origin is not allowed.' }, 403);
  const body = await readJson(request);
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const dueOn = typeof body?.dueOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dueOn) ? body.dueOn : null;
  if (!title || title.length > 240) return responseJson({ error: 'Task title must be 1–240 characters.' }, 400);
  const sql = getSql(env);
  const rows = await sql`
    INSERT INTO tasks (title, created_by, assigned_to, due_on)
    VALUES (${title}, ${user.id}, ${user.id}, ${dueOn})
    RETURNING id, title, status, due_on`;
  return responseJson({ task: rows[0] }, 201);
}

async function updateTask(request, env, user, id) {
  if (!requestOriginAllowed(request)) return responseJson({ error: 'Request origin is not allowed.' }, 403);
  const body = await readJson(request);
  const status = body?.status === 'done' ? 'done' : body?.status === 'todo' ? 'todo' : '';
  if (!status) return responseJson({ error: 'Choose a valid task status.' }, 400);
  const sql = getSql(env);
  const rows = await sql`
    UPDATE tasks SET status = ${status}, updated_at = now()
    WHERE id = ${id} RETURNING id, title, status, due_on`;
  return rows.length ? responseJson({ task: rows[0] }) : responseJson({ error: 'Task not found.' }, 404);
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === '/api/auth/request' && request.method === 'POST') return requestLoginLink(request, env);
  if (pathname === '/api/auth/verify' && request.method === 'POST') return verifyLoginLink(request, env);
  if (pathname === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const user = await getUser(request, env);
    return user ? responseJson({ user: { email: user.email, role: user.role } }) : responseJson({ error: 'Not signed in.' }, 401);
  }

  const user = await getUser(request, env);
  if (!user) return responseJson({ error: 'Sign in to continue.' }, 401);
  if (pathname === '/api/dashboard' && request.method === 'GET') return dashboard(request, env, user);
  if (pathname === '/api/clients' && request.method === 'POST') return createClient(request, env, user);
  if (pathname === '/api/posts' && request.method === 'POST') return createPost(request, env, user);
  if (pathname === '/api/tasks' && request.method === 'POST') return createTask(request, env, user);
  const taskMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
  if (taskMatch && request.method === 'PATCH') return updateTask(request, env, user, taskMatch[1]);
  return responseJson({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env);
    } catch (error) {
      console.error('API request failed. Check Worker configuration and database connectivity.');
      return responseJson({ error: 'The service is temporarily unavailable.' }, 500);
    }
  },
};
