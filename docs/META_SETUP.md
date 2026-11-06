# Setting up the Meta app (Instagram lookup and the Instagram/Facebook inbox)

This connects the agent to **StockỌja's own** Facebook Page and the Instagram professional account linked to it,
through a Meta app that you own. It is free. Nothing is connected until you put the values in `.env`, and each
feature stays off until you switch it on in **Settings → Instagram & Facebook**.

What it gives you:

- **Instagram profile lookup**: type an @username and see that business's public profile (name, bio, website,
  followers, posts). Works only for business and creator accounts. It cannot search Instagram.
- **Inbox**: messages people send to your Page (Messenger) and your Instagram account appear in the agent's Inbox,
  are labelled, and get a drafted answer for your approval.
- **Replies through Meta (optional)**: an approved reply to someone who wrote in the last 24 hours can be sent by the
  agent. Off by default ("you send them").

What it never does: post anything, send a first (cold) message, log in to an account, or read anyone else's inbox.

Meta's screens change often. If a button below has moved, look for the same words nearby.

## 1. Check the accounts

- The Instagram account must be **professional** (business or creator) and **linked to the StockỌja Facebook Page**.
  You confirmed this is already the case.
- In the Instagram app: **Settings → Messages and calls → Connected tools → Allow access to messages**: turn it on.
  Without it, Instagram messages can't be read through the API.
- You need to be an admin of the Facebook Page.

## 2. Create the app

1. Go to https://developers.facebook.com, log in with the Facebook account that manages the Page, and accept the
   developer terms if asked (free).
2. **My Apps → Create app**. Name it, for example, "StockOja Sales Agent". Use your business email.
3. When asked what the app is for, choose the options for **managing messaging and content on Instagram** and
   **engaging with customers on Messenger** (or choose the **Business** app type if you are shown types).
4. If asked to connect a business portfolio, choose StockỌja's (or skip if you don't have one).

The app starts in **Development mode**. That's what we want for now; see step 7.

## 3. Add the products

In the app dashboard, add:

- **Messenger** (for the Facebook Page inbox and replies).
- **Instagram**: the version that works **through Facebook Login / your Facebook Page** (not "Instagram Login").

## 4. Get a long-lived Page access token

1. Open the **Graph API Explorer**: https://developers.facebook.com/tools/explorer
2. Top right: choose your app. Under **User or Page**, choose **Get User Access Token** and tick these permissions:
   - `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`
   - `instagram_basic`, `instagram_manage_messages`
   - `business_management` (only if the Page belongs to a business portfolio)
3. Press **Generate Access Token** and allow access for the StockỌja Page and Instagram account.
4. Make it long-lived: open the **Access Token Debugger** (https://developers.facebook.com/tools/debug/accesstoken),
   paste the token, press **Debug**, then **Extend Access Token** at the bottom. Copy the new (long-lived) user token.
5. Back in the Graph API Explorer, paste the long-lived user token in the token box and run `GET me/accounts`.
   In the answer, find the StockỌja Page: copy its `access_token` (this Page token does not expire on a timer) and its `id`.

The Page token can still stop working if you change your Facebook password, remove the app, or lose admin on the Page.
The agent then says the token is invalid; repeat this step.

## 5. The app secret (recommended)

App dashboard → **App settings → Basic → App secret → Show**. With it set, every call the agent makes carries a
proof derived from the secret, so the token alone is not enough for anyone who sees it.

## 6. Put the values in `.env`

```
META_PAGE_ACCESS_TOKEN=<the Page access_token from step 4>
META_PAGE_ID=<the Page id from step 4>
META_APP_SECRET=<from step 5>
# Optional: filled in automatically from the Page if left empty.
META_IG_USER_ID=
```

`.env` is never committed (it is in `.gitignore`). Don't paste these values into chats, screenshots or tickets.
Restart the agent, then open **Settings → Instagram & Facebook** and press **Test connection**. It should name your
Page and your Instagram account.

## 7. Development mode, testing, and going live

While the app is in Development mode, Meta only lets it read and answer messages from **people with a role on the
app** (admins, developers, testers: **App roles → Roles**). That is enough to test the inbox with your own second
account. Instagram profile lookup works on public business accounts in Development mode.

To read and answer messages from merchants in general, Meta requires **App Review** for `pages_messaging` and
`instagram_manage_messages` (Advanced Access), and usually **Business Verification** of StockỌja. Both are free but
take time and need a privacy policy link (stockoja.com/privacy) and a short screen recording of how the messages are
used. Ask me when you're ready and I'll prepare what Meta asks for. Until then, the inbox only shows your testers'
messages.

## 8. Switching features on

In **Settings → Instagram & Facebook**:

1. Tick **Look up public Instagram business and creator profiles** and Save. Then use **Look up** on a lead's page or
   in Discovery → Instagram lookup.
2. Tick **Read messages**, choose Instagram and/or Facebook, Save, and press **Check messages now** (the agent must be
   running for the regular checks).
3. Only if you want it: **Send approved replies through Meta**. Without it, approved replies are copied and you send
   them in Instagram or Meta Business Suite, as with other DMs.

## Rate limits and costs

All of this is free. Meta limits how many calls an app makes per hour; the agent checks the inbox every 15 minutes by
default and looks up profiles only on your click, far below the limits. Every call is counted on the Usage page at
$0.
