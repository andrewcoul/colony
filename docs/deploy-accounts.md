# Colony on the web, with accounts

How Colony works for several people through its website, and how to switch to it.

## How requests get in

```
browser ──> colony-site Worker ──> Cloudflare Tunnel ──> Colony on your PC
            (web app + /api)       (origin Access app)   (sign-in, your data)
```

- The **colony-site** Worker (`site/`) serves the web app, and passes `/api/*` (sign-in at
  `/api/auth/*` too) and WebSockets to the origin. It signs in to the origin's Access app with a
  service token, and adds `X-Forwarded-Host` and `X-Forwarded-Proto`. Cookies pass through unchanged.
- The **origin Access app** protects the tunnel hostname (for example `colony-origin.werdna.xyz`).
  Colony refuses any tunnel request without a valid token from it.
- Then Colony needs a **web sign-in** (a session cookie). Without one, `/api` answers 401 and the
  web app shows the sign-in page. Only signing in, `/api/auth-status` and invite checks work before that.
- Web sign-in is [Better Auth](https://www.better-auth.com), inside Colony at `/api/auth/*`. Its
  accounts, sessions and password hashes are in `data/auth.db` (mode 600), apart from `colony.db`.
  The session cookie is `__Secure-better-auth.session_token`: Secure, HttpOnly, SameSite=Lax, and
  host-only. Sign-in and sign-up are limited to 5 tries a minute per visitor. Behind the Worker,
  the origin sees the Worker's address, so the Worker passes the visitor's as `X-Colony-Client-Ip`;
  Colony counts it only on requests with the Worker's service token.
- Refused WebSockets get a real answer (401 without a sign-in, 403 otherwise, as JSON) before they
  close, so the Worker passes that on instead of showing "Colony is offline".
- Changes (POST, PUT, PATCH, DELETE) and WebSockets through the tunnel must have an `Origin` in
  `COLONY_PUBLIC_ORIGINS`.
- On the tailnet and on the PC itself, nothing changes: no sign-in, and you are the admin.

## Settings (`.env`)

| Variable | What it does |
| --- | --- |
| `COLONY_ADMIN_EMAILS` | Emails that sign in as you, the admin. They're never invited: set up their password in Settings › People. |
| `COLONY_PUBLIC_ORIGINS` | The web addresses of Colony, comma-separated, e.g. `https://colony.werdna.xyz,https://colony-site.acoulson4646.workers.dev`. Sign-in only trusts these. Links in emails use the one you're on, else the first. |
| `BETTER_AUTH_SECRET` | Turns web sign-in on. A random string of 32 characters or more (`openssl rand -base64 32`). Without it (or without `COLONY_PUBLIC_ORIGINS`), nobody can sign in on the web, and the log says why. |
| `COLONY_INVITE_TTL_DAYS` | How long an invite link works. Default 7. |
| `RESEND_API_KEY` | Email through Resend (invites, password resets, sign-in codes). Without it, invites give you a link to copy, and "forgot password" and "email me a code" don't show. |
| `COLONY_MAIL_FROM` | Who the email is from. Default `Colony <colony@auth.werdna.xyz>` (a domain verified in Resend). |
| `COLONY_CF_ACCESS_TEAM_DOMAIN` | Your Cloudflare Access team, e.g. `your-team.cloudflareaccess.com`. |
| `COLONY_CF_ACCESS_AUD` | The **origin** Access app's AUD tag. |
| `COLONY_CF_ACCESS_SERVICE_CLIENT_ID` | The Worker's service token client id (it ends in `.access`). Its tokens have no email; Colony accepts them by this id. |
| `COLONY_MEMBER_MAX_COMPUTERS` | How many Bot computers a member may run at once. Default 2. |

`COLONY_CF_ACCESS_ALLOWED_EMAILS` is gone: invites decide who can make an account.

## Members' models and spending

- Members' Bots never use your ChatGPT or OpenCode sign-ins. They run on **OpenCode Zen** (not Go)
  with a key of their own: make an API key in the OpenCode Console (opencode.ai, **API keys**), and
  paste it in **Settings › Members' models**. Colony keeps it in `data/credentials.json` (as
  `opencode-key`) and only ever shows its last four characters. Until you add it, members' Bots
  can't run.
- On the same page, choose the Zen models members may use and their default. To start, that's only
  `deepseek-v4.1-flash-free` (Bots get `opencode-members::deepseek-v4.1-flash-free`). Colony only
  accepts models in Zen's catalog.
- What members spend is priced at Zen's list price. Models Zen lists as free count as $0.
- Bots and settings from when members ran on OpenCode Go (`opencode-go-members`) move over by
  themselves. Saved models that Zen doesn't offer drop out (none left means the default). Bots on
  Go's old default, `muse-spark-1.3-contributor`, get the new one. Other Bots keep their model id;
  if members may not use it, the Bot says so and asks for another.
- In **Settings › People**, give each member a monthly spending cap, or set one default cap for all
  members on the Members' models page. There's none until you set one. Months run on Chicago time.
  At the cap, a member's Bots wait until the 1st.

## The Worker

```sh
npm ci                        # at the repository root
npm run build                 # builds web/dist
npm run build --prefix site   # site/dist/worker.js (web/dist inside) and site/dist/metadata.json
npm test --prefix site
```

Upload `site/dist/worker.js` as the module `worker.js` with `site/dist/metadata.json` through the
Cloudflare API. `ORIGIN_URL` is in the metadata (set `ORIGIN_URL` when building to change it). Set
two secrets on the Worker: `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` (the service token).
`site/wrangler.jsonc` shows the same setup for reference.

When the PC is off or the tunnel is down, the Worker answers `/api` with `{"offline": true}` and
pages with a short "Colony is offline" note.

## Switching over

1. On the PC, set `COLONY_ADMIN_EMAILS`, `COLONY_PUBLIC_ORIGINS`, `BETTER_AUTH_SECRET`, the three
   `COLONY_CF_ACCESS_*` values for the origin app and, if you want email, `RESEND_API_KEY`.
   Restart Colony. Check the log: it says if web sign-in is off, and why.
2. In Cloudflare: point the tunnel at Colony under the origin hostname, put the origin Access app in
   front of it with a policy that allows the Worker's service token, and deploy colony-site with
   `ORIGIN_URL` set to that hostname.
3. From the tailnet or the PC, open **Settings › People** and set up your own web sign-in.
4. Open the website, sign in, and check that your Bots are there.
5. Add the members' OpenCode Zen API key, then invite people from **Settings › People**.
6. Remove any old Access policy that let people's emails straight through to Colony.

Your data stays where it is: everything from before accounts is yours (the admin's).
