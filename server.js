require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const TICKETS_FILE = path.join(__dirname, 'tickets.json');
const ON_VERCEL = !!process.env.VERCEL;

if (!API_KEY) {
  console.error('\n❌  ANTHROPIC_API_KEY not set. Create a .env file — see .env.example\n');
  process.exit(1);
}

// ── Middleware ────────────────────────────────────────────────────────────────

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'null'];

app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait a few minutes and try again.' }
}));

// ── Storage ───────────────────────────────────────────────────────────────────
// Local: persists to tickets.json. Vercel: in-memory (resets on cold start).
// To add a real DB, replace readTickets/writeTicket with your DB calls.

let _mem = [];

function readTickets() {
  if (ON_VERCEL) return _mem;
  try { return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8')); } catch { return []; }
}

function writeTicket(ticket) {
  if (ON_VERCEL) { _mem.unshift(ticket); return; }
  try {
    const all = readTickets();
    all.unshift(ticket);
    fs.writeFileSync(TICKETS_FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    console.error('⚠️  Storage write failed:', e.message);
  }
}

function genId() {
  return 'ARIA-' + Date.now().toString(36).toUpperCase().slice(-6);
}

// ── Claude helper ─────────────────────────────────────────────────────────────
// Retries automatically on 529 Overloaded with exponential backoff.

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callClaude(messages, system, maxTokens = 1500) {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [2000, 5000, 10000]; // 2s → 5s → 10s

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages })
    });

    // 529 = Anthropic overloaded — wait and retry
    if (res.status === 529) {
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAYS[attempt];
        console.warn(`⚠️  Anthropic overloaded (attempt ${attempt + 1}/${MAX_RETRIES}). Retrying in ${delay / 1000}s...`);
        await sleep(delay);
        continue;
      }
      throw new Error('The AI service is temporarily busy. Please wait a moment and try again.');
    }

    // 529 aside, surface any other API error clearly
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      const msg = e.error?.message || `Anthropic API error ${res.status}`;
      throw new Error(msg.includes('overload') || msg.includes('Overload')
        ? 'The AI service is temporarily busy. Please wait a moment and try again.'
        : msg);
    }

    return (await res.json()).content[0].text.trim();
  }
}

function parseJSON(raw) {
  return JSON.parse(raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const CRS_TEAM = `CRS Enterprise Analytics team:
- 2 Data Engineers (Oracle ERP pipelines, Snowflake, ETL/ELT)
- 3 Data Analysts (Power BI dashboards, reporting, ad-hoc analysis)
- 1 Data Scientist (predictive models, statistical analysis)
Tech stack: Oracle ERP · Snowflake · Power BI · Microsoft Fabric
Operating across 110+ countries.`;

const TRIAGE_SYSTEM = `You are ARIA — Analytics Request Intelligence Agent for Catholic Relief Services (CRS), a global humanitarian organization.

${CRS_TEAM}

Triage the incoming analytics request. Return ONLY valid JSON with no markdown fences or preamble:
{
  "quickTriage": {
    "category": "Operational Report|Dashboard Build|Ad-hoc Analysis|Data Pipeline|Strategic Insight",
    "complexity": "Low|Medium|High",
    "routed_to": "Data Engineer|Data Analyst|Data Scientist|Analytics Lead",
    "effort_estimate": "Hours|1-2 days|3-5 days|1-2 weeks|2+ weeks",
    "rationale": "1-2 sentence explanation of classification and routing"
  },
  "chatOpener": "Warm, professional 2-3 sentence message acknowledging the request and noting you have a few questions before finalizing. Do NOT list the questions here.",
  "clarifyingQuestions": ["targeted question 1", "targeted question 2", "targeted question 3"]
}`;

const buildChatSystem = (ctx) => `You are ARIA — Analytics Request Intelligence Agent for Catholic Relief Services (CRS).

${CRS_TEAM}

You are in the REFINEMENT PHASE of triaging an analytics request. Your goal is a focused professional conversation to gather enough detail for a precise project ticket.

INITIAL REQUEST CONTEXT:
${JSON.stringify(ctx, null, 2)}

Rules:
- Be concise and professional. This is an enterprise tool.
- Ask at most one targeted follow-up question per response.
- Acknowledge and incorporate everything the requester tells you.
- When you have sufficient information to write a complete ticket, include the exact phrase "ready to finalize" in your response AND explicitly tell the requester: "Click the **Generate Final Ticket** button below to create your ticket."
- Never output JSON in this phase — plain conversational text only.`;

const buildFinalizeSystem = (ctx) => `You are ARIA — Analytics Request Intelligence Agent for Catholic Relief Services (CRS).

${CRS_TEAM}

Generate a final structured project ticket based on the full conversation and request context below.
Return ONLY valid JSON with no markdown fences or preamble:
{
  "category": "Operational Report|Dashboard Build|Ad-hoc Analysis|Data Pipeline|Strategic Insight",
  "complexity": "Low|Medium|High",
  "routed_to": "Data Engineer|Data Analyst|Data Scientist|Analytics Lead",
  "effort_estimate": "Hours|1-2 days|3-5 days|1-2 weeks|2+ weeks",
  "rationale": "1-2 sentence rationale for classification and routing",
  "scoping_brief": "2-3 sentences: work to be done, likely data sources, expected output",
  "ticket": {
    "title": "Concise action-oriented title",
    "objective": "What this work will achieve for the requester",
    "data_sources": "Likely Oracle ERP tables, Snowflake schemas, or other sources",
    "expected_output": "Specific deliverable format (dashboard, report, model, pipeline, etc.)",
    "success_criteria": "How we know the work is done well",
    "dependencies": "Data access, stakeholder sign-off, or other blockers",
    "estimated_effort": "Realistic effort breakdown by phase"
  }
}

INITIAL REQUEST CONTEXT:
${JSON.stringify(ctx, null, 2)}`;

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    agent: 'ARIA',
    version: '2.0',
    model: MODEL,
    storage: ON_VERCEL ? 'in-memory' : 'file',
    ticketCount: readTickets().length
  });
});

// Initial triage (manual portal) — quick analysis + chat opener
app.post('/api/triage', async (req, res) => {
  const { requester, department, country, description, urgency, dataDomain } = req.body;

  if (!requester?.trim() || !department?.trim())
    return res.status(400).json({ error: 'Name and department are required.' });
  if (!description?.trim() || description.trim().length < 10)
    return res.status(400).json({ error: 'Please describe your analytics need in more detail.' });

  const userMsg = `Analytics request from ${requester} (${department}${country ? ', ' + country : ''}):
Urgency: ${urgency || 'Standard'} | Data Domain: ${dataDomain || 'Not specified'}

"${description.trim()}"`;

  try {
    const raw = await callClaude([{ role: 'user', content: userMsg }], TRIAGE_SYSTEM);
    const result = parseJSON(raw);
    const sessionContext = { requester, department, country, description, urgency, dataDomain, quickTriage: result.quickTriage };
    res.json({ success: true, ...result, sessionContext });
  } catch (e) {
    console.error('Triage error:', e.message);
    res.status(500).json({ error: e.message || 'Triage failed. Please try again.' });
  }
});

// Chat refinement turn — conversational back-and-forth
app.post('/api/chat', async (req, res) => {
  const { messages, sessionContext } = req.body;

  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array is required.' });
  if (!sessionContext)
    return res.status(400).json({ error: 'sessionContext is required.' });

  try {
    const text = await callClaude(messages, buildChatSystem(sessionContext), 700);
    res.json({
      success: true,
      message: text,
      readyToFinalize: text.toLowerCase().includes('ready to finalize')
    });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message || 'Chat failed. Please try again.' });
  }
});

// Finalize — generate structured ticket from full conversation
app.post('/api/finalize', async (req, res) => {
  const { messages, sessionContext } = req.body;

  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array is required.' });
  if (!sessionContext)
    return res.status(400).json({ error: 'sessionContext is required.' });

  const conversationText = messages
    .map(m => `${m.role === 'user' ? 'REQUESTER' : 'ARIA'}: ${m.content}`)
    .join('\n\n');

  const finalMsg = `Full conversation:\n\n${conversationText}\n\nGenerate the final structured project ticket based on everything discussed.`;

  try {
    const raw = await callClaude([{ role: 'user', content: finalMsg }], buildFinalizeSystem(sessionContext), 1800);
    const ticket = parseJSON(raw);
    const ticketId = genId();
    const record = {
      ticketId,
      timestamp: new Date().toISOString(),
      requester: sessionContext.requester,
      department: sessionContext.department,
      country: sessionContext.country || null,
      source: 'manual',
      status: 'Open',
      ...ticket
    };
    writeTicket(record);
    console.log(`\n📋 ${ticketId} | ${ticket.category} | ${ticket.complexity} → ${ticket.routed_to}`);

    // Fire Power Automate webhook if configured — non-blocking
    if (process.env.POWER_AUTOMATE_WEBHOOK_URL) {
      fetch(process.env.POWER_AUTOMATE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record)
      }).catch(e => console.warn('⚠️  Webhook delivery failed:', e.message));
    }

    res.json({ success: true, ticketId, ticket, timestamp: record.timestamp });
  } catch (e) {
    console.error('Finalize error:', e.message);
    res.status(500).json({ error: e.message || 'Could not generate ticket. Please try again.' });
  }
});

// Email webhook — Power Automate sends raw email, gets full ticket back immediately
app.post('/api/triage/email', async (req, res) => {
  const { from, subject, body } = req.body;

  if (!body?.trim() || body.trim().length < 10)
    return res.status(400).json({ error: 'Email body is required.' });

  const userMsg = `Incoming email to analytics-requests@crs.org:
From: ${from}
Subject: ${subject || '(No subject)'}

${body}`;

  const ctx = {
    requester: from,
    department: 'Email Submission',
    description: `${subject ? subject + ': ' : ''}${body}`
  };

  try {
    const raw = await callClaude([{ role: 'user', content: userMsg }], buildFinalizeSystem(ctx), 1800);
    const ticket = parseJSON(raw);
    const ticketId = genId();
    const record = {
      ticketId,
      timestamp: new Date().toISOString(),
      requester: from,
      department: 'Email Submission',
      source: 'email',
      status: 'Open',
      ...ticket
    };
    writeTicket(record);
    console.log(`\n📧 ${ticketId} | From: ${from}`);
    res.json({ success: true, ticketId, triage: ticket, timestamp: record.timestamp });
  } catch (e) {
    console.error('Email triage error:', e.message);
    res.status(500).json({ error: e.message || 'Email triage failed.' });
  }
});

// Ticket history — used by the dashboard
app.get('/api/tickets', (req, res) => {
  res.json({ tickets: readTickets() });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n🤖 ARIA v2.0 — Analytics Request Intelligence Agent');
  console.log(`   App:      http://localhost:${PORT}`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
  console.log(`   Storage:  ${ON_VERCEL ? 'in-memory (Vercel)' : TICKETS_FILE}`);
  console.log(`   Model:    ${MODEL}`);
  console.log(`   API key:  ${API_KEY.slice(0, 16)}... ✓\n`);
});

module.exports = app;
