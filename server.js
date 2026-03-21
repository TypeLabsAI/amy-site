/**
 * Amy Unified Server
 * 
 * Serves static files + email API on a single port (3000).
 * Replaces the Python HTTP server on the Mac Mini.
 * 
 * SETUP:
 * 1. cd ~/projects/amy-site
 * 2. npm install
 * 3. RESEND_API_KEY=re_xxxxx node server.js
 * 
 * ROUTES:
 *   GET  /*              -> Static files (index.html, assets)
 *   POST /api/send-email -> Send email via Resend
 *   GET  /api/health     -> Health check
 */

const express = require('express');
const { Resend } = require('resend');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Resend client (lazy init so server starts even without key)
let resend = null;
function getResend() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// Allowed sender addresses (mail.typelabs.ai is the verified Resend domain)
const ALLOWED_SENDERS = {
  'ryan@mail.typelabs.ai': { name: 'Ryan Hooks', replyTo: 'ryan@typelabs.ai' },
  'amy.bot@mail.typelabs.ai': { name: 'Amy', replyTo: 'amy.bot@typelabs.ai' }
};

// ── API Routes ─────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'amy-server',
    resend: !!process.env.RESEND_API_KEY,
    uptime: process.uptime()
  });
});

app.post('/api/send-email', async (req, res) => {
  try {
    const client = getResend();
    if (!client) {
      return res.status(503).json({ error: 'Email not configured. Set RESEND_API_KEY.' });
    }

    const { from, to, subject, text, html, replyTo } = req.body;

    if (!from || !to || !subject || (!text && !html)) {
      return res.status(400).json({ error: 'Missing required fields: from, to, subject, text/html' });
    }

    // Extract email from "Name <email>" format
    const fromMatch = from.match(/<(.+?)>/);
    const fromEmail = fromMatch ? fromMatch[1] : from;

    if (!ALLOWED_SENDERS[fromEmail]) {
      return res.status(403).json({ 
        error: `Sender not authorized. Use: ${Object.keys(ALLOWED_SENDERS).join(', ')}` 
      });
    }

    const emailPayload = {
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      text: text || '',
      html: html || (text || '').replace(/\n/g, '<br>'),
      replyTo: replyTo || ALLOWED_SENDERS[fromEmail].replyTo
    };

    console.log(`[Amy] Sending email to ${emailPayload.to.join(', ')} from ${fromEmail}`);

    const { data, error } = await client.emails.send(emailPayload);

    if (error) {
      console.error('[Amy] Resend error:', error);
      return res.status(500).json({ error: error.message || JSON.stringify(error) });
    }

    console.log(`[Amy] Email sent (id: ${data?.id})`);
    return res.json({ ok: true, id: data?.id });

  } catch (err) {
    console.error('[Amy] Email error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Static Files ───────────────────────────────────────────────

app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: 'index.html'
}));

// Fallback to index.html for SPA-like behavior
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Amy] Server running on port ${PORT}`);
  console.log(`[Amy] Resend: ${process.env.RESEND_API_KEY ? 'configured' : 'not configured (email disabled)'}`);
  console.log(`[Amy] Static: ${__dirname}`);
});
