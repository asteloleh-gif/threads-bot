# Threads Auto-Reply Bot — Setup

## 1. Airtable base structure

Create one Airtable base with three tables:

### `KnowledgeBase`
Used as lightweight RAG context fed to GPT before it writes a reply.
| Field | Type |
|---|---|
| Question | Single line text |
| Answer | Long text |
| Tags | Multiple select (optional) |

### `IgnoreList`
Usernames the bot should never auto-reply to (spam, trolls, competitors).
| Field | Type |
|---|---|
| Username | Single line text |
| Reason | Single line text (optional) |

### `Log`
Every comment + reply gets logged here — your analytics/audit trail.
| Field | Type |
|---|---|
| Comment ID | Single line text |
| Author | Single line text |
| Comment Text | Long text |
| Reply Text | Long text |
| Reply ID | Single line text |
| Media ID | Single line text |
| Timestamp | Date (with time) |

Get your `AIRTABLE_BASE_ID` from the base's API docs page (Help > API documentation),
and generate a Personal Access Token at airtable.com/create/tokens with
`data.records:read` + `data.records:write` scopes for this base.

## 2. Threads API setup

1. Create an app at developers.facebook.com → add the "Threads API" product.
2. Convert your Threads account to a Professional (Business/Creator) account.
3. Request these permissions in App Review: `threads_basic`, `threads_content_publish`,
   `threads_manage_replies`, `threads_read_replies`.
4. Generate a long-lived access token via the OAuth flow.
5. Subscribe your app to the `comments`/`replies` webhook field, pointing to
   `https://your-deployed-url.com/webhook`.
6. Set `THREADS_VERIFY_TOKEN` in your `.env` to any string — use the same
   string when configuring the webhook in the Meta dashboard.

## 3. Deploy

```bash
npm install
cp .env.example .env   # fill in real values
npm start
```

Deploy to Railway/Render (free tier) by connecting this repo — set the same
env vars in the platform's dashboard.

## 4. What to customize first

- `systemPrompt` in `generateReply()` — tone of voice, length, language rules.
- Add rate limiting / a delay queue if comment volume spikes, to stay under
  Threads API rate limits.
- Consider filtering by keyword (spam/abuse) before calling GPT at all, to
  save on tokens.
