/**
 * Amy Email Server
 * 
 * Lightweight Node.js server that handles email sending via Resend API.
 * Runs on port 3001, proxied by the main Python server or Cloudflare tunnel.
 * 
 * SETUP:
 * 1. npm install express resend cors
 * 2. Set RESEND_API_KEY env var
 * 3. node email-server.js
 * 
 * Or run via the launch daemon (see README).
 */

const express = require('express');
const { Resend } = require('resend');
const cors = require('cors');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

// Allowed sender addresses (mail.typelabs.ai is the verified Resend domain)
const ALLOWED_SENDERS = {
  'ryan@mail.typelabs.ai': { name: 'Ryan Hooks', replyTo: 'ryan@typelabs.ai' },
  'amy.bot@mail.typelabs.ai': { name: 'Amy', replyTo: 'amy.bot@typelabs.ai' }
};

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'amy-email' });
});

// Send email endpoint
app.post('/api/send-email', async (req, res) => {
  try {
    const { from, to, subject, text, html, replyTo } = req.body;

    // Validate required fields
    if (!from || !to || !subject || (!text && !html)) {
      return res.status(400).json({ error: 'Missing required fields: from, to, subject, text/html' });
    }

    // Extract email from "Name <email>" format
    const fromMatch = from.match(/<(.+?)>/);
    const fromEmail = fromMatch ? fromMatch[1] : from;

    // Verify sender is allowed
    if (!ALLOWED_SENDERS[fromEmail]) {
      return res.status(403).json({ 
        error: `Sender ${fromEmail} not authorized. Allowed: ${Object.keys(ALLOWED_SENDERS).join(', ')}` 
      });
    }

    const emailPayload = {
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      text: text || '',
      html: html || text.replace(/\n/g, '<br>'),
      replyTo: replyTo || ALLOWED_SENDERS[fromEmail].replyTo
    };

    console.log(`[Amy Email] Sending to ${emailPayload.to.join(', ')} from ${fromEmail}`);

    const { data, error } = await resend.emails.send(emailPayload);

    if (error) {
      console.error('[Amy Email] Resend error:', error);
      return res.status(500).json({ error: error.message || JSON.stringify(error) });
    }

    console.log(`[Amy Email] Sent successfully (id: ${data?.id})`);
    return res.json({ ok: true, id: data?.id });

  } catch (err) {
    console.error('[Amy Email] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Amy Email] Server running on port ${PORT}`);
  console.log(`[Amy Email] Resend API key: ${process.env.RESEND_API_KEY ? 'SET' : 'NOT SET'}`);
});
