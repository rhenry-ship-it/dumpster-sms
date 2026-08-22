# Dumpster Job Log

A one-page app: log a rental or material delivery, it auto-texts your driver and your dad (invoicing) as a group.

## What it does
- Form to enter customer, address, size/material, dates, price, notes
- On submit, sends an individual text to every number in `RECIPIENTS` (this is how "group text" works via SMS API — each person gets their own copy, but it reads the same)
- Keeps a running log of the last 25 jobs on the page
- Works from your phone browser — no app install needed once deployed

## 1. Get Twilio set up (~10 min)
1. Sign up at twilio.com, buy a phone number ($1/mo + ~$0.0079/text — for 25 rentals/week to 2 people that's under $10/mo)
2. From the Twilio Console, grab your **Account SID** and **Auth Token**
3. Note your new Twilio phone number in E.164 format (e.g. `+15551234567`)

## 2. Deploy to Railway
1. Push this folder to a GitHub repo (or ask me and I'll walk you through it once it's on GitHub)
2. In Railway: New Project → Deploy from GitHub repo → select this repo
3. Once deployed, go to the service's **Variables** tab and add:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM_NUMBER`
   - `RECIPIENTS` — driver's number and your dad's number, comma-separated, e.g. `+15551112222,+15553334444`
4. Generate a public domain for the service (Settings → Networking → Generate Domain)
5. Open that URL on your phone, add it to your home screen — now it behaves like an app

## Note on data storage
Job history is saved to a file on the server. Railway's filesystem is **not persistent across deploys** by default — if you redeploy, the log resets (texts still go out fine, this only affects the on-page history). If you want the log to survive redeploys, add a Railway Volume mounted at `/app` in the service settings, or say the word and I'll wire up a small database instead.

## Local test (optional)
```
npm install
cp .env.example .env   # fill in real values
npm start
```
Then open http://localhost:3000
