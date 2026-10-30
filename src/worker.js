import { neon } from '@neondatabase/serverless';
import { ensureSchema } from './schema.js';
import { encryptToken, decryptToken, encryptionConfigured } from './tokens.js';
import {
  CONNECTABLE, ProviderError, authorizeUrl, completeOAuth, providerConfigured, publishTarget, refreshIfNeeded,
  validateForPlatform,
} from './providers.js';

const ALLOWED_DOMAIN = 'bouquet-innovation.net';
const ADMIN_EMAIL = 'support@bouquet-innovation.net';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const LOGIN_TTL_MINUTES = 15;
const INVITE_TTL_MINUTES = 60 * 72;
const PLATFORMS = new Set(['tiktok', 'facebook', 'instagram', 'linkedin', 'x', 'youtube', 'threads']);
const ROLES = ['admin', 'manager', 'editor', 'viewer'];
const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', editor: 'Editor', viewer: 'Viewer' };
const STATUS_GROUPS = {
  needs_approval: ['review'],
  drafts: ['draft', 'changes_requested'],
  scheduled: ['approved', 'scheduled'],
  publishing: ['publishing'],
  published: ['published'],
  failed: ['failed', 'partial'],
};
const MEDIA_TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'video/mp4': 'video', 'video/quicktime': 'video',
};
const MAX_MEDIA_BYTES = 95 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', ...extraHeaders } });
}

function getSql(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return neon(env.DATABASE_URL);
}

function baseUrl(env) {
  return (env.APP_BASE_URL || '').replace(/\/+$/, '');
}

function randomHex(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isAllowedEmail(email) {
  const parts = email.split('@');
  return parts.length === 2 && parts[0].length > 0 && parts[1] === ALLOWED_DOMAIN && email.length <= 254
    && /^[^\s@]+@[^\s@]+$/.test(email);
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
  if (length > 32_768) return null;
  try {
    const text = await request.text();
    if (text.length > 32_768) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requestOriginAllowed(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

function assertOrigin(request) {
  if (!requestOriginAllowed(request)) throw new HttpError(403, 'Request origin is not allowed.');
}

// ---------- Roles and client access ----------

const isAdmin = (user) => user.role === 'admin';
const canApprove = (user) => user.role === 'admin' || user.role === 'manager';
const canEdit = (user) => user.role !== 'viewer';

function requireRole(allowed, message) {
  if (!allowed) throw new HttpError(403, message);
}

async function clientScope(sql, user) {
  if (isAdmin(user)) return { all: true, ids: [] };
  const rows = await sql`SELECT client_id FROM client_members WHERE user_id = ${user.id}`;
  return { all: false, ids: rows.map((row) => row.client_id) };
}

async function assertClientAccess(sql, user, clientId) {
  if (!UUID.test(clientId || '')) throw new HttpError(400, 'Choose a client account.');
  const rows = await sql`SELECT id, name FROM clients WHERE id = ${clientId} LIMIT 1`;
  if (!rows.length) throw new HttpError(404, 'That client account was not found.');
  if (!isAdmin(user)) {
    const member = await sql`SELECT 1 FROM client_members WHERE client_id = ${clientId} AND user_id = ${user.id} LIMIT 1`;
    if (!member.length) throw new HttpError(403, 'You are not assigned to this client.');
  }
  return rows[0];
}

async function logActivity(sql, { userId = null, clientId = null, postId = null, action, detail = '' }) {
  await sql`
    INSERT INTO activity_log (user_id, client_id, post_id, action, detail)
    VALUES (${userId}, ${clientId}, ${postId}, ${action}, ${String(detail).slice(0, 2000)})`;
}

// ---------- Email ----------

async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('Email delivery is not configured');
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: Array.isArray(to) ? to : [to], subject, html }),
  });
  if (!result.ok) throw new Error(`Email delivery failed with status ${result.status}`);
}

function emailLayout(title, body, action) {
  const button = action
    ? `<p><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 18px;background:#4c62ee;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(action.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#22283a;line-height:1.5"><h1 style="font-size:22px">${escapeHtml(title)}</h1>${body}${button}<p style="color:#7a8291;font-size:12px">BI Booster · Bouquet Innovation</p></body></html>`;
}

async function sendLoginEmail(env, email, token, invitation) {
  if (!env.APP_BASE_URL) throw new Error('APP_BASE_URL is not configured');
  const loginUrl = `${baseUrl(env)}/#login_token=${token}`;
  if (invitation) {
    const clients = invitation.clients.length ? invitation.clients.map(escapeHtml).join(', ') : 'the workspace';
    await sendEmail(env, {
      to: email,
      subject: `${invitation.inviter} invited you to BI Booster`,
      html: emailLayout('You have been invited to BI Booster', `<p>${escapeHtml(invitation.inviter)} added you to the Bouquet Innovation social workspace as <b>${escapeHtml(ROLE_LABELS[invitation.role])}</b> for ${clients}.</p><p>This sign-in link works once and expires in 72 hours. After that, sign in at ${escapeHtml(baseUrl(env))} with this email address.</p>`, { url: loginUrl, label: 'Join the workspace' }),
    });
    return;
  }
  await sendEmail(env, {
    to: email,
    subject: 'Your BI Booster sign-in link',
    html: emailLayout('Sign in to BI Booster', `<p>Use this one-time link to access the Bouquet Innovation workspace. It expires in ${LOGIN_TTL_MINUTES} minutes.</p><p>If you did not request this link, you can ignore this email.</p>`, { url: loginUrl, label: 'Approve sign-in' }),
  });
}

// Best-effort workflow notifications; failures never block the workflow itself.
async function notify(env, emails, subject, title, body, postId) {
  const recipients = [...new Set(emails.filter(Boolean))];
  if (!recipients.length || !env.RESEND_API_KEY) return;
  const url = `${baseUrl(env)}/#planner${postId ? `/${postId}` : ''}`;
  try {
    await sendEmail(env, { to: recipients, subject, html: emailLayout(title, body, { url, label: 'Open in BI Booster' }) });
  } catch {
    console.error('Workflow notification email failed.');
  }
}

// ---------- Authentication ----------

async function getUser(request, env) {
  const token = getCookie(request, cookieName(request));
  if (!token) return null;
  const tokenHash = await sha256(token);
  const sql = getSql(env);
  const rows = await sql`
    SELECT u.id, u.email, u.role, u.display_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now() AND u.status <> 'disabled'
    LIMIT 1`;
  return rows[0] || null;
}

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role, displayName: user.display_name || '' };
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

async function createLoginToken(sql, email, minutes) {
  const token = randomHex();
  const tokenHash = await sha256(token);
  await sql`
    INSERT INTO login_tokens (token_hash, email, expires_at)
    VALUES (${tokenHash}, ${email}, now() + (${minutes} * interval '1 minute'))`;
  return { token, tokenHash };
}

async function requestLoginLink(request, env) {
  assertOrigin(request);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!isAllowedEmail(email)) return responseJson({ error: `Use a valid @${ALLOWED_DOMAIN} email address.` }, 400);

  const sql = getSql(env);
  if (email !== ADMIN_EMAIL) {
    const members = await sql`SELECT status FROM users WHERE email = ${email} LIMIT 1`;
    if (!members.length || members[0].status === 'disabled') {
      return responseJson({ error: 'This address is not part of the workspace yet. Ask your workspace admin for an invitation.' }, 403);
    }
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256(ip);
  const [emailAllowed, ipAllowed] = await Promise.all([
    rateLimit(sql, `email:${email}`),
    rateLimit(sql, `ip:${ipHash}`),
  ]);
  if (!emailAllowed || !ipAllowed) return responseJson({ ok: true });

  const { token, tokenHash } = await createLoginToken(sql, email, LOGIN_TTL_MINUTES);
  try {
    await sendLoginEmail(env, email, token);
  } catch {
    await sql`DELETE FROM login_tokens WHERE token_hash = ${tokenHash}`;
    console.error('Login email delivery failed. Check the configured email provider and sender domain.');
    return responseJson({ error: 'We could not send the sign-in link. Please try again later.' }, 503);
  }
  return responseJson({ ok: true });
}

async function verifyLoginLink(request, env) {
  assertOrigin(request);
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

  const users = email === ADMIN_EMAIL
    ? await sql`
        INSERT INTO users (email, role, status, last_login_at)
        VALUES (${email}, 'admin', 'active', now())
        ON CONFLICT (email) DO UPDATE SET last_login_at = now(), role = 'admin', status = 'active'
        RETURNING id, email, role, display_name`
    : await sql`
        UPDATE users SET last_login_at = now(), status = 'active'
        WHERE email = ${email} AND status <> 'disabled'
        RETURNING id, email, role, display_name`;
  const user = users[0];
  if (!user) return responseJson({ error: 'This account no longer has access to the workspace.' }, 403);
  const sessionToken = randomHex();
  const sessionHash = await sha256(sessionToken);
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${sessionHash}, ${user.id}, now() + (${SESSION_TTL_SECONDS} * interval '1 second'))`;
  return responseJson({ user: publicUser(user) }, 200, { 'Set-Cookie': cookieHeader(request, sessionToken) });
}

async function logout(request, env) {
  assertOrigin(request);
  const token = getCookie(request, cookieName(request));
  if (token) {
    const tokenHash = await sha256(token);
    const sql = getSql(env);
    await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
  }
  return responseJson({ ok: true }, 200, { 'Set-Cookie': cookieHeader(request, '', 0) });
}

// ---------- Workspace config, dashboard ----------

async function workspaceConfig(env, user) {
  const sql = getSql(env);
  const members = await sql`
    SELECT id, email, role, display_name FROM users WHERE status = 'active' ORDER BY lower(email)`;
  const providers = Object.fromEntries(Object.entries(CONNECTABLE).map(([platform, item]) => [
    platform, { label: item.label, configured: providerConfigured(env, item.provider) },
  ]));
  return responseJson({
    user: publicUser(user),
    providers,
    encryption: encryptionConfigured(env),
    mediaUpload: Boolean(env.MEDIA),
    scheduler: Boolean(env.SCHEDULE),
    members: members.map(publicUser),
  });
}

async function dashboard(env, user) {
  const sql = getSql(env);
  const { all, ids } = await clientScope(sql, user);
  const [clients, posts, tasks, stats, series, byPlatform, inbox, counts] = await Promise.all([
    sql`SELECT c.id, c.name, c.industry,
               count(sa.id) FILTER (WHERE sa.status = 'connected')::int AS connected_platforms
        FROM clients c LEFT JOIN social_accounts sa ON sa.client_id = c.id
        WHERE ${all} OR c.id = ANY(${ids}::uuid[])
        GROUP BY c.id ORDER BY lower(c.name)`,
    sql`SELECT p.id, p.client_id, c.name AS client_name, p.content, p.platforms,
               p.status, p.scheduled_at, p.created_at
        FROM posts p JOIN clients c ON c.id = p.client_id
        WHERE p.status IN ('draft', 'review', 'changes_requested', 'approved', 'scheduled', 'publishing')
          AND (${all} OR p.client_id = ANY(${ids}::uuid[]))
        ORDER BY p.scheduled_at NULLS LAST, p.created_at DESC LIMIT 8`,
    sql`SELECT t.id, t.title, t.status, t.due_on, t.client_id, c.name AS client_name,
               u.email AS assigned_email
        FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
        LEFT JOIN users u ON u.id = t.assigned_to
        WHERE t.status = 'todo' AND (${all} OR t.client_id IS NULL OR t.client_id = ANY(${ids}::uuid[]))
        ORDER BY t.due_on NULLS LAST, t.created_at LIMIT 12`,
    sql`SELECT COALESCE(sum(reach), 0)::bigint AS reach,
               CASE WHEN sum(impressions) > 0
                    THEN round(sum(engagements)::numeric * 100 / sum(impressions), 2)
                    ELSE 0 END AS engagement_rate,
               COALESCE(sum(followers_gained), 0)::bigint AS followers_gained
        FROM analytics_daily WHERE metric_date >= current_date - interval '29 days'
          AND (${all} OR client_id = ANY(${ids}::uuid[]))`,
    sql`SELECT metric_date::text AS metric_date, sum(reach)::bigint AS reach,
               CASE WHEN sum(impressions) > 0
                    THEN round(sum(engagements)::numeric * 100 / sum(impressions), 2)
                    ELSE 0 END AS engagement_rate
        FROM analytics_daily WHERE metric_date >= current_date - interval '29 days'
          AND (${all} OR client_id = ANY(${ids}::uuid[]))
        GROUP BY metric_date ORDER BY metric_date`,
    sql`SELECT platform, sum(reach)::bigint AS reach
        FROM analytics_daily WHERE metric_date >= current_date - interval '29 days'
          AND (${all} OR client_id = ANY(${ids}::uuid[]))
        GROUP BY platform ORDER BY sum(reach) DESC LIMIT 5`,
    sql`SELECT count(*)::int AS open_count FROM inbox_messages
        WHERE replied_at IS NULL AND (${all} OR client_id = ANY(${ids}::uuid[]))`,
    sql`SELECT count(*) FILTER (WHERE status <> 'published')::int AS planner,
               count(*) FILTER (WHERE status = 'review')::int AS review,
               count(*) FILTER (WHERE status IN ('failed', 'partial'))::int AS failed,
               count(*) FILTER (WHERE status = 'published' AND published_at >= date_trunc('month', now()))::int AS published_month
        FROM posts WHERE ${all} OR client_id = ANY(${ids}::uuid[])`,
  ]);
  return responseJson({
    user: publicUser(user),
    stats: {
      reach: Number(stats[0]?.reach || 0),
      engagementRate: Number(stats[0]?.engagement_rate || 0),
      followersGained: Number(stats[0]?.followers_gained || 0),
      plannerPosts: Number(counts[0]?.planner || 0),
    },
    counts: {
      review: Number(counts[0]?.review || 0),
      failed: Number(counts[0]?.failed || 0),
      publishedThisMonth: Number(counts[0]?.published_month || 0),
    },
    clients,
    posts,
    tasks,
    series,
    byPlatform,
    inboxCount: Number(inbox[0]?.open_count || 0),
  });
}

// ---------- Clients ----------

async function createClient(request, env, user) {
  requireRole(isAdmin(user), 'Admin access is required.');
  assertOrigin(request);
  const body = await readJson(request);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const industry = typeof body?.industry === 'string' ? body.industry.trim().slice(0, 80) : '';
  if (name.length < 1 || name.length > 100) return responseJson({ error: 'Client name must be 1–100 characters.' }, 400);
  const sql = getSql(env);
  const rows = await sql`
    INSERT INTO clients (name, industry, created_by)
    VALUES (${name}, ${industry}, ${user.id})
    RETURNING id, name, industry`;
  await logActivity(sql, { userId: user.id, clientId: rows[0].id, action: 'client.created', detail: name });
  return responseJson({ client: rows[0] }, 201);
}

// ---------- Team ----------

async function listTeam(env, user) {
  requireRole(isAdmin(user), 'Admin access is required.');
  const sql = getSql(env);
  const rows = await sql`
    SELECT u.id, u.email, u.role, u.status, u.display_name, u.last_login_at, u.invited_at,
           COALESCE(array_agg(cm.client_id) FILTER (WHERE cm.client_id IS NOT NULL), '{}') AS client_ids
    FROM users u LEFT JOIN client_members cm ON cm.user_id = u.id
    GROUP BY u.id
    ORDER BY (u.role = 'admin') DESC, u.status = 'disabled', lower(u.email)`;
  return responseJson({ members: rows });
}

async function parseClientIds(sql, value) {
  const ids = Array.isArray(value) ? [...new Set(value.filter((id) => UUID.test(id)))] : [];
  if (!ids.length) return [];
  const rows = await sql`SELECT id, name FROM clients WHERE id = ANY(${ids}::uuid[])`;
  if (rows.length !== ids.length) throw new HttpError(400, 'One or more selected clients were not found.');
  return rows;
}

async function setClientMembership(sql, userId, clientIds) {
  await sql.transaction([
    sql`DELETE FROM client_members WHERE user_id = ${userId}`,
    sql`INSERT INTO client_members (client_id, user_id) SELECT unnest(${clientIds}::uuid[]), ${userId}`,
  ]);
}

async function inviteMember(request, env, user) {
  requireRole(isAdmin(user), 'Admin access is required.');
  assertOrigin(request);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const role = ROLES.includes(body?.role) ? body.role : '';
  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim().slice(0, 80) : '';
  if (!isAllowedEmail(email)) throw new HttpError(400, `Invite a valid @${ALLOWED_DOMAIN} email address.`);
  if (!role) throw new HttpError(400, 'Choose a role.');
  if (email === ADMIN_EMAIL) throw new HttpError(400, 'That address is already the workspace admin.');
  const sql = getSql(env);
  const clients = await parseClientIds(sql, body?.clientIds);
  const existing = await sql`SELECT id, status FROM users WHERE email = ${email} LIMIT 1`;
  if (existing[0]?.status === 'active') throw new HttpError(409, 'This person is already a workspace member.');
  const rows = await sql`
    INSERT INTO users (email, role, status, display_name, invited_by, invited_at)
    VALUES (${email}, ${role}, 'invited', ${displayName}, ${user.id}, now())
    ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, status = 'invited', display_name = EXCLUDED.display_name,
      invited_by = EXCLUDED.invited_by, invited_at = now()
    RETURNING id`;
  const memberId = rows[0].id;
  await setClientMembership(sql, memberId, clients.map((client) => client.id));
  const { token, tokenHash } = await createLoginToken(sql, email, INVITE_TTL_MINUTES);
  try {
    await sendLoginEmail(env, email, token, {
      inviter: user.display_name || user.email, role, clients: clients.map((client) => client.name),
    });
  } catch {
    await sql`DELETE FROM login_tokens WHERE token_hash = ${tokenHash}`;
    await logActivity(sql, { userId: user.id, action: 'team.invited', detail: `${email} as ${role} (email failed)` });
    return responseJson({ error: 'The member was added, but the invitation email could not be sent. Use "Resend invite".' }, 502);
  }
  await logActivity(sql, { userId: user.id, action: 'team.invited', detail: `${email} as ${role}` });
  return responseJson({ ok: true, id: memberId }, 201);
}

async function updateMember(request, env, user, id) {
  requireRole(isAdmin(user), 'Admin access is required.');
  assertOrigin(request);
  const body = await readJson(request);
  const sql = getSql(env);
  const rows = await sql`SELECT id, email, role, status FROM users WHERE id = ${id} LIMIT 1`;
  const member = rows[0];
  if (!member) throw new HttpError(404, 'Team member not found.');
  const changes = [];
  if (body?.role !== undefined) {
    if (!ROLES.includes(body.role)) throw new HttpError(400, 'Choose a valid role.');
    if (member.email === ADMIN_EMAIL || member.id === user.id) throw new HttpError(400, 'You cannot change your own or the primary admin\'s role.');
    await sql`UPDATE users SET role = ${body.role} WHERE id = ${id}`;
    changes.push(`role → ${body.role}`);
  }
  if (body?.status !== undefined) {
    if (!['active', 'disabled'].includes(body.status)) throw new HttpError(400, 'Choose a valid status.');
    if (member.email === ADMIN_EMAIL || member.id === user.id) throw new HttpError(400, 'You cannot deactivate your own or the primary admin\'s account.');
    const next = body.status === 'disabled' ? 'disabled' : (member.status === 'disabled' ? 'invited' : member.status);
    await sql`UPDATE users SET status = ${next} WHERE id = ${id}`;
    if (next === 'disabled') await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    changes.push(next === 'disabled' ? 'deactivated' : 'reactivated');
  }
  if (body?.displayName !== undefined) {
    await sql`UPDATE users SET display_name = ${String(body.displayName).trim().slice(0, 80)} WHERE id = ${id}`;
    changes.push('name updated');
  }
  if (body?.clientIds !== undefined) {
    const clients = await parseClientIds(sql, body.clientIds);
    await setClientMembership(sql, id, clients.map((client) => client.id));
    changes.push(`clients: ${clients.map((client) => client.name).join(', ') || 'none'}`);
  }
  if (changes.length) await logActivity(sql, { userId: user.id, action: 'team.updated', detail: `${member.email}: ${changes.join('; ')}` });
  return responseJson({ ok: true });
}

async function resendInvite(request, env, user, id) {
  requireRole(isAdmin(user), 'Admin access is required.');
  assertOrigin(request);
  const sql = getSql(env);
  const rows = await sql`
    SELECT u.email, u.role, u.status,
           COALESCE(array_agg(c.name) FILTER (WHERE c.id IS NOT NULL), '{}') AS clients
    FROM users u LEFT JOIN client_members cm ON cm.user_id = u.id LEFT JOIN clients c ON c.id = cm.client_id
    WHERE u.id = ${id} GROUP BY u.id`;
  const member = rows[0];
  if (!member) throw new HttpError(404, 'Team member not found.');
  if (member.status !== 'invited') throw new HttpError(400, 'Only pending invitations can be resent.');
  const { token, tokenHash } = await createLoginToken(sql, member.email, INVITE_TTL_MINUTES);
  try {
    await sendLoginEmail(env, member.email, token, { inviter: user.display_name || user.email, role: member.role, clients: member.clients });
  } catch {
    await sql`DELETE FROM login_tokens WHERE token_hash = ${tokenHash}`;
    throw new HttpError(502, 'The invitation email could not be sent. Try again later.');
  }
  return responseJson({ ok: true });
}

// ---------- Social accounts and OAuth ----------

async function listAccounts(env, user, url) {
  const sql = getSql(env);
  const clientId = url.searchParams.get('clientId') || '';
  if (clientId) await assertClientAccess(sql, user, clientId);
  const { all, ids } = await clientScope(sql, user);
  const rows = await sql`
    SELECT sa.id, sa.client_id, c.name AS client_name, sa.platform, sa.display_name, sa.avatar_url, sa.profile_url,
           sa.status, sa.last_error, sa.connected_at, sa.token_expires_at, u.email AS connected_by_email
    FROM social_accounts sa JOIN clients c ON c.id = sa.client_id
    LEFT JOIN users u ON u.id = sa.connected_by
    WHERE sa.status <> 'disconnected'
      AND (${clientId} = '' OR sa.client_id::text = ${clientId})
      AND (${all} OR sa.client_id = ANY(${ids}::uuid[]))
    ORDER BY lower(c.name), sa.platform, lower(sa.display_name)`;
  return responseJson({ accounts: rows });
}

async function disconnectAccount(request, env, user, id) {
  requireRole(isAdmin(user), 'Only the workspace admin can disconnect social accounts.');
  assertOrigin(request);
  const sql = getSql(env);
  const rows = await sql`
    UPDATE social_accounts
    SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, updated_at = now()
    WHERE id = ${id} RETURNING client_id, platform, display_name`;
  if (!rows.length) throw new HttpError(404, 'Social account not found.');
  await sql`
    UPDATE post_targets SET status = 'failed', error = 'Account was disconnected before publishing.', updated_at = now()
    WHERE social_account_id = ${id} AND status IN ('pending', 'processing')`;
  await logActivity(sql, { userId: user.id, clientId: rows[0].client_id, action: 'account.disconnected', detail: `${rows[0].platform}: ${rows[0].display_name}` });
  return responseJson({ ok: true });
}

async function startOAuth(env, user, url) {
  const platform = url.searchParams.get('platform') || '';
  const clientId = url.searchParams.get('clientId') || '';
  const back = (message) => redirect(`/?oauth_error=${encodeURIComponent(message)}#settings`);
  if (!isAdmin(user)) return back('Only the workspace admin can connect social accounts.');
  if (!CONNECTABLE[platform]) return back('That platform cannot be connected yet.');
  if (!providerConfigured(env, CONNECTABLE[platform].provider)) {
    return back(`${CONNECTABLE[platform].label} connections are not configured yet. Add the platform app credentials first.`);
  }
  if (!encryptionConfigured(env)) return back('TOKEN_ENCRYPTION_KEY is not configured, so tokens cannot be stored safely.');
  const sql = getSql(env);
  try { await assertClientAccess(sql, user, clientId); } catch (error) { return back(error.message); }
  const state = randomHex();
  await sql`DELETE FROM oauth_states WHERE expires_at < now()`;
  await sql`
    INSERT INTO oauth_states (state_hash, user_id, client_id, platform, expires_at)
    VALUES (${await sha256(state)}, ${user.id}, ${clientId}, ${platform}, now() + interval '15 minutes')`;
  return redirect(authorizeUrl(env, platform, state));
}

async function finishOAuth(request, env, provider, url) {
  const back = (params) => redirect(`/?${new URLSearchParams(params)}#settings`);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (!/^[a-f0-9]{64}$/.test(state)) return back({ oauth_error: 'The connection request was invalid. Try again.' });
  const sql = getSql(env);
  const states = await sql`
    DELETE FROM oauth_states WHERE state_hash = ${await sha256(state)} AND expires_at > now()
    RETURNING user_id, client_id, platform`;
  const pending = states[0];
  if (!pending || CONNECTABLE[pending.platform]?.provider !== provider) {
    return back({ oauth_error: 'The connection request expired. Start again from Settings.' });
  }
  const user = await getUser(request, env);
  if (!user || user.id !== pending.user_id || !isAdmin(user)) {
    return back({ oauth_error: 'Sign in as the workspace admin who started the connection, then try again.' });
  }
  const providerError = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (providerError || !code) return back({ oauth_error: `The platform did not grant access: ${providerError || 'no authorization code'}.` });
  let accounts;
  try {
    accounts = await completeOAuth(env, pending.platform, code);
  } catch (error) {
    return back({ oauth_error: error instanceof ProviderError ? error.message : 'The platform connection failed. Try again.' });
  }
  for (const account of accounts) {
    await sql`
      INSERT INTO social_accounts (client_id, platform, external_account_id, display_name, avatar_url, profile_url,
        access_token_enc, refresh_token_enc, token_expires_at, scopes, metadata, status, connected_at, connected_by,
        last_error, updated_at)
      VALUES (${pending.client_id}, ${account.platform}, ${account.externalId}, ${account.displayName},
        ${account.avatarUrl}, ${account.profileUrl}, ${await encryptToken(env, account.accessToken)},
        ${await encryptToken(env, account.refreshToken)}, ${account.expiresAt}, ${account.scopes},
        ${JSON.stringify(account.metadata || {})}::jsonb, 'connected', now(), ${user.id}, '', now())
      ON CONFLICT (platform, external_account_id) DO UPDATE SET
        client_id = EXCLUDED.client_id, display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url,
        profile_url = EXCLUDED.profile_url, access_token_enc = EXCLUDED.access_token_enc,
        refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, social_accounts.refresh_token_enc),
        token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes, metadata = EXCLUDED.metadata,
        status = 'connected', connected_at = now(), connected_by = EXCLUDED.connected_by, last_error = '', updated_at = now()`;
  }
  await logActivity(sql, {
    userId: user.id, clientId: pending.client_id, action: 'account.connected',
    detail: accounts.map((account) => `${account.platform}: ${account.displayName}`).join(', '),
  });
  return back({ connected: pending.platform, count: String(accounts.length) });
}

// ---------- Media ----------

function mediaKeyFromUrl(env, url) {
  const prefix = `${baseUrl(env)}/media/`;
  if (!url.startsWith(prefix)) return '';
  try { return decodeURIComponent(url.slice(prefix.length)); } catch { return ''; }
}

async function uploadMedia(request, env, user, url) {
  requireRole(canEdit(user), 'Viewers cannot upload media.');
  assertOrigin(request);
  if (!env.MEDIA) throw new HttpError(501, 'Media uploads need Cloudflare R2. Paste a public media link instead.');
  const sql = getSql(env);
  const clientId = url.searchParams.get('clientId') || '';
  await assertClientAccess(sql, user, clientId);
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const type = MEDIA_TYPES[contentType];
  if (!type) throw new HttpError(415, 'Upload a JPEG, PNG, WebP or GIF image, or an MP4 or MOV video.');
  const size = Number(request.headers.get('Content-Length') || 0);
  if (!size || size > MAX_MEDIA_BYTES) throw new HttpError(413, 'Files must be smaller than 95 MB.');
  const rawName = (url.searchParams.get('name') || 'upload').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  const name = (rawName || 'upload').slice(-100);
  const id = crypto.randomUUID();
  const key = `${id}/${name}`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType } });
  await sql`
    INSERT INTO media_assets (id, client_id, uploaded_by, object_key, file_name, content_type, size_bytes)
    VALUES (${id}, ${clientId}, ${user.id}, ${key}, ${name}, ${contentType}, ${size})`;
  return responseJson({
    media: { assetId: id, url: `${baseUrl(env)}/media/${id}/${encodeURIComponent(name)}`, type, name, mime: contentType },
  }, 201);
}

async function serveMedia(request, env, path) {
  const name = path.slice('/media/'.length);
  if (env.TIKTOK_VERIFY_FILE && name === env.TIKTOK_VERIFY_FILE) {
    return new Response(env.TIKTOK_VERIFY_CONTENT || '', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (!env.MEDIA) return new Response('Not found', { status: 404 });
  let key;
  try { key = decodeURIComponent(name); } catch { return new Response('Not found', { status: 404 }); }
  if (!/^[0-9a-f-]{36}\/[\w.-]{1,100}$/i.test(key)) return new Response('Not found', { status: 404 });
  const object = await env.MEDIA.get(key, { range: request.headers, onlyIf: request.headers });
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  if (object.range && request.headers.has('Range')) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

async function openMedia(env, item) {
  const key = mediaKeyFromUrl(env, item.url);
  if (key && env.MEDIA) {
    const object = await env.MEDIA.get(key);
    if (!object) throw new ProviderError('The uploaded media file is missing.');
    return { body: object.body, size: object.size, contentType: object.httpMetadata?.contentType || 'video/mp4' };
  }
  const response = await fetch(item.url);
  const size = Number(response.headers.get('Content-Length') || 0);
  if (!response.ok || !size) throw new ProviderError('The media link could not be downloaded (it must be a direct, public file link).');
  return { body: response.body, size, contentType: response.headers.get('Content-Type') || 'video/mp4' };
}

// ---------- Posts and the approval workflow ----------

function normalizeMedia(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new HttpError(400, 'Media must be a list.');
  if (list.length > 10) throw new HttpError(400, 'Attach at most 10 media files.');
  return list.map((item) => {
    const url = typeof item?.url === 'string' ? item.url.trim() : '';
    const type = item?.type === 'video' ? 'video' : item?.type === 'image' ? 'image' : '';
    if (!type || !/^https:\/\/\S{4,2040}$/.test(url)) {
      throw new HttpError(400, 'Each media item needs a public https:// link and a type (image or video).');
    }
    return {
      url, type,
      name: String(item.name || url.split('/').pop() || '').slice(0, 120),
      mime: typeof item.mime === 'string' ? item.mime.slice(0, 60) : '',
      ...(UUID.test(item.assetId || '') ? { assetId: item.assetId } : {}),
    };
  });
}

function normalizeOptions(value) {
  const options = {};
  if (['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].includes(value?.tiktokPrivacy)) {
    options.tiktokPrivacy = value.tiktokPrivacy;
  }
  if (['public', 'unlisted', 'private'].includes(value?.youtubePrivacy)) options.youtubePrivacy = value.youtubePrivacy;
  return options;
}

function parseSchedule(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new HttpError(400, 'Choose a valid date and time.');
  return new Date(value).toISOString();
}

async function loadPost(sql, user, id) {
  const rows = await sql`
    SELECT p.*, c.name AS client_name, a.email AS author_email
    FROM posts p JOIN clients c ON c.id = p.client_id JOIN users a ON a.id = p.author_id
    WHERE p.id = ${id} LIMIT 1`;
  const post = rows[0];
  if (!post) throw new HttpError(404, 'Post not found.');
  await assertClientAccess(sql, user, post.client_id);
  return post;
}

async function postTargets(sql, postId) {
  return sql`
    SELECT t.id, t.social_account_id AS account_id, t.platform, t.status, t.error, t.external_url,
           t.published_at, sa.display_name, sa.status AS account_status
    FROM post_targets t JOIN social_accounts sa ON sa.id = t.social_account_id
    WHERE t.post_id = ${postId} ORDER BY t.platform, lower(sa.display_name)`;
}

async function setTargets(sql, post, accountIds) {
  const ids = [...new Set((accountIds || []).filter((id) => UUID.test(id)))];
  const accounts = ids.length ? await sql`
    SELECT id, platform FROM social_accounts
    WHERE id = ANY(${ids}::uuid[]) AND client_id = ${post.client_id} AND status <> 'disconnected'` : [];
  if (accounts.length !== ids.length) throw new HttpError(400, 'Choose accounts that are connected to this client.');
  await sql`
    DELETE FROM post_targets
    WHERE post_id = ${post.id} AND status <> 'published' AND NOT (social_account_id = ANY(${ids}::uuid[]))`;
  for (const account of accounts) {
    await sql`
      INSERT INTO post_targets (post_id, social_account_id, platform)
      VALUES (${post.id}, ${account.id}, ${account.platform})
      ON CONFLICT (post_id, social_account_id) DO NOTHING`;
  }
  await sql`UPDATE posts SET platforms = ${[...new Set(accounts.map((account) => account.platform))]} WHERE id = ${post.id}`;
}

async function validatePublishable(sql, post) {
  const targets = await postTargets(sql, post.id);
  const open = targets.filter((target) => target.status !== 'published');
  if (!targets.length) throw new HttpError(400, 'Choose at least one connected social account.');
  const problems = [];
  for (const target of open) {
    if (target.account_status !== 'connected') problems.push(`${target.display_name} must be reconnected in Settings.`);
    const problem = validateForPlatform(target.platform, { content: post.content || '', title: post.title || '' }, post.media || []);
    if (problem) problems.push(problem);
  }
  if (problems.length) throw new HttpError(400, [...new Set(problems)].join(' '));
  return targets;
}

async function approverEmails(sql, clientId, excludeUserId) {
  const rows = await sql`
    SELECT u.email FROM users u
    WHERE u.status = 'active' AND u.id <> ${excludeUserId}
      AND (u.role = 'admin' OR (u.role = 'manager' AND EXISTS (
        SELECT 1 FROM client_members cm WHERE cm.user_id = u.id AND cm.client_id = ${clientId})))`;
  return rows.map((row) => row.email);
}

function excerpt(post) {
  const text = (post.title || post.content || 'Untitled post').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

async function listPosts(env, user, url) {
  const sql = getSql(env);
  const { all, ids } = await clientScope(sql, user);
  const statuses = STATUS_GROUPS[url.searchParams.get('group')] || [];
  const clientId = UUID.test(url.searchParams.get('clientId') || '') ? url.searchParams.get('clientId') : '';
  const rows = await sql`
    SELECT p.id, p.client_id, c.name AS client_name, p.content, p.title, p.media, p.options, p.status,
           p.scheduled_at, p.published_at, p.created_at, p.updated_at, p.author_id, a.email AS author_email,
           COALESCE(json_agg(json_build_object('id', t.id, 'accountId', t.social_account_id, 'platform', t.platform,
             'status', t.status, 'error', t.error, 'url', t.external_url, 'name', sa.display_name)
             ORDER BY t.platform) FILTER (WHERE t.id IS NOT NULL), '[]') AS targets
    FROM posts p
    JOIN clients c ON c.id = p.client_id
    JOIN users a ON a.id = p.author_id
    LEFT JOIN post_targets t ON t.post_id = p.id
    LEFT JOIN social_accounts sa ON sa.id = t.social_account_id
    WHERE (${all} OR p.client_id = ANY(${ids}::uuid[]))
      AND (cardinality(${statuses}::text[]) = 0 OR p.status = ANY(${statuses}::text[]))
      AND (${clientId} = '' OR p.client_id::text = ${clientId})
    GROUP BY p.id, c.name, a.email
    ORDER BY COALESCE(p.scheduled_at, p.published_at, p.created_at) DESC
    LIMIT 200`;
  return responseJson({ posts: rows });
}

async function getPost(env, user, id) {
  const sql = getSql(env);
  const post = await loadPost(sql, user, id);
  const [targets, activity] = await Promise.all([
    postTargets(sql, id),
    sql`SELECT l.action, l.detail, l.created_at, u.email AS user_email
        FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.post_id = ${id} ORDER BY l.created_at`,
  ]);
  return responseJson({ post, targets, activity });
}

async function createPost(request, env, user, ctx) {
  requireRole(canEdit(user), 'Viewers cannot create posts.');
  assertOrigin(request);
  const body = await readJson(request);
  if (!body) throw new HttpError(400, 'The post could not be read.');
  const sql = getSql(env);
  await assertClientAccess(sql, user, body.clientId);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 100) : '';
  if (content.length > 5000) throw new HttpError(400, 'Post text must be 5,000 characters or fewer.');
  const media = normalizeMedia(body.media) || [];
  const options = normalizeOptions(body.options);
  const scheduledAt = parseSchedule(body.scheduledAt ?? null);
  const legacyPlatforms = Array.isArray(body.platforms) ? [...new Set(body.platforms)].filter((p) => PLATFORMS.has(p)) : [];
  const rows = await sql`
    INSERT INTO posts (client_id, author_id, content, title, media, options, platforms, scheduled_at, status)
    VALUES (${body.clientId}, ${user.id}, ${content}, ${title}, ${JSON.stringify(media)}::jsonb,
      ${JSON.stringify(options)}::jsonb, ${legacyPlatforms}, ${scheduledAt}, 'draft')
    RETURNING *`;
  const post = rows[0];
  if (Array.isArray(body.accountIds)) await setTargets(sql, post, body.accountIds);
  await logActivity(sql, { userId: user.id, clientId: post.client_id, postId: post.id, action: 'post.created' });
  const action = body.action || 'draft';
  if (action !== 'draft') {
    try {
      await runTransition(sql, env, ctx, user, post.id, action, { scheduledAt: body.scheduledAt, note: body.note });
    } catch (error) {
      if (error instanceof HttpError) {
        return responseJson({ post: { id: post.id }, error: `Saved as a draft. ${error.message}` }, 422);
      }
      throw error;
    }
  }
  return responseJson({ post: { id: post.id } }, 201);
}

async function updatePost(request, env, user, id) {
  requireRole(canEdit(user), 'Viewers cannot edit posts.');
  assertOrigin(request);
  const body = await readJson(request);
  if (!body) throw new HttpError(400, 'The post could not be read.');
  const sql = getSql(env);
  const post = await loadPost(sql, user, id);
  const editable = canApprove(user)
    ? ['draft', 'review', 'changes_requested', 'approved', 'scheduled', 'failed', 'partial']
    : ['draft', 'changes_requested'];
  if (!editable.includes(post.status)) {
    throw new HttpError(409, canApprove(user)
      ? 'Published or in-progress posts cannot be edited.'
      : 'This post is with an approver. Ask them to request changes if it needs editing.');
  }
  const content = typeof body.content === 'string' ? body.content.trim() : post.content;
  if (content.length > 5000) throw new HttpError(400, 'Post text must be 5,000 characters or fewer.');
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 100) : post.title;
  const media = normalizeMedia(body.media) ?? post.media;
  const options = body.options ? normalizeOptions(body.options) : post.options;
  const scheduledAt = body.scheduledAt !== undefined ? parseSchedule(body.scheduledAt) : post.scheduled_at;
  const nextStatus = ['failed', 'partial'].includes(post.status) ? 'approved' : post.status;
  await sql`
    UPDATE posts SET content = ${content}, title = ${title}, media = ${JSON.stringify(media)}::jsonb,
      options = ${JSON.stringify(options)}::jsonb, scheduled_at = ${scheduledAt}, status = ${nextStatus}, updated_at = now()
    WHERE id = ${id}`;
  if (Array.isArray(body.accountIds)) await setTargets(sql, post, body.accountIds);
  if (nextStatus !== post.status) {
    await sql`UPDATE post_targets SET status = 'pending', error = '', provider_state = '{}' WHERE post_id = ${id} AND status = 'failed'`;
  }
  await logActivity(sql, { userId: user.id, clientId: post.client_id, postId: id, action: 'post.edited' });
  return responseJson({ ok: true });
}

async function deletePost(request, env, user, id) {
  assertOrigin(request);
  const sql = getSql(env);
  const post = await loadPost(sql, user, id);
  const ownDraft = canEdit(user) && post.author_id === user.id && ['draft', 'changes_requested'].includes(post.status);
  if (!ownDraft && !canApprove(user)) throw new HttpError(403, 'Only the author (for drafts) or a manager can delete this post.');
  if (post.status === 'publishing') throw new HttpError(409, 'Wait for publishing to finish before deleting this post.');
  await sql`DELETE FROM posts WHERE id = ${id}`;
  await logActivity(sql, { userId: user.id, clientId: post.client_id, action: 'post.deleted', detail: excerpt(post) });
  return responseJson({ ok: true });
}

async function postAction(request, env, user, id, ctx) {
  assertOrigin(request);
  const body = await readJson(request);
  const sql = getSql(env);
  await runTransition(sql, env, ctx, user, id, body?.action, { note: body?.note, scheduledAt: body?.scheduledAt });
  return responseJson({ ok: true });
}

async function runTransition(sql, env, ctx, user, id, action, { note, scheduledAt } = {}) {
  const post = await loadPost(sql, user, id);
  const comment = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
  const log = (logAction, detail = comment) => logActivity(sql, { userId: user.id, clientId: post.client_id, postId: id, action: logAction, detail });
  const later = (promise) => (ctx ? ctx.waitUntil(promise) : promise);
  const actor = user.display_name || user.email;

  if (action === 'comment') {
    if (!comment) throw new HttpError(400, 'Write a comment first.');
    await log('post.comment');
    return;
  }
  if (action === 'submit') {
    requireRole(canEdit(user), 'Viewers cannot submit posts.');
    if (!['draft', 'changes_requested'].includes(post.status)) throw new HttpError(409, 'Only drafts can be submitted for approval.');
    await validatePublishable(sql, post);
    await sql`UPDATE posts SET status = 'review', submitted_at = now(), updated_at = now() WHERE id = ${id}`;
    await log('post.submitted');
    later(notify(env, await approverEmails(sql, post.client_id, user.id), `Approval needed: ${post.client_name}`,
      'A post is waiting for your approval',
      `<p>${escapeHtml(actor)} submitted “${escapeHtml(excerpt(post))}” for ${escapeHtml(post.client_name)}.</p>${comment ? `<p><i>${escapeHtml(comment)}</i></p>` : ''}`, id));
    return;
  }

  requireRole(canApprove(user), 'Only managers and admins can approve, schedule or publish posts.');

  if (action === 'approve') {
    if (post.status !== 'review') throw new HttpError(409, 'Only posts waiting for approval can be approved.');
    await validatePublishable(sql, post);
    const future = post.scheduled_at && Date.parse(post.scheduled_at) > Date.now();
    await sql`
      UPDATE posts SET status = ${future ? 'scheduled' : 'approved'}, approved_by = ${user.id}, approved_at = now(), updated_at = now()
      WHERE id = ${id}`;
    await log('post.approved');
    if (future) await wakeScheduler(env);
    if (post.author_id !== user.id) {
      later(notify(env, [post.author_email], `Approved: ${excerpt(post)}`, 'Your post was approved',
        `<p>${escapeHtml(actor)} approved “${escapeHtml(excerpt(post))}” for ${escapeHtml(post.client_name)}${future ? ` and it is scheduled for ${escapeHtml(new Date(post.scheduled_at).toUTCString())}` : ''}.</p>`, id));
    }
    return;
  }
  if (action === 'request_changes') {
    if (post.status !== 'review') throw new HttpError(409, 'Only posts waiting for approval can be sent back.');
    if (!comment) throw new HttpError(400, 'Explain what needs to change.');
    await sql`UPDATE posts SET status = 'changes_requested', updated_at = now() WHERE id = ${id}`;
    await log('post.changes_requested');
    later(notify(env, [post.author_email], `Changes requested: ${excerpt(post)}`, 'Your post needs changes',
      `<p>${escapeHtml(actor)} asked for changes to “${escapeHtml(excerpt(post))}”:</p><p><i>${escapeHtml(comment)}</i></p>`, id));
    return;
  }
  if (action === 'schedule') {
    const when = parseSchedule(scheduledAt ?? post.scheduled_at);
    if (!when || Date.parse(when) < Date.now() + 60_000) throw new HttpError(400, 'Choose a time at least one minute from now.');
    if (!['draft', 'review', 'changes_requested', 'approved', 'scheduled', 'failed', 'partial'].includes(post.status)) {
      throw new HttpError(409, 'This post cannot be scheduled in its current state.');
    }
    await validatePublishable(sql, post);
    await sql`
      UPDATE posts SET status = 'scheduled', scheduled_at = ${when}, approved_by = COALESCE(approved_by, ${user.id}),
        approved_at = COALESCE(approved_at, now()), updated_at = now()
      WHERE id = ${id}`;
    await sql`UPDATE post_targets SET status = 'pending', error = '', provider_state = '{}' WHERE post_id = ${id} AND status = 'failed'`;
    await log('post.scheduled', new Date(when).toISOString());
    await wakeScheduler(env);
    return;
  }
  if (action === 'unschedule') {
    if (post.status !== 'scheduled') throw new HttpError(409, 'This post is not scheduled.');
    await sql`UPDATE posts SET status = 'approved', updated_at = now() WHERE id = ${id}`;
    await log('post.unscheduled');
    return;
  }
  if (action === 'publish_now' || action === 'retry') {
    if (!['draft', 'review', 'changes_requested', 'approved', 'scheduled', 'failed', 'partial'].includes(post.status)) {
      throw new HttpError(409, 'This post is already published or publishing.');
    }
    await validatePublishable(sql, post);
    await sql`UPDATE post_targets SET status = 'pending', error = '', provider_state = '{}' WHERE post_id = ${id} AND status = 'failed'`;
    await sql`
      UPDATE posts SET status = 'publishing', scheduled_at = now(), approved_by = COALESCE(approved_by, ${user.id}),
        approved_at = COALESCE(approved_at, now()), updated_at = now()
      WHERE id = ${id}`;
    await log(action === 'retry' ? 'post.retry' : 'post.publish_now');
    later(runPublisher(env, ctx));
    return;
  }
  throw new HttpError(400, 'Unknown action.');
}

// ---------- Tasks ----------

async function createTask(request, env, user) {
  requireRole(canEdit(user), 'Viewers cannot create tasks.');
  assertOrigin(request);
  const body = await readJson(request);
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const dueOn = typeof body?.dueOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dueOn) ? body.dueOn : null;
  if (!title || title.length > 240) return responseJson({ error: 'Task title must be 1–240 characters.' }, 400);
  const sql = getSql(env);
  const clientId = UUID.test(body?.clientId || '') ? body.clientId : null;
  if (clientId) await assertClientAccess(sql, user, clientId);
  let assignedTo = user.id;
  if (UUID.test(body?.assignedTo || '')) {
    const member = await sql`SELECT id FROM users WHERE id = ${body.assignedTo} AND status = 'active' LIMIT 1`;
    if (!member.length) throw new HttpError(400, 'Assign the task to an active team member.');
    assignedTo = member[0].id;
  }
  const rows = await sql`
    INSERT INTO tasks (title, created_by, assigned_to, due_on, client_id)
    VALUES (${title}, ${user.id}, ${assignedTo}, ${dueOn}, ${clientId})
    RETURNING id, title, status, due_on`;
  return responseJson({ task: rows[0] }, 201);
}

async function updateTask(request, env, user, id) {
  requireRole(canEdit(user), 'Viewers cannot update tasks.');
  assertOrigin(request);
  const body = await readJson(request);
  const status = body?.status === 'done' ? 'done' : body?.status === 'todo' ? 'todo' : '';
  if (!status) return responseJson({ error: 'Choose a valid task status.' }, 400);
  const sql = getSql(env);
  const { all, ids } = await clientScope(sql, user);
  const rows = await sql`
    UPDATE tasks SET status = ${status}, updated_at = now()
    WHERE id = ${id} AND (${all} OR client_id IS NULL OR client_id = ANY(${ids}::uuid[]))
    RETURNING id, title, status, due_on`;
  return rows.length ? responseJson({ task: rows[0] }) : responseJson({ error: 'Task not found.' }, 404);
}

// ---------- Publisher (runs from the cron trigger and after "Publish now") ----------

async function wakeScheduler(env) {
  if (env.SCHEDULE) await env.SCHEDULE.delete('next_due');
}

async function loadAccount(sql, env, id) {
  const rows = await sql`
    SELECT id, platform, external_account_id, access_token_enc, refresh_token_enc, token_expires_at, metadata, status
    FROM social_accounts WHERE id = ${id} LIMIT 1`;
  const row = rows[0];
  if (!row || row.status === 'disconnected') throw new ProviderError('The account was disconnected.');
  const account = {
    id: row.id, platform: row.platform, externalId: row.external_account_id, metadata: row.metadata || {},
    accessToken: await decryptToken(env, row.access_token_enc),
    refreshToken: await decryptToken(env, row.refresh_token_enc),
    expiresAt: row.token_expires_at ? new Date(row.token_expires_at).toISOString() : null,
  };
  const fresh = await refreshIfNeeded(env, account);
  if (fresh) {
    await sql`
      UPDATE social_accounts SET access_token_enc = ${await encryptToken(env, fresh.accessToken)},
        refresh_token_enc = ${await encryptToken(env, fresh.refreshToken)}, token_expires_at = ${fresh.expiresAt},
        status = 'connected', last_error = '', updated_at = now()
      WHERE id = ${id}`;
    Object.assign(account, fresh);
  }
  return account;
}

async function publishOne(sql, env, target) {
  try {
    const account = await loadAccount(sql, env, target.social_account_id);
    const result = await publishTarget(target.platform, {
      account,
      post: { content: target.content || '', title: target.title || '', options: target.options || {} },
      media: target.media || [],
      providerState: target.provider_state || {},
      openMedia: (item) => openMedia(env, item),
    });
    if (result.status === 'processing') {
      await sql`
        UPDATE post_targets SET status = 'processing', provider_state = ${JSON.stringify(result.providerState || {})}::jsonb,
          locked_until = NULL, updated_at = now()
        WHERE id = ${target.id}`;
      return;
    }
    await sql`
      UPDATE post_targets SET status = 'published', external_post_id = ${String(result.externalId || '')},
        external_url = ${result.externalUrl || ''}, provider_state = ${JSON.stringify(result.providerState || {})}::jsonb,
        error = '', locked_until = NULL, published_at = now(), updated_at = now()
      WHERE id = ${target.id}`;
  } catch (error) {
    const message = error instanceof ProviderError ? error.message : 'Unexpected publishing error. Check the Worker logs.';
    if (!(error instanceof ProviderError)) console.error('Publishing failed:', error?.message);
    await sql`
      UPDATE post_targets SET status = 'failed', error = ${message.slice(0, 1000)}, locked_until = NULL, updated_at = now()
      WHERE id = ${target.id}`;
    if (error instanceof ProviderError && error.expired) {
      await sql`UPDATE social_accounts SET status = 'expired', last_error = ${message.slice(0, 500)}, updated_at = now() WHERE id = ${target.social_account_id}`;
    }
  }
}

async function runPublisher(env, ctx) {
  const sql = getSql(env);
  await ensureSchema(sql);
  for (let round = 0; round < 3; round += 1) {
    const claimed = await sql`
      UPDATE post_targets t
      SET status = 'publishing', locked_until = now() + interval '5 minutes', attempts = t.attempts + 1, updated_at = now()
      FROM posts p
      WHERE p.id = t.post_id AND t.id IN (
        SELECT t2.id FROM post_targets t2 JOIN posts p2 ON p2.id = t2.post_id
        WHERE p2.status IN ('scheduled', 'publishing') AND p2.scheduled_at <= now()
          AND (t2.status IN ('pending', 'processing') OR (t2.status = 'publishing' AND t2.locked_until < now()))
        ORDER BY p2.scheduled_at LIMIT 8
        FOR UPDATE OF t2 SKIP LOCKED)
      RETURNING t.id, t.post_id, t.social_account_id, t.platform, t.provider_state,
                p.content, p.title, p.media, p.options`;
    if (!claimed.length) break;
    const postIds = [...new Set(claimed.map((target) => target.post_id))];
    await sql`UPDATE posts SET status = 'publishing', updated_at = now() WHERE id = ANY(${postIds}::uuid[]) AND status = 'scheduled'`;
    await Promise.all(claimed.map((target) => publishOne(sql, env, target)));
    const finished = await sql`
      UPDATE posts p SET
        status = CASE WHEN s.open > 0 THEN 'publishing' WHEN s.failed = 0 THEN 'published'
                      WHEN s.published = 0 THEN 'failed' ELSE 'partial' END,
        published_at = CASE WHEN s.open = 0 AND s.published > 0 THEN now() ELSE p.published_at END,
        updated_at = now()
      FROM (
        SELECT post_id,
               count(*) FILTER (WHERE status IN ('pending', 'publishing', 'processing')) AS open,
               count(*) FILTER (WHERE status = 'failed') AS failed,
               count(*) FILTER (WHERE status = 'published') AS published
        FROM post_targets WHERE post_id = ANY(${postIds}::uuid[]) GROUP BY post_id
      ) s
      WHERE p.id = s.post_id AND p.status = 'publishing'
      RETURNING p.id, p.status, p.client_id, p.content, p.title, p.author_id`;
    for (const post of finished.filter((item) => item.status !== 'publishing')) {
      await logActivity(sql, { clientId: post.client_id, postId: post.id, action: `post.${post.status}` });
      if (post.status !== 'published') {
        const errors = await sql`
          SELECT t.platform, t.error FROM post_targets t WHERE t.post_id = ${post.id} AND t.status = 'failed'`;
        const recipients = (await sql`SELECT email FROM users WHERE id = ${post.author_id} AND status = 'active'`).map((row) => row.email);
        const send = notify(env, [...recipients, ...await approverEmails(sql, post.client_id, post.author_id)],
          `Publishing ${post.status === 'failed' ? 'failed' : 'partly failed'}: ${excerpt(post)}`,
          'A post did not publish everywhere',
          `<ul>${errors.map((row) => `<li><b>${escapeHtml(row.platform)}</b>: ${escapeHtml(row.error)}</li>`).join('')}</ul>`, post.id);
        if (ctx) ctx.waitUntil(send); else await send;
      }
    }
  }
  if (env.SCHEDULE) {
    const next = await sql`
      SELECT
        bool_or(t.status IN ('processing', 'publishing')) AS busy,
        min(p.scheduled_at) FILTER (WHERE t.status = 'pending') AS next_at
      FROM post_targets t JOIN posts p ON p.id = t.post_id
      WHERE p.status IN ('scheduled', 'publishing') AND t.status IN ('pending', 'processing', 'publishing')`;
    const busy = next[0]?.busy;
    const nextAt = next[0]?.next_at ? Date.parse(next[0].next_at) : Date.now() + 6 * 60 * 60 * 1000;
    await env.SCHEDULE.put('next_due', String(busy ? Date.now() + 60_000 : Math.min(nextAt, Date.now() + 6 * 60 * 60 * 1000)));
  }
}

async function scheduled(env, ctx) {
  if (!env.DATABASE_URL) return;
  if (env.SCHEDULE) {
    const nextDue = Number(await env.SCHEDULE.get('next_due') || 0);
    if (nextDue > Date.now()) return;
  } else if (new Date().getUTCMinutes() % 10 !== 0) {
    // Without the KV gate, check every 10 minutes to avoid keeping the database awake.
    return;
  }
  await runPublisher(env, ctx);
}

// ---------- Router ----------

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  await ensureSchema(getSql(env));
  if (pathname === '/api/auth/request' && method === 'POST') return requestLoginLink(request, env);
  if (pathname === '/api/auth/verify' && method === 'POST') return verifyLoginLink(request, env);
  if (pathname === '/api/auth/logout' && method === 'POST') return logout(request, env);
  const oauthCallback = pathname.match(/^\/api\/oauth\/(meta|tiktok|google)\/callback$/);
  if (oauthCallback && method === 'GET') return finishOAuth(request, env, oauthCallback[1], url);

  const user = await getUser(request, env);
  if (pathname === '/api/auth/me' && method === 'GET') {
    return user ? responseJson({ user: publicUser(user) }) : responseJson({ error: 'Not signed in.' }, 401);
  }
  if (!user) {
    if (pathname === '/api/oauth/start') return redirect('/#settings');
    return responseJson({ error: 'Sign in to continue.' }, 401);
  }

  if (pathname === '/api/config' && method === 'GET') return workspaceConfig(env, user);
  if (pathname === '/api/dashboard' && method === 'GET') return dashboard(env, user);
  if (pathname === '/api/clients' && method === 'POST') return createClient(request, env, user);
  if (pathname === '/api/team' && method === 'GET') return listTeam(env, user);
  if (pathname === '/api/team' && method === 'POST') return inviteMember(request, env, user);
  const memberMatch = pathname.match(/^\/api\/team\/([0-9a-f-]{36})(\/resend)?$/i);
  if (memberMatch && method === 'PATCH' && !memberMatch[2]) return updateMember(request, env, user, memberMatch[1]);
  if (memberMatch && method === 'POST' && memberMatch[2]) return resendInvite(request, env, user, memberMatch[1]);
  if (pathname === '/api/accounts' && method === 'GET') return listAccounts(env, user, url);
  const accountMatch = pathname.match(/^\/api\/accounts\/([0-9a-f-]{36})$/i);
  if (accountMatch && method === 'DELETE') return disconnectAccount(request, env, user, accountMatch[1]);
  if (pathname === '/api/oauth/start' && method === 'GET') return startOAuth(env, user, url);
  if (pathname === '/api/media' && method === 'POST') return uploadMedia(request, env, user, url);
  if (pathname === '/api/posts' && method === 'GET') return listPosts(env, user, url);
  if (pathname === '/api/posts' && method === 'POST') return createPost(request, env, user, ctx);
  const postMatch = pathname.match(/^\/api\/posts\/([0-9a-f-]{36})(\/actions)?$/i);
  if (postMatch && !postMatch[2] && method === 'GET') return getPost(env, user, postMatch[1]);
  if (postMatch && !postMatch[2] && method === 'PATCH') return updatePost(request, env, user, postMatch[1]);
  if (postMatch && !postMatch[2] && method === 'DELETE') return deletePost(request, env, user, postMatch[1]);
  if (postMatch && postMatch[2] && method === 'POST') return postAction(request, env, user, postMatch[1], ctx);
  if (pathname === '/api/tasks' && method === 'POST') return createTask(request, env, user);
  const taskMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
  if (taskMatch && method === 'PATCH') return updateTask(request, env, user, taskMatch[1]);
  return responseJson({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(request.method)) return serveMedia(request, env, url.pathname);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) return responseJson({ error: error.message }, error.status);
      console.error('API request failed:', error?.message);
      return responseJson({ error: 'The service is temporarily unavailable.' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env, ctx));
  },
};
