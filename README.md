# ARIA — Analytics Request Intelligence Agent

**ARIA** is an AI-powered request triage system built for the CRS Enterprise Analytics team. It takes an incoming analytics request in plain language and — through a conversational refinement session — classifies it, routes it to the right analyst profile, and generates a structured project ticket ready to action.

Built as a capstone project for the **AI for Business Leaders** programme (Skillsbridges, 2026).

---

## How it works

```
Staff submits request
       ↓
ARIA reads it → instant preliminary classification (category, complexity, routing)
       ↓
Chat refinement → ARIA asks targeted questions, user answers, scope sharpens
       ↓
User clicks "Generate Final Ticket" → structured project ticket is created and logged
```

For **email submissions**, Power Automate monitors `analytics-requests@crs.org`, calls the `/api/triage/email` webhook, and dispatches four outputs simultaneously — Teams notification, analyst email, SharePoint log, and requester confirmation — with zero human intervention.

---

## Running locally

**Prerequisites:** Node.js ≥ 18, an Anthropic API key

```bash
git clone https://github.com/bukmans/aria-analytics-agent.git
cd aria-analytics-agent
npm install
cp .env.example .env          # then add your ANTHROPIC_API_KEY
node server.js
```

Open **http://localhost:3000** in your browser.

---

## Project structure

```
aria-analytics-agent/
  public/
    index.html        ← chat-first triage interface
    dashboard.html    ← ticket history & analytics
  server.js           ← Express backend (5 API endpoints + static serving)
  package.json
  vercel.json         ← zero-config Vercel deployment
  .env.example
  ARIA_PowerAutomate_Guide.md
  ARIA_Documentationv2.html
```

---

## API endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET`  | `/health` | Server status, model, ticket count |
| `POST` | `/api/triage` | Initial triage + chat opener |
| `POST` | `/api/chat` | Conversational refinement turn |
| `POST` | `/api/finalize` | Generate & log final structured ticket |
| `POST` | `/api/triage/email` | Power Automate webhook (full ticket, no chat) |
| `GET`  | `/api/tickets` | Ticket history for dashboard |

---

## Deploying to Vercel

```bash
npm i -g vercel
vercel --prod
```

Add `ANTHROPIC_API_KEY` as an environment variable in the Vercel dashboard. No other configuration needed.

> **Note:** On Vercel, ticket history is in-memory and resets on redeploy. Swap `readTickets`/`writeTicket` in `server.js` for a database (e.g. Vercel Postgres, MongoDB Atlas) when ready for production.

---

## Tech stack

- **Frontend:** Vanilla HTML/CSS/JS — no build step, no framework
- **Backend:** Node.js + Express + express-rate-limit
- **AI:** Anthropic Claude (`claude-sonnet-4-6`) via secure backend proxy
- **Automation:** Microsoft Power Automate (email trigger → ARIA webhook)
- **Deployment:** Vercel (serverless) or any Node.js host

---

## Organisation context

**Catholic Relief Services (CRS)** is one of the world's largest humanitarian organisations, operating across 110+ countries. The Enterprise Analytics team (6 specialists) supports global program and operations staff with data engineering, reporting, dashboards, and strategic insight — managing high-volume demand with no formal intake process prior to ARIA.

---

*Built by Abraham Olagundoye — Advanced Analytics Manager, CRS Global Enterprise Systems*
