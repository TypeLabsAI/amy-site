/**
 * Amy Gmail API Worker
 * 
 * Multi-account Gmail OAuth + sending via Gmail API.
 * Tokens stored in KV, auto-refresh on expiry.
 * 
 * Routes:
 *   GET  /auth/start?account=EMAIL    -> Start OAuth flow
 *   GET  /auth/callback               -> OAuth callback
 *   GET  /auth/accounts               -> List connected accounts
 *   POST /api/send-email              -> Send email via Gmail API
 */

const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    const url = new URL(request.url);

    try {
      // OAuth start
      if (url.pathname === '/auth/start') {
        return handleAuthStart(url, env);
      }

      // OAuth callback
      if (url.pathname === '/auth/callback') {
        return handleAuthCallback(url, env);
      }

      // List accounts
      if (url.pathname === '/auth/accounts') {
        return handleListAccounts(env);
      }

      // Send email
      if (url.pathname === '/api/send-email' && request.method === 'POST') {
        return handleSendEmail(request, env);
      }

      return corsResponse(JSON.stringify({ error: 'Not found' }), 404);
    } catch (err) {
      return corsResponse(JSON.stringify({ error: err.message }), 500);
    }
  }
};

// ── OAuth Handlers ─────────────────────────────────────────────

function handleAuthStart(url, env) {
  const account = url.searchParams.get('account') || '';
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GMAIL_SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', account);
  authUrl.searchParams.set('login_hint', account);
  return Response.redirect(authUrl.toString(), 302);
}

async function handleAuthCallback(url, env) {
  const code = url.searchParams.get('code');
  const account = url.searchParams.get('state') || 'unknown';

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();
  if (tokens.error) {
    return corsResponse(`<h1>Auth Failed</h1><pre>${JSON.stringify(tokens)}</pre>`, 400, 'text/html');
  }

  // Store tokens in KV
  await env.AMY_KV.put(`token:${account}`, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in * 1000),
    account,
  }));

  // Update account list
  const listRaw = await env.AMY_KV.get('accounts') || '[]';
  const list = JSON.parse(listRaw);
  if (!list.includes(account)) {
    list.push(account);
    await env.AMY_KV.put('accounts', JSON.stringify(list));
  }

  return new Response(`<html><body style="background:#0a0a0a;color:#fff;font-family:system-ui;padding:40px;text-align:center"><h1 style="color:#00e5cc">Connected!</h1><p>${account} is now linked.</p><a href="/auth/accounts" style="color:#00e5cc">View all accounts</a></body></html>`, {
    headers: { 'Content-Type': 'text/html' },
  });
}

async function handleListAccounts(env) {
  const listRaw = await env.AMY_KV.get('accounts') || '[]';
  const accounts = JSON.parse(listRaw);

  let html = `<!DOCTYPE html><html><head><style>body{background:#0a0a0a;color:#fff;font-family:system-ui;padding:40px;max-width:600px;margin:0 auto}h1{color:#00e5cc;font-size:24px;margin-bottom:24px}.account{padding:16px;border:1px solid #222;border-radius:8px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}.email{font-size:16px}.status{font-size:12px;padding:4px 8px;border-radius:4px}.connected{background:#0a2a1a;color:#22c55e}.disconnected{background:#2a0a0a;color:#ef4444}.add-btn{display:block;margin-top:24px;padding:12px 24px;background:#00e5cc;color:#000;text-align:center;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px}.add-btn:hover{background:#00b8a3}</style></head><body><h1>Gmail Accounts</h1>`;

  for (const account of accounts) {
    const tokenRaw = await env.AMY_KV.get(`token:${account}`);
    const connected = !!tokenRaw;
    html += `<div class="account"><span class="email">${account}</span><span class="status ${connected ? 'connected' : 'disconnected'}">${connected ? 'Connected' : 'Disconnected'}</span></div>`;
  }

  html += `<a class="add-btn" href="/auth/start">+ Connect Gmail Account</a><p style="margin-top:16px;font-size:12px;color:#555">Each account authenticates once. Tokens refresh automatically.</p></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

// ── Send Email ─────────────────────────────────────────────────

async function handleSendEmail(request, env) {
  const body = await request.json();
  const { from, to, subject, body: emailBody } = body;

  if (!from || !to || !subject || !emailBody) {
    return corsResponse(JSON.stringify({ error: 'Missing required fields: from, to, subject, body' }), 400);
  }

  // Get access token for the from account
  const accessToken = await getValidToken(from, env);
  if (!accessToken) {
    return corsResponse(JSON.stringify({ error: `Account ${from} not connected. Visit /auth/start?account=${from}` }), 401);
  }

  // Build RFC 2822 email
  const toAddr = Array.isArray(to) ? to[0] : to;
  const rawEmail = [
    `From: ${from}`,
    `To: ${toAddr}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    emailBody,
  ].join('\r\n');

  // Base64url encode
  const encoded = btoa(unescape(encodeURIComponent(rawEmail)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Send via Gmail API
  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  });

  const result = await sendRes.json();

  if (!sendRes.ok) {
    return corsResponse(JSON.stringify({ error: result.error?.message || 'Gmail send failed', details: result }), sendRes.status);
  }

  return corsResponse(JSON.stringify({ ok: true, messageId: result.id, threadId: result.threadId }));
}

// ── Token Management ───────────────────────────────────────────

async function getValidToken(account, env) {
  const tokenRaw = await env.AMY_KV.get(`token:${account}`);
  if (!tokenRaw) return null;

  const tokenData = JSON.parse(tokenRaw);

  // If token expires in < 5 min, refresh it
  if (Date.now() > tokenData.expires_at - 300000) {
    if (!tokenData.refresh_token) return null;

    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: tokenData.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    const refreshData = await refreshRes.json();
    if (refreshData.error) return null;

    tokenData.access_token = refreshData.access_token;
    tokenData.expires_at = Date.now() + (refreshData.expires_in * 1000);
    
    // Preserve refresh token (not always returned on refresh)
    await env.AMY_KV.put(`token:${account}`, JSON.stringify(tokenData));
  }

  return tokenData.access_token;
}

// ── Helpers ────────────────────────────────────────────────────

function corsResponse(body, status = 200, contentType = 'application/json') {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': contentType,
    },
  });
}
