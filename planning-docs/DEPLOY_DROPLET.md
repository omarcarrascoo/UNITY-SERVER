# Deploy brain-station to a DigitalOcean Droplet — Plan

> Goal: brain-station runs 24/7 without the user's laptop, reachable (panel + API)
> from anywhere — including a future mobile app — securely.
> Status: PLAN (no config files generated yet — this doc decides the approach first).

---

## 1. Why a Droplet (not a free PaaS)

brain-station is NOT a stateless web app. It needs things free tiers don't give:
- **Always-on process** (Discord bot + A2A servers) — not serverless.
- **Real disk** — clones repos, runs `git`/`npm install`/gates; `workspaces/` is already ~1.6 GB.
- **Subprocesses + Puppeteer** (headless Chromium) — needs system libs.
- **Persistent SQLite** (`.unity/`, runs/tickets/conversations/telemetry) — must survive redeploys.

→ A VPS (Droplet) with **PM2 + Nginx** is the right fit. **Docker is deferred** — direct
PM2+Nginx is simpler now; dockerize later when squads move to separate machines (roadmap Phase E).

**Recommended size:** **$12/mo, 2 GB RAM** (the $6/1GB can OOM during Puppeteer + concurrent
npm installs). 1 vCPU is fine to start. Ubuntu 24.04 LTS.

---

## 2. The architecture on the droplet

```
                    Internet
                       │  HTTPS (443)
                       ▼
              ┌──────────────────┐
              │      Nginx       │  TLS (Let's Encrypt) + auth gate
              └────────┬─────────┘
                       │ proxy → 127.0.0.1
        ┌──────────────┼───────────────┐
        ▼              ▼                ▼
   panel :4477   (PM A2A :5000)   (dev-squad :5001, mkt :5002, research :5003)
        └──────── all bound to 127.0.0.1, NOT public ────────┘
                       │
                  PM2 supervises: `core` + `dev-squad` (auto-restart, logs, boot on reboot)
                       │
              .unity/*.sqlite + workspaces/   (persistent on the droplet disk)
```
- **Discord** needs no inbound — the bot dials out to Discord. Works as-is.
- **A2A servers stay on 127.0.0.1** — only reachable locally on the droplet (agents talk to each other in-box). Never expose them.
- **Only the panel/API** (:4477) is proxied out, behind auth.

---

## 3. The auth question (this is the important part for the mobile app)

Today the panel + A2A run with **`noAuthentication`** and bind to localhost. Exposing them
raw = anyone could trigger runs, read your DB (tokens, code), and burn your DeepSeek/GitHub
spend. There are TWO layers to consider, and the mobile app changes the recommendation:

### Option A — Nginx Basic Auth (quick, but limited for mobile)
Nginx asks user/password before proxying. Good for a browser; **awkward for a mobile app**
(every API call must send Basic credentials, no real session, no per-user logic, hard to
log out / rotate). Fine as a *stopgap* for browser-only access.

### Option B — App-level auth in brain-station (the "think big" path you want) ✅
Add a real auth layer INSIDE the HTTP server: a **single login (just you)** that issues a
**token (JWT or signed session)**; every `/api/*` request must carry it. The mobile app logs
in once, stores the token, and sends it on each call — standard, clean, works from any device.

**Why this is clean here:** the server has ONE entry point (`createServer` at server.ts:2973)
with 30 `/api/*` routes — so auth is a SINGLE guard at the top of the handler:
- `/health` and `/login` are public.
- everything else requires a valid token (or the existing session for the browser panel).
- Nginx still does **TLS only** (HTTPS) — auth lives in the app, so the mobile app and the
  browser use the SAME mechanism.

**Recommendation:** do **Option B** (app-level login + token), with Nginx providing **HTTPS**.
This is the future-proof choice: one login for you, accessible from any computer or the mobile
app, no Nginx-level password juggling. Basic Auth (Option A) only if you want something today
before building B.

> Scope for "just me": a single hardcoded-or-env admin credential + token issuance. No user
> table, no signup. Can grow to multi-user later if ever needed.

---

## 4. Step-by-step (once the size + auth are decided)

**On DigitalOcean (you do this):**
1. Create Droplet: Ubuntu 24.04, 2 GB RAM, add your SSH key.
2. Point a domain/subdomain at the droplet IP (needed for HTTPS), e.g. `jarvis.tudominio.com`.

**On the droplet (guided; we'll script most):**
3. Install: Node 22 (nvm or NodeSource), `git`, and **Puppeteer/Chromium system deps**
   (`apt install` the chromium libs — there's a known list; Puppeteer downloads its own Chromium).
4. `git clone` brain-station; `npm install`.
5. Create the production `.env` (Discord token, **fresh** GitHub PAT, DeepSeek key, channels,
   and the new auth secret). **Never commit it.**
6. **PM2**: `ecosystem.config.js` runs `core` + `dev-squad`, `pm2 startup` + `pm2 save` so they
   boot on reboot and auto-restart on crash.
7. **Nginx**: reverse-proxy `:4477` → `https://jarvis.tudominio.com`; `certbot` for TLS.
8. **Firewall (ufw)**: allow only 22 (SSH) + 80/443. Block 4477/5000-5003 from outside (they
   stay on 127.0.0.1 anyway).

**In the codebase (we do this, BEFORE deploy):**
9. Build the app-level auth layer (Option B): `/login` endpoint, token middleware guard, and
   wire the panel + mobile app to use it.
10. A `dev` vs `prod` start path (the current `tsx watch` is for dev; prod should run compiled
    or `tsx` without watch, via PM2).

---

## 5. Order of work (proposed)

1. **Build app-level auth (Option B)** in brain-station — the blocker for safe public access. (code)
2. **Generate PM2 `ecosystem.config.js` + Nginx config + this guide's commands.** (config)
3. **You provision the droplet + domain**, we walk the setup.
4. Harden: firewall, fail2ban, log rotation, backups of `.unity/` (the SQLite state).

> Note: a `prod` build/run path is also needed — today everything runs via `tsx watch`
> (dev). PM2 should run a non-watch start (compiled `dist/` or `tsx` plain).

---

## 6. Open decisions

- **Auth approach**: Option B (app-level login + token) recommended for the mobile app. Confirm.
- **Domain**: needed for HTTPS — do you have one to point at the droplet?
- **Droplet size**: $12/2GB recommended (vs $6/1GB risk of OOM with Puppeteer).
- **Secrets**: the GitHub PAT is currently invalid (401) — needs a fresh one for prod anyway.
