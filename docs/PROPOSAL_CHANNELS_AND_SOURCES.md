# Proposal: more ways to find merchants and to reach them

Status: **step 1 is built** (A1 interest form + referrals; B4–B6 send-it-yourself drafts for Instagram, Facebook, TikTok, Telegram).
**Step 2 is built** (A2 Instagram lookup, B3 Instagram/Facebook inbox replies; see `docs/META_SETUP.md`), tested against a fake Meta API
and waiting for the real app to be set up. **Step 3 is built** (A3 web search with Tavily and/or Brave chosen in Settings; A6 WhatsApp
group-export import, assist only), tested against fake providers and waiting for your API keys. **Step 4 is built** (one inbox per
channel, replies from the app, per-channel access and answer settings, Telegram bot, LinkedIn paste-in and drafts; see the decision
below), tested against a fake mailbox and a fake Telegram. Still open: WhatsApp Cloud API test mode, A4 directories. Prices were checked on 26 Oct 2026 and change often; each item
is re-checked before I build it, and nothing paid is connected without your approval.

## Why only OpenStreetMap and email today

The agent can only use sources that let a program read them under their terms, and channels that let a business
send a first message. OpenStreetMap, business websites and email meet both rules for free. Most social platforms
do not: they have no search API for other people's businesses, and their messaging APIs only let you **reply**
to people who wrote to you first. Scraping them, or sending automated cold DMs from a personal account, breaks
their terms and usually gets the account banned. For StockỌja, losing its Instagram or WhatsApp number would
hurt more than any leads gained.

So, for each idea below: what is allowed, what it costs, and what I suggest.

## Part A. Finding merchants (discovery)

| # | Source | What is allowed | Cost | Suggestion |
|---|---|---|---|---|
| A1 | **Inbound form + referrals**: a short "Interested?" form (on stockoja.com or as a link in your bio/status) and a referral link merchants pass on | Fully allowed: they come to you, with consent | Free | **Do first.** Warmest leads, and consent makes WhatsApp and email follow-up legitimate |
| A2 | **Instagram profile lookup** (Business Discovery API): you paste an @username, the agent pulls the public bio, website, follower count and post count | Allowed for public **business/creator** accounts. Needs StockỌja's IG professional account linked to a Facebook Page and a Meta app (yours, in development mode) | Free | **Yes.** Fast enrichment for shops you find while scrolling. It can't *search* Instagram; you supply usernames |
| A3 | **Web search API**: queries like `"fashion store" Ikeja site:instagram.com` or `"shoe vendor" Lagos WhatsApp` return public pages, which the agent reads like a website | Allowed through an official API. Results that point at Instagram/TikTok give usernames for A2 | Brave: about 1,000 searches/month covered by a monthly $5 credit, but a **card is required** and there's no spending cap. Tavily: about 1,000 free credits/month (to confirm). Google's Custom Search API is closed to new users | **Maybe.** Useful, but every option needs an account; Brave needs a card. Decide which one, if any |
| A4 | **Nigerian business directories** (VConnect, BusinessList.com.ng, Nigeria Galleria, etc.) | Depends on each site's terms and robots.txt. I would check each one and only read the ones that allow it, slowly | Free | **Maybe.** I'll check each site's terms first and report back before reading any |
| A5 | **Telegram vendor channels/groups** you are a member of | Reading a **public channel's** posts through the Bot API is fine if the bot is added; reading groups you joined with a userbot is a grey area | Free | **Limited:** you forward or paste vendor posts and handles; the agent extracts business name, @handle and phone. No automated group reading |
| A6 | **WhatsApp selling groups** | No API reads groups. Exporting a chat yourself (WhatsApp → Export chat) is allowed for you | Free | **Limited:** you export a chat; the agent imports vendor names and numbers as leads. Be aware that group members did not agree to be contacted; treat these as low-trust and respect STOP strictly |
| A7 | **Facebook groups / Marketplace sellers** | Meta removed the Groups API in 2024; Marketplace has no API. Scraping is forbidden | — | **Manual only:** paste profile links into the lead form (as now) |
| A8 | **TikTok** | No search API for business accounts for this use; scraping is forbidden | — | **Manual only:** paste @handles; the agent records them. TikTok's Research API is for academic researchers only |

## Part B. Reaching merchants (channels)

| # | Channel | What is allowed | Cost | Suggestion |
|---|---|---|---|---|
| B1 | **WhatsApp click-to-chat** (today) | You send each message yourself | Free | Keep |
| B2 | **WhatsApp Cloud API** (official, sent by the agent) | A **first** message must be an approved *template*, and the merchant should have opted in. Replies inside 24 hours of their message are free-form | **Not free any more for us:** setup is free, but every template message is charged (marketing about $0.05–0.06 each in Nigeria), and from **1 Oct 2026 Meta also charges for service replies** (about $0.007–0.01 each; some sources say the first 1,000/month per number are free; to confirm on Meta's rate card). Also needs a phone number not used in the WhatsApp app | **Set up in test mode only** (free: Meta's test number, up to 5 recipient numbers you add) so it's ready; send real messages only when you approve a budget. Use it for merchants who opted in (A1) and for replies, not cold outreach |
| B3 | **Instagram DM / Facebook Messenger replies** (inbox) | The official APIs let a business **reply** to people who messaged it, within 24 hours (longer with a "human agent" tag). No cold DMs | Free | **Yes.** The agent shows those messages in the Inbox and drafts replies from your knowledge, for your approval. Needs the Meta app from A2 plus app review for live use |
| B4 | **Instagram/Facebook/TikTok cold DM "assist"** | Automated cold DMs are against the terms | Free | **Yes, as assist:** like WhatsApp today. The agent drafts a varied message, opens the profile, copies the text; you press send and click "I've sent it". No automation of your account |
| B5 | **Telegram** | A bot can only message people who started it. Cold DMs from a user account via automation break Telegram's terms (accounts get limited for spam) | Free | **Assist only** for cold messages (as B4). Optionally a StockỌja bot that merchants *start* from a link, which then can talk to them freely (free) |
| B6 | **TikTok** | No messaging API for this | — | **Assist only** (as B4) |
| B7 | **SMS** (Termii, Africa's Talking) | Allowed with a registered sender ID; DND rules apply in Nigeria | Paid per SMS (a few naira each) | **Later, if you want it.** Not free |

## Suggested order (you decide)

1. **A1 inbound form + referrals** and **B4/B5/B6 assist** for IG, Facebook, TikTok and Telegram. All free, no accounts needed, and it reuses the approval queue, message variety and STOP handling.
2. **A2 Instagram lookup** and **B3 IG/FB inbox replies**: one Meta app covers both. I'd walk you through creating it (free). Nothing is connected without your authorisation.
3. **B2 WhatsApp Cloud API in test mode**: ready to switch on once you approve a budget.
4. **A3 web search** and **A4 directories**: after you choose a provider, and after I check each directory's terms.

## Decisions (27 Oct 2026)

- **Next build:** the Meta app: A2 Instagram profile lookup and B3 Instagram/Facebook inbox replies.
- **Instagram:** StockỌja's Instagram is a professional account linked to a Facebook Page.
- **Web search (A3):** both Tavily and Brave. In Settings you choose none, one or both. Every option is set in
  Settings; the API keys themselves stay in `.env` (credentials rule), and Settings shows whether each key is present.
- **WhatsApp group exports (A6):** allowed as assist only: low-trust leads, sent by you, opt-out in the first line,
  STOP respected strictly.
- Still open: B2 WhatsApp Cloud API test mode (and a spare number), A4 directories.

## Questions for you

1. Which items should I build, and in what order? (My suggestion is above.)
2. **WhatsApp Cloud API**: given the new charges, set it up in free test mode only for now? Do you have a spare phone number for it (it can't be the number used in the WhatsApp app)?
3. **Meta app** (for A2 and B3): is StockỌja's Instagram already a business account linked to a Facebook Page?
4. **Web search**: Brave (card needed, about 1,000 searches covered monthly), Tavily (about 1,000 free credits, no card, to confirm), or skip it for now?
5. **Inbound form**: host it on the agent's dashboard (works only while your laptop is on, needs a tunnel), or a free form (Google Forms / Tally) the agent imports from? The second is simpler and always online.
6. **Group exports (A6)**: are you comfortable contacting people found in WhatsApp group exports? It is legal grey ground under the NDPA (Nigeria Data Protection Act) without consent; my suggestion is to use them only for the assist channel, with an opt-out in the first line.

## Decided 27 Oct 2026: one inbox per channel, replies from the app, agent autonomy

What you asked: separate inboxes (Facebook, Instagram, TikTok, email, Telegram, LinkedIn); every message visible, not
only outreach replies; Settings toggles for what the agent may read (all on by default); replying from the app; and
letting the agent answer, either with your approval or by sending itself.

- **Email:** read the whole mailbox, read-only, but only from the folders you pick in Settings.
- **TikTok and LinkedIn:** no inbox API is open to a small business, so they get paste-in tabs: you paste a message you
  received, the agent labels it and drafts a reply, you send it yourself. LinkedIn also becomes a draft channel.
- **Telegram:** through a free bot you create with @BotFather (token in `.env`); your personal account is never read.
- **Agent replies:** per channel, off by default: Draft only (you approve), or Auto-send for answers grounded in your
  knowledge base, with a daily cap; anything uncertain is left for you. Never invents times or prices. Instagram and
  Facebook auto-replies only inside Meta's 24-hour window.
