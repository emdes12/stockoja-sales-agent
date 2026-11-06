# StockỌja AI Sales Agent

A **local-only** app that finds Nigerian merchants who could use StockỌja, qualifies them, helps you reach
out, reads replies and tracks demos. It runs on your Windows laptop **only while it is open**: no cloud server,
no background service, no Docker. (You can choose to have it open when you sign in to Windows.)

> It is a separate project from the StockỌja app and API, and does not change them.

## Status

| Stage | What | State |
|---|---|---|
| 1 | Local dashboard, PostgreSQL database, persistent task queue, Start/Pause/Resume/Stop, safe restart recovery, redacted logs, Windows scripts | **Done** |
| 2 | Discovery (OpenStreetMap, business websites, CSV, manual entry), de-duplication, qualification with facts vs assumptions | **Done** |
| 3 | Knowledge base you approve, editable templates, approval queue, do-not-contact list, WhatsApp sent by you, tracked registration links, demo booking link | **Done** |
| 4 | Email through Resend (dry-run by default), duplicate-proof sending, sending hours and limits, follow-up drafts, bounce and complaint checks | **Done** (tested against a fake Resend; no real email sent yet) |
| 5 | Reply reading (IMAP, read-only), reply labels, opt-out handling, answers from the knowledge base, booked-demo tracking | **Done** (tested against a fake mailbox; not yet against your real one) |
| 6 | Document and website knowledge (chunked, searchable), optional AI drafting with a spending cap, Controlled Autonomous Mode, message variety, optional start with Windows | **Done** (AI tested against a fake model; no real Gemini call made yet) |
| 7.1 | Instagram, Facebook, TikTok and Telegram messages you send yourself; interest form (Google Forms) import; referrals; Settings in tabs with Save/Cancel per section | **Done** (form import tested against a fake sheet; not yet against your real form) |
| 7.3 | Web search (Tavily and/or Brave, chosen in Settings) and WhatsApp group-export import (assist only) | **Built and tested against fake providers.** Not yet run with real keys: add one when you're ready |
| 7.2 | Meta app: Instagram profile lookup, Instagram/Facebook inbox with drafted replies, optional API replies inside 24 hours | **Built and tested against a fake Meta API.** Not yet run against your real Page: needs the app set up (`docs/META_SETUP.md`) |
| 7.4 | One inbox per channel (email, Instagram, Facebook, WhatsApp, Telegram, TikTok, LinkedIn) with every message, replying from the app, per-channel access and answer settings, Telegram bot, LinkedIn drafts | **Built and tested against a fake mailbox and a fake Telegram.** Not yet run against your real mailbox folders or a real bot |
| 7.5 | AI writes outreach and answers for each person by default (templates and knowledge-base answers as fallback); a busy Gemini is retried, then a backup model is used | **Built and tested against a fake model.** Not yet run against Gemini after the change |
| Open | WhatsApp Cloud API test mode, directories | Not decided |

**Nothing is sent without your approval** unless you switch on Controlled Autonomous Mode, which approves only a narrow set of messages (see [Modes](#modes)). The agent drafts. You approve each draft. Approved emails go out through Resend only after you switch email to **live**; until then they are dry runs. You send WhatsApp messages yourself from a click-to-chat link. Replies are read from your mailbox once you connect it. Registrations can't be verified yet (that needs an authorised StockỌja integration), so they show as "Not verifiable yet" rather than zero.

## What runs where, and what it costs

| Feature | Runs on | Cost |
|---|---|---|
| Dashboard, database, scheduler, scoring | Your laptop | Free |
| OpenStreetMap search | Public Overpass API | Free (fair use; the agent spaces requests out) |
| Website contact check | The merchant's own website | Free (follows robots.txt) |
| CSV import, manual entry | Your laptop | Free |
| Email sending (stage 4) | Resend | Free tier: 3,000 emails/month, 100/day |
| Reading replies (stage 5) | Your own mailbox over IMAP | Free |
| Knowledge search (documents, website) | Your laptop (Postgres full-text, plus a small local embedding model) | Free. The model (about 35 MB) downloads once |
| Reading your website | Your own site | Free (follows robots.txt) |
| AI writing (optional) | Gemini API | Free tier or paid per use, with a daily call limit and monthly cap you set. Used whenever a key is in `.env` |
| Telegram bot (optional) | Telegram Bot API | Free |
| Web search (optional) | Tavily and/or Brave Search API | Tavily free plan 1,000 credits a month; Brave about $5 per 1,000 with a $5 monthly credit (card needed). Off by default; capped by your monthly limits |
| Instagram lookup, Instagram/Facebook inbox (optional) | Meta Graph API, through your own Meta app | Free. Off by default |

- **Claude Code ≠ model API.** Your Claude Code subscription covers building this app. It does not give the app an API key.
- **With a Gemini key, messages are written by AI for each person.** Without one (or when Gemini is unavailable or a limit is reached) the agent still drafts: from your templates filled with the lead's verified details, and answers from the knowledge base answers you approved. Each such draft says why the template was used.
- **Online tasks need the laptop on, connected, and the app running.** Nothing runs while it is closed. Work that was due while it was closed is reviewed when you next start it.
- Every external call is recorded in the `usage_events` table and shown under **Overview → Usage this month**.

## Requirements

- Windows 10/11
- Node.js 22 or newer
- PostgreSQL 15+ running locally (this laptop has the `postgresql-x64-15` service)

## First-time setup

1. Open a terminal in this folder and install dependencies:
   ```bat
   npm install
   ```
2. Copy `.env.example` to `.env`. Choose a password for the agent's own database role and put it in both `DATABASE_URL` and `DATABASE_URL_TEST`.
3. Put a Postgres superuser connection in `ADMIN_DATABASE_URL` for this one step, e.g. `postgres://postgres:<password>@localhost:5432/postgres`. Then run:
   ```bat
   npm run db:setup
   ```
   This creates the `sales_agent` login role (not a superuser; it can't create roles or databases), the `stockoja_sales_agent` database and the `stockoja_sales_agent_test` database, then applies the migrations. It's safe to run again.
4. Clear `ADMIN_DATABASE_URL` in `.env` again. Nothing else needs it.
5. Optional: set `CONTACT_EMAIL` so OpenStreetMap and websites can identify the agent's requests.

## Starting and stopping

| Action | How |
|---|---|
| Start the app | Double-click **`start-agent.bat`**. It builds the dashboard and opens http://127.0.0.1:6400 |
| Start (developer mode, live reload) | `npm run dev`, then open http://127.0.0.1:6400 |
| Start the agent's work | Press **Start** in the dashboard. The app always opens with the agent stopped unless you turn on *Start the agent automatically* in Settings |
| Pause / Resume | **Pause** lets running tasks finish and takes no new ones. **Resume** continues |
| Stop the agent | **Stop** interrupts running tasks. Tasks that are safe to repeat go back to the queue; others wait for your review |
| Quit the app | **Quit app** in the dashboard, Ctrl+C in its window, closing its window, or `stop-agent.bat` |

**Tasks run side by side.** Each kind of task (map search, inbox check, Telegram check, email send…) has its own lane, and the lanes run at the same time, so a long discovery run never delays a reply check or a send. Within one kind, tasks go one after another, because they share an outside service with spacing rules (OpenStreetMap's fair use, the gap between emails). A timer check that is already waiting isn't queued again; on Start, repeated ones left waiting collapse into one. AI calls take turns, so your daily limit and monthly cap always hold.

Shutting down the laptop stops the app too. On the next start:

- Tasks left "running" are **queued again** if they're safe to repeat (searches, website checks). Anything else is **held for review**.
- Time-sensitive tasks that are later than the *overdue grace* (Settings) are **held for review**, not run late. This matters for follow-ups once they exist.
- The agent stays **stopped** until you press Start.
- Only one copy can run at a time. A Postgres advisory lock refuses a second window, so two copies can never work the queue twice.

**Start with Windows** (Settings → System → Start-up, off by default) puts a small launcher in your Windows Startup folder that runs `start-agent.bat --background` when you sign in: the app opens without a browser window, and the agent itself still waits for Start unless you turned on *Start the agent automatically*. Turning the option off removes only that launcher.

## Using it

1. **Discovery**: pick categories and states, then queue the searches and press Start. Each category-and-state search runs at most once a day unless you tick *Run again*. Leads with a website but no email get a website check automatically (you can turn this off in Settings).
2. **Add leads yourself**: for businesses you find on Instagram, Jumia, Google Maps and similar sites, use the form or import a CSV. The columns are listed on the page; only `business_name` and `category` are required.
3. **Leads**: search and filter by status, category, state, contact info and score. Open a lead to see:
   - **Verified facts**: what a source states, each linked to its source.
   - **Assumptions**: inferences, never presented as fact.
   - **Why this score**: each point, marked *fact* or *assumption*.
   - **Where StockỌja could help**: fit for inventory, sales tracking, expenses, online store and ordering.
4. Set a lead's status yourself (qualified, not a fit, archived, **do not contact**). Automatic re-scoring never overrides a status you set; *Let scoring decide* hands it back.

### How leads are de-duplicated

A new record is merged into an existing lead when it matches on any of these, in order:

1. The same source record (re-running a search never duplicates).
2. The same phone number (normalised to `234…`).
3. The same email.
4. The same website domain (social links don't count).
5. The same normalised name in the same state. Branches count as one prospect, and the location count goes into the score.

When records merge, only blank fields are filled; existing values are never overwritten.

### How qualification works

The score is rule-based and readable; no AI is involved.

- **Points from facts:** being in a target category (+20), phone (+10), email (+15), own website (+10), social profile (+5), address (+5), opening hours (+5), 2–10 locations (+15).
- **Points from assumptions:** suits an online store (+10), electronics (+8), supermarket (+5).
- **Penalty and cap:** a likely big chain (a recognised brand or more than 10 locations) gets −30. A lead with no contact channel is capped at 20.
- **Qualified** means score ≥ threshold (default 50) **and** at least one contact channel.

### Data kept

Only business details are kept: name, category, location, business contact details, public profile links and the source. Personal tags such as `contact:person` are ignored. Logs mask emails and phone numbers, remove keys, passwords and tokens, and are deleted after 30 days.

## Outreach (stage 3)

**Before the first draft**, open **Settings → Sender and links** and set:

- **Your name and role:** these sign every message. Drafting is blocked until your name is set.
- **Referral code:** optional. Use an affiliate code from StockỌja's admin so registrations from outreach are attributed. Every sign-up link also carries `utm_source=sales_agent`, `utm_medium`, `utm_campaign` and `utm_content=lead_<id>`.
- **Demo booking link:** optional, from Cal.com or Calendly. Without one, messages ask the merchant to reply to arrange a time. The agent never proposes times itself.

**Knowledge base.** Ten answers are pre-filled from StockỌja's launch kit, all as **drafts**. The agent uses only entries you approve, word for word. Editing an approved entry sends it back to draft. Use *Try a question* to see which answer would be picked; if nothing approved matches, the question goes to you. Pricing is deliberately vague ("free to start; I'll confirm prices"), following the launch kit's rule to confirm prices before quoting.

**Templates.** There's one email introduction per category, a general one, two email follow-ups and a WhatsApp introduction. All are editable, in British/Nigerian English with no exclamation marks and no invented figures. Placeholders that are empty or unknown block the draft rather than leaving a gap. Every introduction template needs a `STOP` opt-out line; follow-ups don't (add one if you want it). *Preview with a real lead* shows the filled-in text.

**Drafting.**

- **Automatic:** while the agent runs, it drafts introductions for the highest-scoring qualified leads every 30 minutes, up to the daily limit (default 20). Turn this off in Settings.
- **By hand:** *Draft for top qualified leads* in the approval queue, or *Draft email* / *Draft WhatsApp* on a lead.
- **Channel choice:** email when the lead has an address, otherwise WhatsApp when it has a mobile number.
- **No duplicates:** there can only be one live message per lead, channel and step. Rejected drafts are never re-drafted automatically.

**Approval queue.** Edit the text, then **Approve** or **Reject**. Approval re-checks everything first: the mode, the lead's status, the do-not-contact list, no unfilled placeholders, an opt-out line on a first message (intro), and a subject for email. The agent's original draft is kept alongside your edits.

**Sending.**

- **WhatsApp:** after approval, press *Open in WhatsApp*. It opens with the text filled in, and you press send. Then press *I've sent it*, and the lead becomes *Contacted*.
- **Email:** see [Email sending (stage 4)](#email-sending-stage-4).

**Do not contact.**

- **Marking a lead:** its email and phone go on the do-not-contact list, and its open drafts and follow-up tasks are cancelled.
- **Checks:** the list is checked on every draft, approval and send, across all channels. Someone who opts out by email is not contacted on WhatsApp either.
- **What you can block:** single emails, phone numbers, or a whole business domain. Shared domains like gmail.com are refused.
- **Lifting:** an entry can be lifted with a reason, and stays as history.

## Email sending (stage 4)

Email goes out through **Resend** from `OUTREACH_FROM_ADDRESS` (default `hello@sales.stockoja.com`). Using a subdomain keeps cold outreach from affecting the reputation of mail sent from `stockoja.com` itself.

**Dry run is the default.** In dry run, an approved email is rendered and recorded exactly as it would be sent, with status *Dry run*, but nothing leaves the laptop. It shows under **Approval → Sent and dry runs**.

**Before switching to live:**

1. **Verify the domain.** Add `sales.stockoja.com` in Resend (Domains) and create the DNS records it lists: SPF, DKIM, and ideally DMARC. Then press **Settings → Email sending → Check domain in Resend**.
2. **Set a reply mailbox.** Put an inbox you actually read in `.env` as `OUTREACH_REPLY_TO`. The sending subdomain can't receive mail, so replies and `STOP` requests go there. Live sending is refused without it.
3. **Set `RESEND_API_KEY`** in `.env`. A *sending-only* key is the least privilege. With one, *Check domain* and delivery checks report "unknown" because that key can't read them. A *full access* key enables both.
4. **Set your name** in Settings → Sender and links.
5. **Restart the app** after editing `.env`. Values are read only at start-up.
6. Optionally press **Send a test email to me**. It sends one real email to your reply address.
7. Press **Switch to live sending**. The app checks the configuration and the domain again first.

Messages approved during dry run aren't sent retroactively. Use **Send for real** on a dry-run message to queue it once live.

**Limits.**

- **Sending hours:** sending happens only inside the hours you set, in Lagos time (default 09:00–17:00, weekdays). Emails approved outside those hours wait for the next opening.
- **Daily limit:** at most the *daily limit* per Lagos day (default 20, maximum 100, which is Resend's free daily cap). Start low on a new domain and raise it slowly.
- **Spacing:** a gap between emails (default 90 seconds), so sending looks like a person rather than a blast.

**No duplicates, even across crashes.**

- Each message is claimed before it's sent, so only one copy can go out.
- Each send carries a Resend idempotency key (`stockoja-sales-msg-<id>`). If the app dies or the network fails mid-send, the retry is recognised by Resend and not sent twice.
- A send that was interrupted is held for your review at the next start, not resent.
- A send still uncertain after 23 hours (beyond Resend's idempotency window) is marked failed rather than retried.

**Follow-ups.** After an introduction is actually sent (not a dry run), follow-up 1 is scheduled after 4 days, and follow-up 2 after 7 more days (both adjustable). When one is due, it becomes a **draft for your approval**, not an automatic send. It's skipped when the lead has replied, or when its status changed. Any status you set by hand cancels pending follow-ups.

**Bounces and complaints.**

- **How it checks:** while the agent runs in live mode, it asks Resend every 30 minutes about emails sent in the last 7 days. Webhooks can't reach a laptop, so it polls instead.
- **Bounces:** a bounced address goes on the do-not-contact list.
- **Complaints:** a spam complaint marks the whole lead *Do not contact*.
- **Unsubscribe header:** every email carries a `List-Unsubscribe` header pointing to your reply mailbox.

**Cost.** Resend's free tier covers 3,000 emails a month and 100 a day. Each send is recorded under **Overview → Usage this month**.

## Replies (stage 5)

The agent reads the mailbox that `OUTREACH_REPLY_TO` delivers to (for example `hello@stockoja.com`), over IMAP.

**It's off until you turn it on.** To connect it:

1. Create an **app password** for the mailbox: Gmail via Google Account → Security → App passwords; Zoho and Microsoft 365 have the same feature. Never use your main password. Make sure IMAP is enabled for the mailbox.
2. Add `IMAP_HOST`, `IMAP_USER` and `IMAP_PASSWORD` to `.env` (`IMAP_PORT` defaults to 993, `IMAP_MAILBOX` to `INBOX`), then restart the app.
3. Press **Settings → Inbox & answers → Email mailbox → Test connection**. It only opens the folder and counts messages.
4. Press **Start reading the mailbox**. While the agent runs, it checks every 5 minutes (adjustable). **Inbox → Check mailbox now** checks immediately.

**What it reads, and what it keeps.**

- **Read-only:** the folder is opened read-only, so nothing is marked read, moved or deleted.
- **Which folders:** the ones you list under Settings → Inbox & answers (INBOX, Sales…); none listed means `IMAP_MAILBOX`.
- **Every message, or only replies:** with **Show every message** on (the default), every message in those folders appears in the Inbox, except no-reply senders and newsletters, which are never downloaded. With it off, the agent looks at the sender and subject first and downloads a message only when it's from a lead's address (or a colleague at a business we emailed), answers one of our subjects, or is a Cal.com/Calendly booking notice.
- **Only the new text is kept:** quoted history and signatures are removed, so our own "reply STOP" inside a quote can't be mistaken for an opt-out. Text is capped at 5,000 characters.
- **First check:** the first check looks back 14 days (adjustable). After that, it reads only new mail.
- **No duplicates:** each email is stored once (by its Message-ID). A crash or a re-read can't duplicate one or act on it twice.

**Labels and what they do.** The labels are simple rules, so they're free and predictable, and each shows the phrase that triggered it. You can change any label in the **Inbox**, and the new label's effects apply.

| Label | Examples | Effect |
|---|---|---|
| Opted out (STOP) | "STOP", "remove me", "unsubscribe", the mail app's unsubscribe button | Do-not-contact list at once; open drafts, sends and follow-ups cancelled |
| Not interested | "not interested", "we already use a system" | Lead → Declined; open messages cancelled |
| Wants a demo | "show me a demo", "call me" | Lead → Interested; answer drafted with your booking link (or asking for a time that suits them) |
| Interested | "I'm interested", "tell me more", "I dey interested" | Lead → Interested; answer drafted with the sign-up link and any matching answers |
| Question | "How much is it?", "Does it work offline?" | Lead → Replied; answer drafted (by AI from your knowledge, or from a matching approved knowledge-base entry), otherwise it waits for you |
| Auto-reply | out-of-office, auto-reply headers | Nothing changes; follow-ups continue |
| Unclear | anything else | Lead → Replied; waits for you |

Any real reply (not an auto-reply) stops the follow-up sequence.

**Answers.** Per channel, under **Settings → Inbox & answers → Answers**: *Off* (the agent drafts nothing), *Draft for my approval* (the default), or *Auto-send* (email, Instagram, Facebook and Telegram only; see [Modes](#modes)). With a Gemini key, AI writes the answer from your knowledge; without one, or when Gemini is unavailable, approved knowledge-base text is used word for word. Drafts go to the **approval queue**, showing what the person wrote. An email answer goes to the address that wrote, threaded under their message. The agent never proposes a demo time.

## The Inbox

One tab per channel (**All**, Email, Instagram, Facebook, WhatsApp, Telegram, TikTok, LinkedIn), each with **Needs you**, **All messages** and **Not a lead yet**, and a search.

- **Like a mail or chat app:** each row is a conversation: name, the start of the latest message, and the time. Click it to read the whole thread. Unread conversations are bold with a count; opening one marks it read, and **Mark unread** puts it back. The **Unread** filter shows only those.
- **Reply from the app:** **Reply** opens a box under the conversation (once answered, the same button writes a **New message** to them). **Send** sends it straight away where the agent can (email; Telegram through your bot; Instagram and Facebook inside Meta's 24 hours when Meta replies are live); otherwise the message is copied and the chat opens for you to paste and send. **Save as draft** puts it in the approval queue. Messages you write go out at once, outside sending hours (the daily email limit and spacing still apply).
- **New message:** write to anyone on any channel: pick a lead by name, or type an email address, number or username. Telegram goes through your bot only to people who have written to it; anyone else gets the Telegram chat opened for you. Email only really goes out when email sending is live.
- **Unsubscribe line:** only first outreach messages (intros) always carry "reply STOP". Follow-ups, answers and messages you write carry it only when you tick **Include unsubscribe line**.
- **Conversation** shows the whole thread with that person on that channel.
- **People who aren't leads** (someone who wrote first, a customer, a supplier): link them to a lead, **Add as a new lead**, or **Ignore this person** (their messages leave *Needs you* and the agent drafts nothing for them; reversible).
- **Add a message you received:** for chats the agent can't read (TikTok, LinkedIn, WhatsApp, or any other), paste the message and who sent it. It is matched to a lead by number, email or profile, labelled and answered like the rest; you send the answer yourself. **Log a reply** on a lead does the same for one lead.
- **What the agent may read** is set per channel under **Settings → Inbox & answers → Inbox access** (all on by default). Off: nothing is fetched, labelled or drafted there.

**Telegram.** People who message StockỌja's bot appear under Inbox → Telegram, and approved answers go back through the bot (a bot can only answer people who wrote to it first; cold Telegram messages to a lead are still sent by you). To set it up: in Telegram, message **@BotFather**, send `/newbot`, put the token in `.env` as `TELEGRAM_BOT_TOKEN`, restart, and press **Test the bot** in Settings. Free. Telegram keeps unread updates for 24 hours, so run the agent at least once a day. Your personal account is never read.

**Demos.**

- **By hand:** **Mark demo booked** on a lead records the time you agreed (from your calendar).
- **From booking notices:** if your Cal.com or Calendly booking notices reach the reply mailbox, a notice naming a lead's email marks that lead *Demo booked*. The notice's subject, which states the time, is kept as the note. A cancellation notice undoes it.
- **Either way:** follow-ups stop.

## Modes

- **Research**: discover and qualify only.
- **Approval** (default): drafts wait for you to edit, approve or reject. Nothing is sent without approval.
- **Controlled Autonomous**: the agent approves some of its own drafts, within limits you set (Settings → AI & autonomy):
  - outreach: only **email**, only drafts it wrote from a **template** (never AI-written, never ones you edited), introductions and follow-ups each by their own switch;
  - answers to messages: only on channels you set to **Auto-send** (email, Instagram, Facebook, Telegram), only answers built from your knowledge with no warnings (Instagram and Facebook also need Meta's 24-hour window and Meta replies set to live);
  - only for leads at or above the minimum score, and at most the daily number you set (Lagos day);
  - everything else still waits for you, and sending still follows email's live/dry-run switch, sending hours and limits.

  You can switch to it only once replies are being read (so STOP and questions are seen), and your name and reply-to address are set. Messages it approved show *approved by the agent*. Switching back to Approval returns anything it approved but hasn't sent to your queue.

## Knowledge (documents and your website)

The agent answers from two kinds of knowledge:

- **Approved answers**: the question-and-answer pairs from stage 3. Replies can use these word-for-word.
- **Documents and website pages**: upload PDF, Word (.docx), text, Markdown, HTML or CSV files (up to 20 MB), paste text, or list your website links under **Settings → Replies & knowledge**. The agent reads each site (same domain, under the link's path, robots.txt respected, up to the page limit) and re-reads it every few days if you set that. Pages built entirely with JavaScript come back almost empty and are skipped with a note.

Everything is split into **chunks** and stored in Postgres:

- **By headings** (default): keeps each heading with its text, packs paragraphs up to the chunk size, splits long paragraphs at sentences, and repeats the last few words of a section in its next chunk (overlap) so an answer isn't cut in half.
- **Fixed size**: a plain sliding window of N words with an overlap.
- You set the chunk size (50–400 words) and overlap (up to half the size) as defaults, or per document. Changing them re-chunks from the saved text.

Search uses **words** (Postgres full-text) and, once enabled, **meaning** (vectors from a local model, `bge-small-en-v1.5`, run on your laptop, nothing sent out), merged by rank. **Knowledge → Search** shows what the agent would find for a question.

To turn on meaning search (pgvector), once, since the extension needs an admin:

1. Put the postgres admin connection in `ADMIN_DATABASE_URL` in `.env`.
2. Run `npm run db:setup`. It enables the `vector` extension and changes nothing else that exists.
3. Clear `ADMIN_DATABASE_URL` again and restart. Existing chunks are embedded in the background.

Without it, search works on words only.

## AI writing (Gemini)

With a key, AI writes every outreach message (introductions and follow-ups, on every channel) and every answer to a message, for the person it goes to. Both can be switched off under **Settings → AI & autonomy**.

- **Setup:** create a key at Google AI Studio, put it in `GEMINI_API_KEY` in `.env`, and restart.
- **When Gemini is busy** ("high demand", HTTP 503): the agent waits and tries again twice (2 and 6 seconds), then tries a backup model on the same key. Backups are picked automatically: the newest stable Flash and Flash-Lite models your key can use (set `GEMINI_FALLBACK_MODELS` in `.env` to choose them yourself). A model that keeps failing is rested for 10 minutes. If every model fails, or a limit is reached, the draft is made from your template (outreach) or your knowledge-base answers (messages), and says why; during an automatic drafting run, AI is then paused for the rest of that run.
- **What you see:** the models in use are listed under Settings → AI & autonomy. AI drafts are marked *AI-written*.
- **Its instructions are yours to edit:** Settings → AI & autonomy → **Instructions for the AI** (Reset to default brings back the shipped text). The agent adds your name and title, the task, your knowledge, the lead and the conversation. The checks on what comes back (times, links, figures not in your knowledge) apply whatever the instructions say.
- **It reads the conversation:** before answering, the AI reads the last 10 messages with that person on that channel, both sides (adjustable; 0 means only their latest message). Drafts and messages that never went are left out.
- **The opener fits:** an answer starts with "thanks for getting back to me" only when we wrote to them first; when they wrote first it says "thanks for your message", and in a chat already going it skips the hello.
- **Cost:** Gemini has a free tier with rate limits. On the free tier Google may use what you send to improve its products, so don't upload anything confidential to your knowledge if you use it. The paid tier is per token; set the prices in Settings to today's rates. Every call is checked against your **monthly cap** and **daily call limit** before it is made (using a worst-case estimate) and its real cost is recorded under Usage.
- **What it sees:** the person's message (or, for outreach, the business's name, category and the facts found about it), the knowledge that matched, and for a follow-up what you already sent. Never their email, phone or address.
- **What it may say:** only what the knowledge says. It may not invent prices, features or meeting times, and it never writes links: the agent adds the sign-up link, booking line, your name and (on an introduction) the opt-out itself. Every AI draft lists the knowledge it used and is checked: a time, a link or a leftover placeholder blocks approval until you edit it; a figure not found in the knowledge is flagged. AI-written outreach is never approved by Controlled Autonomous Mode; an AI answer to a message can be sent by it only on a channel set to auto-send, only with no warnings, and only when it drew on your knowledge.

## Message variety

So two merchants (or two emails in the same hour) don't get the same words:

- **Several templates per step.** With more than one active template for a step, the agent uses the lead's category first, then the one used least in the last 24 hours. **Templates → Add starter variants** adds ready-written ones, switched off, for you to read and switch on.
- **Phrase alternatives:** `{Hello|Good day|Hi}` in a template picks one option per draft.
- **`{{personal_line}}`:** one sentence about the shop from verified details (several branches, sells on Instagram, reachable on WhatsApp, has a website). Left out when there's nothing specific. It never guesses.
- **AI-written introductions** (optional, above).
- **Near-duplicate warning:** a draft whose subject matches, or whose text is 80% the same as, another message from the last 24 hours shows a warning. **Regenerate** writes another version (unedited drafts only).

## Instagram, Facebook, TikTok and Telegram (you send them)

These platforms don't allow automated cold messages, so the agent drafts and you send, exactly like WhatsApp:

1. Add the business's profile link or @username on the lead (lead page → Business details → Profiles), on the manual lead form, or in a CSV (`instagram`, `facebook`, `tiktok`, `telegram` columns).
2. Draft from the lead page, or tick the channel under **Settings → Outreach** (off by default; the agent uses the first ticked channel each lead has, in your order).
3. Approve it in the queue, press **Copy text and open …**: the text is copied and their chat opens (Instagram `ig.me`, Facebook `m.me`, Telegram `t.me`; TikTok opens the profile, then press Message). Paste, send, then press **I've sent it**.

No account is logged in to, and nothing is sent by the agent. Each message is kept within the platform's length limit (Instagram and TikTok about 1,000 characters). Starter templates for each platform are added once (Templates). Marking a lead *do not contact* also blocks its social accounts; you can add one by hand under Do not contact (`instagram:@name` or a profile link). Controlled Autonomous Mode never approves these.

## Instagram lookup and the Instagram/Facebook inbox (Meta app)

Set up once with **docs/META_SETUP.md** (a free Meta app you own; the Page token goes in `.env`). Then, under
**Settings → Instagram & Facebook**, switch on what you want; each is off by default.

- **Instagram profile lookup.** On a lead with an Instagram profile, press **Look up on Instagram**; or type an @username
  under **Discovery → Instagram lookup** and use the result to fill the lead form. You get the public bio, website,
  followers and posts, added as facts credited to Instagram. Website and phone (from the bio) only fill blanks; nothing
  you entered is overwritten. Business and creator accounts only. It can't search Instagram.
- **Inbox.** While the agent runs it asks Meta for recent conversations on your Page (Messenger) and Instagram account,
  read-only, every 15 minutes by default (no webhook, so nothing on the laptop is exposed to the internet). A message
  from a lead (matched by Instagram username, or someone you linked before) becomes a reply on that lead: labelled, STOP
  respected, follow-ups stopped, and an answer drafted for your approval. Anyone else appears under **Inbox → Not a lead yet**,
  where you **Link** them to a lead, **Add as a new lead**, or **Ignore**. Each message is stored once.
- **Sending replies.** By default you send approved replies yourself (copy, then paste in Instagram or Meta Business
  Suite). If you choose **Send approved replies through Meta**, an approved reply to someone whose last message is under
  24 hours old is sent by the agent, in the same chat, as a reply. Older ones, and every cold message, stay yours to send.
  Controlled Autonomous Mode never approves Instagram or Facebook messages. A send whose outcome is unknown (no answer
  from Meta) is never retried automatically; it comes back to you with a warning.
- **Development mode.** Until Meta approves the app (App Review), only people with a role on the app can be read or
  answered. Profile lookup works meanwhile.

## Web search (Tavily and Brave)

Add `TAVILY_API_KEY` and/or `BRAVE_SEARCH_API_KEY` to `.env` and restart. Under **Settings → Web search & groups** tick
none, one or both, and set each provider's monthly limit, results per search, country and how long results are reused.
Then **Discovery → Web search**: type words like `fabric shop Balogun Lagos`, pick where (anywhere, Instagram, Facebook,
TikTok) and press **Search**. Results are sorted into websites, profiles (with their @username) and other pages; those
already in your leads are marked. **Use in "Add a lead"** fills the lead form; Instagram profiles can be looked up first.

- Searches run only when you press Search. The agent counts each one before calling the provider and stops at your
  monthly limit, so a mistake can't run up a bill (Brave has no cap of its own).
- The same search again within the reuse period shows the saved results and spends nothing (tick "Search again" to refresh).
- Usage appears on the Overview usage card (Brave at about $0.005 a search; Tavily's free credits at $0).

## WhatsApp group exports (assist only)

Switch it on under **Settings → Web search & groups**. In a WhatsApp group you're in: ⋮ → More → Export chat →
**Without media**, then upload the `.txt` or `.zip` under **Discovery → WhatsApp group export**. You see each sender with
their number (from the sender line, or a number they wrote), one short sample of what they posted and a suggested
category. Tick the vendors you want, confirm, and they become leads. The chat itself is not stored.

These people never asked to hear from you, so the agent treats them strictly:
- never email, and never sent by the agent: only messages you send yourself (WhatsApp, or a social chat);
- every first message opens with your **group first line** (Settings), which names the group and says reply STOP;
- numbers on your do-not-contact list can't be imported, and a STOP adds them for good;
- a number that is already a lead stays as it was (it isn't marked as a group lead).

## Interest form and referrals

Merchants who want to hear from us fill in a **Google Form** (free, always online, nothing to host). Set up under **Settings → Leads & form**, where the page walks you through it:

- Publish the form's response sheet as CSV (File → Share → Publish to web) and paste that link. **Test the sheet** shows which columns were found, without importing.
- Switch the import on and Save. While the agent runs, it reads the sheet every so often (default 30 minutes) and adds each new answer as a lead marked *asked to hear from us* (+30 to its score). Each answer is imported once. By default only answers with the consent box ticked are imported.
- Column titles are configurable; a column that starts with the title matches too.

Referrals (each switched on separately):

- **"Who referred you?"**: the answer is matched to an existing lead by phone, email, @handle, or exact business name. Anything ambiguous is left alone.
- **Personal referral links**: paste your form's pre-filled link with `REFCODE` where the code goes. Each merchant gets a link (lead page → Referrals, or `{{referral_link}}` in a template) that fills in their code, so whoever comes through it is linked to them.

The published sheet link can be read by anyone who has it: keep it private, and ask only for what you need.

## Sources the agent will not use

- **Searching Instagram, Facebook, TikTok, Jumia and Konga:** their terms forbid scraping. Add businesses from those sites by hand; Instagram business profiles you name can be looked up through the Meta app, and messaging on Instagram, Facebook, TikTok and Telegram is supported as messages you send yourself (above).
- **Google Places:** needs a billing account, so it stays off unless you approve the cost.
- **Reading WhatsApp itself:** never. Group members come only from an export you make and upload.
- **WhatsApp Cloud API:** charges per marketing message and needs the recipient's opt-in. Not planned for now.

## Security

- The server listens on `127.0.0.1` only. API requests must carry a local `Host` header, and write requests a custom header. This stops other websites open in your browser from driving the agent.
- Secrets live only in `.env`, which is gitignored. The dashboard never shows them, and logs remove them.
- The database role has no superuser rights.

## Folder structure

```
stockoja-sales-agent/
├─ start-agent.bat / stop-agent.bat   Windows start and stop
├─ .env.example                       settings template (copy to .env)
├─ scripts/
│  ├─ db-setup.ts                     creates role + databases, migrates (one-time)
│  └─ db-migrate.ts                   applies new migrations
├─ src/
│  ├─ config.ts                       .env validation
│  ├─ settings.ts                     dashboard settings (stored in the database)
│  ├─ log.ts                          logger with redaction
│  ├─ usage.ts                        external call / cost tracking
│  ├─ db/                             pool, migration runner, migrations/*.sql
│  ├─ queue/queue.ts                  persistent task queue, retries, start-up recovery
│  ├─ agent/controller.ts             Start/Pause/Resume/Stop worker
│  ├─ discovery/                      categories & states, OpenStreetMap, website check, CSV, task handlers
│  ├─ leads/                          normalisation, de-duplication + storage, qualification
│  ├─ outreach/                       templates rendering, drafts/approval, do-not-contact, knowledge base, seed content,
│  │                                  sending.ts (send/follow-up/delivery tasks), email/ (Resend client, compose, sending hours)
│  ├─ inbox/                          IMAP mailbox (read-only), parsing, reply labels, matching, reply drafts, demos
│  ├─ knowledge/                      document extraction, chunking, website reading, local embeddings, hybrid search
│  ├─ ai/                             Gemini client, spending cap, AI drafts and their checks
│  ├─ inbound/                        interest form import (published Google Sheet), referral codes and matching
│  ├─ meta/                           Meta Graph client, Instagram lookup, Instagram/Facebook inbox, API replies
│  ├─ system/                         start with Windows
│  └─ server/                         HTTP API (app.ts) and start-up/shutdown (index.ts)
├─ web/                               Vue 3 dashboard (Vite)
└─ tests/                             unit tests + database tests (use DATABASE_URL_TEST)
```

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Run with live reload (dashboard served through Vite) |
| `npm start` | Build the dashboard and run (what `start-agent.bat` uses) |
| `npm test` | Run all tests. Database tests use `DATABASE_URL_TEST` and are skipped if it isn't set |
| `npm run typecheck` | Type-check the server and the dashboard |
| `npm run db:setup` | One-time database setup (needs `ADMIN_DATABASE_URL`) |
| `npm run db:migrate` | Apply new migrations (start-up does this automatically too) |

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot reach PostgreSQL` | Start the `postgresql-x64-15` service (Services app, or run `net start postgresql-x64-15` in an admin terminal). Check `DATABASE_URL` |
| `password authentication failed for user "sales_agent"` | The password in `DATABASE_URL` doesn't match the role. Re-run `npm run db:setup` with a fresh role name, or reset it with `ALTER ROLE sales_agent PASSWORD '…'` |
| `The sales agent is already running` | Another window has it open. Use that one, or close it first |
| `Port 6400 is in use` | Change `PORT` in `.env` |
| Searches stay "Queued" | The agent is stopped or paused. Press Start |
| A search failed with HTTP 429/504 | OpenStreetMap is busy. The task retries itself later. Raise the gap between searches in Settings if it keeps happening |
| Few leads, few emails | That's expected from OpenStreetMap in Nigeria. Add leads you find yourself, or by CSV |
| Tasks "Need review" after a restart | They were interrupted or overdue. Open **Tasks** and choose Retry or Cancel |
| Dashboard says it can't reach the agent | Its window was closed. Run `start-agent.bat` |
| "Switch to live" is refused | Settings → Email sending lists what's missing (reply mailbox, API key, your name, or an unverified domain). Restart after editing `.env` |
| Approved emails stay "Approved" | Outside sending hours, the daily limit is reached, or the agent is stopped. **Next send** in Settings shows when |
| Mailbox test: "login failed" | Use an app password, not your main one, and check IMAP is enabled for the mailbox. Restart after editing `.env` |
| A reply didn't show up | Check the folder is listed under Settings → Inbox & answers, and the channel is switched on there. With **Show every message** off, only mail from a lead's address or business domain, or answering one of our subjects, is read. Look under **Not a lead yet**, or paste it in |
| Drafts say "Template used: Gemini could not write this right now" | Gemini was busy on every model, or out of quota. Nothing to fix: later drafts try AI again. Press **Regenerate** on a draft to have AI write it again |
| A reply got the wrong label | Change it in the Inbox. If it was wrongly marked STOP, lift the entry on the Do not contact page and set the lead's status |
| Knowledge says "Word search only" | pgvector isn't enabled. See [Knowledge](#knowledge-documents-and-your-website) |
| The embedding model didn't download | It needs internet once (from Hugging Face). Searching by words still works meanwhile; press **Prepare meaning search** under Knowledge later |
| A website gave few or no pages | The site may build pages with JavaScript, block us in robots.txt, or the link's path is narrow. Upload the content as a document instead |
| "Test the sheet" says it's a web page, not CSV | Use the **Publish to web → CSV** link, not the sheet's normal share link |
| Form answers aren't imported | The import is off, the agent is stopped, or answers lack consent / a business name. **Settings → Leads & form** shows the last read and what was skipped |
| "No Instagram profile we can read a username from" | The lead's link points at a post or group, not a profile. Add the profile link or @username on the lead page |
| "Meta says the Page access token is invalid or has expired" | Generate a new long-lived Page token (docs/META_SETUP.md, step 4), update `.env`, restart |
| Instagram messages never arrive | In the Instagram app turn on **Connected tools → Allow access to messages**; in Development mode only people with a role on the app are visible |
| "@name was not found, or is a personal account" | Lookup only sees business and creator accounts. Add the details by hand |
| "AI budget reached" | Raise the monthly cap or daily call limit under Settings → AI & autonomy, or wait for next month/day |
| A send task "Needs review" | It was interrupted mid-send or email isn't set up. Check **Approval → Sent and dry runs** before retrying; Resend's idempotency key prevents a duplicate within 24 hours |
