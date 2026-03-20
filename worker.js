/**
 * Amy Cloud Store — Cloudflare Worker
 * 
 * Receives chat submissions from the Amy frontend,
 * stores them in KV, and sends email alerts via MailChannels.
 * 
 * SETUP:
 * 1. Create a KV namespace called AMY_DATA in Cloudflare dashboard
 * 2. Deploy this worker: `wrangler deploy`
 * 3. Set AMY_CONFIG.cloudUrl in index.html to your worker URL
 * 
 * ENV VARS (set in wrangler.toml or dashboard):
 * - ALERT_EMAIL: ryan@typelabs.ai
 * - FROM_EMAIL: amy@typelabs.ai (or noreply@typelabs.ai)
 */

export default {
  async fetch(request, env) {
    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    // POST /submit — store a new submission
    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/submit')) {
      try {
        const body = await request.json();
        const id = body.id || Date.now().toString(36);
        const key = `sub:${id}`;

        // Store in KV
        await env.AMY_DATA.put(key, JSON.stringify({
          ...body,
          ip: request.headers.get('CF-Connecting-IP'),
          country: request.headers.get('CF-IPCountry'),
          stored: new Date().toISOString()
        }), { expirationTtl: 60 * 60 * 24 * 90 }); // 90 days

        // Update index
        const indexRaw = await env.AMY_DATA.get('index') || '[]';
        const index = JSON.parse(indexRaw);
        index.push({ id, ts: body.ts, mode: body.mode, preview: (body.input || '').slice(0, 80) });
        // Keep last 1000
        while (index.length > 1000) index.shift();
        await env.AMY_DATA.put('index', JSON.stringify(index));

        // Send email alert via MailChannels (free on CF Workers)
        if (env.ALERT_EMAIL && body.input) {
          await sendAlert(env, body);
        }

        return new Response(JSON.stringify({ ok: true, id }), { headers: cors });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
      }
    }

    // GET /submissions — list all (protected by simple token)
    if (request.method === 'GET' && url.pathname === '/submissions') {
      const token = url.searchParams.get('token');
      if (token !== env.ADMIN_TOKEN) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });
      }

      const indexRaw = await env.AMY_DATA.get('index') || '[]';
      return new Response(indexRaw, { headers: cors });
    }

    // GET /submission/:id — get one
    if (request.method === 'GET' && url.pathname.startsWith('/submission/')) {
      const token = url.searchParams.get('token');
      if (token !== env.ADMIN_TOKEN) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });
      }

      const id = url.pathname.split('/').pop();
      const data = await env.AMY_DATA.get(`sub:${id}`);
      if (!data) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: cors });
      return new Response(data, { headers: cors });
    }

    return new Response(JSON.stringify({ service: 'Amy Cloud Store', status: 'ok' }), { headers: cors });
  }
};

async function sendAlert(env, submission) {
  try {
    await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{
          to: [{ email: env.ALERT_EMAIL || 'ryan@typelabs.ai', name: 'Ryan' }]
        }],
        from: {
          email: env.FROM_EMAIL || 'amy@typelabs.ai',
          name: 'Amy Alert'
        },
        subject: `Amy [${submission.mode}] New message`,
        content: [{
          type: 'text/plain',
          value: [
            `Mode: ${submission.mode}`,
            `Input: ${submission.input}`,
            `Time: ${submission.ts}`,
            submission.response ? `Response: ${submission.response}` : '',
            submission.error ? `Error: ${submission.error}` : '',
            '',
            '— Amy Cloud Store'
          ].filter(Boolean).join('\n')
        }]
      })
    });
  } catch (err) {
    console.error('Email alert failed:', err);
  }
}
