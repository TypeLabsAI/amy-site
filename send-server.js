/**
 * Amy Email Send Server
 * 
 * Express backend that sends emails through connected Gmail accounts
 * via the external-tool CLI. Designed to be called from the Amy Dashboard.
 * 
 * Supports:
 * - ryan@typelabs.ai (via gcal connector, connection_id 2638499)
 * - debahooks@gmail.com (via gcal connector — needs separate connection)
 * - ryan@globalproto.com (via gcal connector — needs separate connection)
 * 
 * POST /api/send-email
 * Body: { to, subject, body, from }
 * 
 * GET /api/health
 * Returns: { status: "ok", accounts: [...] }
 */

const express = require('express');
const cors = require('cors');
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5555;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Account config ---
// Maps sender email → gcal connection_id
// When a new Gmail account is connected, add its connection_id here
const ACCOUNT_MAP = {
  'ryan@typelabs.ai': { connectionId: 2638499, name: 'Ryan Hooks (TypeLabs)' },
  'debahooks@gmail.com': { connectionId: 2925388, name: 'Deb Hooks' },
  // TODO: Add after connecting the account
  // 'ryan@globalproto.com': { connectionId: null, name: 'Ryan Hooks (GlobalProto)' },
};

// --- Send log ---
const SEND_LOG_PATH = path.join(__dirname, 'send-log.json');

function loadSendLog() {
  try {
    if (fs.existsSync(SEND_LOG_PATH)) {
      return JSON.parse(fs.readFileSync(SEND_LOG_PATH, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveSendLog(log) {
  fs.writeFileSync(SEND_LOG_PATH, JSON.stringify(log, null, 2));
}

function logSend(entry) {
  const log = loadSendLog();
  log.push({ ...entry, timestamp: new Date().toISOString() });
  saveSendLog(log);
}

// --- External tool helper ---
function callExternalTool(sourceId, toolName, args) {
  const params = JSON.stringify({
    source_id: sourceId,
    tool_name: toolName,
    arguments: args,
  });
  
  // Escape single quotes in params for shell
  const escaped = params.replace(/'/g, "'\\''");
  
  try {
    const result = execSync(`external-tool call '${escaped}'`, {
      timeout: 30000,
      encoding: 'utf8',
    });
    return JSON.parse(result);
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    throw new Error(`External tool error: ${stderr || stdout || err.message}`);
  }
}

// --- Routes ---

// Health check
app.get('/api/health', (req, res) => {
  const accounts = Object.entries(ACCOUNT_MAP).map(([email, config]) => ({
    email,
    name: config.name,
    connected: config.connectionId !== null,
  }));
  
  res.json({
    status: 'ok',
    service: 'amy-send-server',
    version: '1.0',
    accounts,
  });
});

// Send email
app.post('/api/send-email', (req, res) => {
  const { to, subject, body, from } = req.body;
  
  // Validate required fields
  if (!to || !subject || !body) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['to', 'subject', 'body'],
    });
  }
  
  // Look up sender account
  const fromEmail = from || 'ryan@typelabs.ai';
  const account = ACCOUNT_MAP[fromEmail];
  
  if (!account) {
    return res.status(400).json({
      error: `Unknown sender: ${fromEmail}`,
      available: Object.keys(ACCOUNT_MAP),
    });
  }
  
  if (!account.connectionId) {
    return res.status(400).json({
      error: `Account ${fromEmail} is not yet connected. Add the Gmail connection first.`,
    });
  }
  
  console.log(`Sending email from ${fromEmail} to ${to}: "${subject}"`);
  
  try {
    const result = callExternalTool('gcal', 'send_email', {
      action: {
        action: 'send',
        to: [to],
        cc: [],
        bcc: [],
        subject: subject,
        body: body,
        connection_id: account.connectionId,
      },
    });
    
    // Log the send
    logSend({
      from: fromEmail,
      to,
      subject,
      status: 'sent',
      result: typeof result === 'string' ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200),
    });
    
    console.log(`✓ Email sent from ${fromEmail} to ${to}`);
    
    res.json({
      ok: true,
      from: fromEmail,
      to,
      subject,
      message: 'Email sent successfully',
    });
    
  } catch (err) {
    console.error(`✗ Failed to send from ${fromEmail} to ${to}:`, err.message);
    
    logSend({
      from: fromEmail,
      to,
      subject,
      status: 'failed',
      error: err.message,
    });
    
    res.status(500).json({
      error: 'Failed to send email',
      details: err.message,
    });
  }
});

// Get send log
app.get('/api/send-log', (req, res) => {
  const log = loadSendLog();
  res.json(log);
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Amy Send Server running on port ${PORT}`);
  console.log(`Accounts configured: ${Object.keys(ACCOUNT_MAP).join(', ')}`);
});
