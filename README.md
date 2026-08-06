# JSB IT Ticketing — Notify Server

Tiny server that receives a submitted ticket from the ticketing app (`index.html`), generates a PDF, and automatically emails it to the IT technician via [Resend](https://resend.com) — and, optionally, sends the same PDF to a Telegram chat via a bot.

## 1. Get a Resend API key

1. Go to https://resend.com and create a free account.
2. In the dashboard, go to **API Keys** → **Create API Key**. Copy the key (starts with `re_`).
3. (Recommended) Under **Domains**, add and verify `armoroctrading.com` (or whichever domain you want emails to come from). Until a domain is verified, Resend only lets you send from `onboarding@resend.dev`, which works fine for testing but looks less professional.

## 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your values:

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
FROM_EMAIL=JSB IT Ticketing <onboarding@resend.dev>
TECH_EMAIL=tech@armoroctrading.com
```

Once you've verified a domain in Resend, change `FROM_EMAIL` to something like:
`FROM_EMAIL=JSB IT Ticketing <noreply@armoroctrading.com>`

## 2b. (Optional) Set up Telegram for automatic chat notifications

This is free forever and takes about 2 minutes — no business verification needed, unlike WhatsApp's Business API.

1. In Telegram, search for **@BotFather** and start a chat with it.
2. Send `/newbot`, give it a name, then a username ending in `bot` (e.g. `JsbItTicketingBot`).
3. BotFather replies with a token like `123456789:ABCdefGhIJKlmNoPQRstuVWXyz` — this is `TELEGRAM_BOT_TOKEN`.
4. Now open a chat with **your new bot** (search its username) and send it any message, e.g. "hi".
5. In a browser, visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` (replace `<YOUR_TOKEN>`). Look for `"chat":{"id":123456789,...}` in the response — that number is `TELEGRAM_CHAT_ID`.
6. Add both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to your `.env` (and later, to Render's environment variables). Leave them blank to skip Telegram entirely — email will keep working either way.

## 3. Run it locally (optional, to test)

```
npm install
npm start
```

Then test with:
```
curl -X POST http://localhost:3000/api/tickets/notify \
  -H "Content-Type: application/json" \
  -d '{"id":"TCK-TEST-0001","employeeName":"Test User","category":"WiFi Problem","priority":"High","neededBy":"2026-08-06T15:00","openedAt":"2026-08-06T14:00"}'
```

You should get `{"ok":true}` and an email should land at `tech@armoroctrading.com`.

## 4. Deploy for free on Render

1. Push this `notify-server` folder to a GitHub repository.
2. Go to https://render.com, sign up free, click **New +** → **Web Service**, and connect your GitHub repo.
3. Settings:
   - **Root Directory:** `notify-server` (if it's part of a bigger repo)
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Under **Environment**, add the same variables from your `.env` file (`RESEND_API_KEY`, `FROM_EMAIL`, `TECH_EMAIL`, and `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` if using Telegram).
5. Click **Create Web Service**. After it deploys, Render gives you a URL like `https://jsb-it-notify.onrender.com`.

## 5. Wire it into the ticketing app

Open `index.html` (the ticketing app) and find this line near the top of the `<script>` block:

```js
var NOTIFY_SERVER_URL = "";
```

Set it to your deployed URL + `/api/tickets/notify`, e.g.:

```js
var NOTIFY_SERVER_URL = "https://jsb-it-notify.onrender.com/api/tickets/notify";
```

Save the file. From then on, every submitted ticket automatically emails a PDF to the IT technician — no employee action needed.

**Note:** Render's free tier "spins down" the service after periods of inactivity, so the first request after a while can take ~30-50 seconds to wake it up (the second request onward is fast). If that delay is a problem, Render's cheapest paid tier keeps it always-on.
