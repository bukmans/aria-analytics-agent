# ARIA Power Automate Flow — Configuration Guide

## Flow Name: ARIA — Analytics Request Automation Pipeline

## Overview
This flow monitors a shared mailbox and forwards incoming emails to the **ARIA backend** (`/api/triage/email`). ARIA handles all AI processing and returns a structured triage result. Power Automate then distributes the result to Teams, the assigned analyst, SharePoint, and the requester.

> **v2 change (simplified):** The Anthropic API call and system prompt no longer live in Power Automate. Step 6 now calls your ARIA backend instead of Anthropic directly. This means your API key only exists in one place (your backend `.env` file), and you can update ARIA's triage logic without touching the flow.

---

## Prerequisites
- Shared mailbox: `analytics-requests@crs.org`
- ARIA backend deployed and publicly reachable (e.g. `https://your-aria.vercel.app`) — or use ngrok for local testing
- Teams channel: Enterprise Analytics > `#analytics-requests`
- SharePoint Excel file with a `RequestLog` table

---

## STEP 1: TRIGGER — When a new email arrives (V3)
- Connector: **Office 365 Outlook**
- Mailbox: `analytics-requests@crs.org`
- Folder: Inbox
- Include Attachments: No

---

## STEP 2: INITIALIZE VARIABLES
Add 3 "Initialize variable" actions:

| Variable Name        | Type   | Initial Value |
|----------------------|--------|---------------|
| var_requester_email  | String | (empty)       |
| var_ticket_id        | String | (empty)       |
| var_aria_response    | Object | (empty)       |

---

## STEP 3: SET var_requester_email
- Action: **Set variable**
- Name: `var_requester_email`
- Value: `triggerOutputs()?['body/from']`

---

## STEP 4: HTTP ACTION — Call ARIA Backend

> This replaces the direct Anthropic API call from v1. Your API key never appears in Power Automate.

- Action: **HTTP**
- Method: `POST`
- URI: `https://your-aria.vercel.app/api/triage/email`
  *(Replace with your actual ARIA backend URL. For local testing use ngrok.)*
- Headers:
  - `Content-Type`: `application/json`
- Body:
```json
{
  "from":    "@{triggerOutputs()?['body/from']}",
  "subject": "@{triggerOutputs()?['body/subject']}",
  "body":    "@{triggerOutputs()?['body/body']}"
}
```

---

## STEP 5: PARSE JSON — Extract ARIA response
- Action: **Parse JSON**
- Content: `body('HTTP')`
- Schema (paste this):
```json
{
  "type": "object",
  "properties": {
    "success":   { "type": "boolean" },
    "ticketId":  { "type": "string" },
    "timestamp": { "type": "string" },
    "triage": {
      "type": "object",
      "properties": {
        "category":        { "type": "string" },
        "complexity":      { "type": "string" },
        "routed_to":       { "type": "string" },
        "effort_estimate": { "type": "string" },
        "rationale":       { "type": "string" },
        "scoping_brief":   { "type": "string" },
        "clarifying_questions": {
          "type": "array",
          "items": { "type": "string" }
        },
        "ticket": {
          "type": "object",
          "properties": {
            "title":             { "type": "string" },
            "objective":         { "type": "string" },
            "data_sources":      { "type": "string" },
            "expected_output":   { "type": "string" },
            "success_criteria":  { "type": "string" },
            "dependencies":      { "type": "string" },
            "estimated_effort":  { "type": "string" }
          }
        }
      }
    }
  }
}
```

---

## STEP 6: SET var_ticket_id
- Action: **Set variable**
- Name: `var_ticket_id`
- Value: `body('Parse_JSON')?['ticketId']`

---

## STEP 7: POST TO MICROSOFT TEAMS
- Action: **Microsoft Teams — Post a message in a chat or channel**
- Post as: Flow bot
- Post in: Channel
- Team: Enterprise Analytics
- Channel: `#analytics-requests`
- Message:
```
<b>🤖 ARIA Triage Complete</b> — @{variables('var_ticket_id')}<br><br>
<b>From:</b> @{variables('var_requester_email')}<br>
<b>Category:</b> @{body('Parse_JSON')?['triage']?['category']}<br>
<b>Complexity:</b> @{body('Parse_JSON')?['triage']?['complexity']}<br>
<b>Routed To:</b> @{body('Parse_JSON')?['triage']?['routed_to']}<br>
<b>Effort:</b> @{body('Parse_JSON')?['triage']?['effort_estimate']}<br><br>
<b>Scoping Brief:</b><br>@{body('Parse_JSON')?['triage']?['scoping_brief']}
```

---

## STEP 8: SEND EMAIL TO ASSIGNED ANALYST
- Action: **Office 365 Outlook — Send an email (V2)**
- To: *(use a Switch block to map `routed_to` → analyst email)*
  - Data Engineer → `engineer@crs.org`
  - Data Analyst → `analyst@crs.org`
  - Data Scientist → `datascientist@crs.org`
  - Analytics Lead → `analytics.lead@crs.org`
- Subject: `[ARIA] New Request Assigned — @{variables('var_ticket_id')}`
- Body:
```
TICKET:    @{variables('var_ticket_id')}
CATEGORY:  @{body('Parse_JSON')?['triage']?['category']}
COMPLEXITY:@{body('Parse_JSON')?['triage']?['complexity']}
EFFORT:    @{body('Parse_JSON')?['triage']?['effort_estimate']}

SCOPING BRIEF:
@{body('Parse_JSON')?['triage']?['scoping_brief']}

TICKET TITLE:
@{body('Parse_JSON')?['triage']?['ticket']?['title']}

OBJECTIVE:
@{body('Parse_JSON')?['triage']?['ticket']?['objective']}

This request was automatically triaged by ARIA.
CRS Enterprise Analytics Team
```

---

## STEP 9: LOG TO SHAREPOINT
- Action: **SharePoint — Add row to Excel table** (or "Create item" for SharePoint List)
- Site: `[Your SharePoint site URL]`
- Library: Shared Documents
- File: `ARIA_Request_Log.xlsx`
- Table: `RequestLog`
- Columns:

| Column          | Value                                                  |
|-----------------|--------------------------------------------------------|
| TicketID        | `@{variables('var_ticket_id')}`                        |
| Timestamp       | `@{body('Parse_JSON')?['timestamp']}`                  |
| RequesterEmail  | `@{variables('var_requester_email')}`                  |
| Category        | `@{body('Parse_JSON')?['triage']?['category']}`        |
| Complexity      | `@{body('Parse_JSON')?['triage']?['complexity']}`      |
| RoutedTo        | `@{body('Parse_JSON')?['triage']?['routed_to']}`       |
| EffortEstimate  | `@{body('Parse_JSON')?['triage']?['effort_estimate']}` |
| ScopingBrief    | `@{body('Parse_JSON')?['triage']?['scoping_brief']}`   |
| Status          | `Open`                                                 |

---

## STEP 10: SEND CONFIRMATION TO REQUESTER
- Action: **Office 365 Outlook — Send an email (V2)**
- To: `@{variables('var_requester_email')}`
- Subject: `✅ Your analytics request has been received — @{variables('var_ticket_id')}`
- Body:
```
Dear Colleague,

Thank you for submitting your analytics request. ARIA has automatically
processed and triaged your submission.

Ticket ID:    @{variables('var_ticket_id')}
Category:     @{body('Parse_JSON')?['triage']?['category']}
Assigned To:  @{body('Parse_JSON')?['triage']?['routed_to']}
Est. Effort:  @{body('Parse_JSON')?['triage']?['effort_estimate']}

Our team will be in touch within 24–48 hours.

CRS Enterprise Analytics Team
```

---

## Testing locally with ngrok
If your ARIA backend is running locally (`node server.js`), expose it temporarily with:
```bash
npx ngrok http 3000
```
Use the generated `https://xxxx.ngrok.io` URL as the HTTP action URI in Step 4.
Replace with your permanent Vercel URL once deployed.

---

## Estimated build time: 1–2 hours
*(Reduced from 2–3 hours — the HTTP body is now a simple 3-field JSON instead of a full AI prompt.)*
