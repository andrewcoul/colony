# Plan: Everyone's Bots, one server

Status: proposed, 2026-10-15. Follows `pip-parity.md` (built on branch `pip-parity`) and replaces its owner/member model.

Designs: Paper file "Colony · Grok-style chat", page `Family · Everyone's Bots` (artboards F1–F10).

## The idea

One Colony server stays on all the time, so routines, phones, push and calls work whenever they should. What changes is who things belong to:

- **Everyone in the family has their own Bots.** A Bot belongs to the person who made it: its chat, memory, skills, routines and computer are theirs. Nobody else sees or manages it.
- **Being on the tailnet is being in the family.** No one adds, approves or removes people inside Colony. (To keep someone out, use Tailscale's own sharing or `COLONY_ALLOWED_USERS`.)
- **No admin over other people's Bots.** One person runs the PC Colony is on: the **host**. The host looks after what is genuinely shared (the server, updates, shared model keys, the voice provider) and nothing else.
- **Things belong to whoever brought them.** An account (mail, calendar, 1Password) belongs to whoever connected it; a lent PC to whoever lent it; a personal model key to whoever added it.
- **Approvals go to whoever owns the thing being touched.** Sending from Marija's mail asks Marija. Running a command on Andrew's PC asks Andrew, whoever's Bot it is.

Privacy holds in the app. The host can read the database on their own PC; this plan doesn't defend against that, and the app says so once, in Settings › Family.

## 1. Who's who

- `people` stays. `role` becomes `host | family`; `pending` and `ignored` go away. The first login seen (or a request from this PC) is the host, as now. Every other login is family the moment it first opens Colony.
- Existing data migrates to the host: every Bot, account, provider and PC built so far belongs to them. Former members become family; `pending` logins become family; `ignored` logins are deleted (they can be kept out with `COLONY_ALLOWED_USERS`).
- The waiting page from phase 7 goes. In its place, a first-run card for new family members: "This is your Colony too. Make a Bot."

## 2. What belongs to whom

**Migration (one step):**

- `bots.owner_id` (person; the host for existing Bots). A Bot's own chat belongs to its owner.
- `chats.owner_id` for topics (whoever created it). `chat_people` and `everyone` stay: the owner shares a topic with people, as now.
- `accounts.person_id`. `bot_access` is unchanged, but only the account's person can grant a Bot access to it, and only to Bots that person owns.
- `nodes.person_id`, set from the login that connected the PC. `node_access` goes away (section 4).
- `providers` gain `person_id` (null: shared). They move from `settings.json` into the database so they can be owned.
- `approvals.approver_id`: who must answer (section 5).
- `push_subscriptions.person_id` already exists.

**What each person sees:**

- **Their Bots**, with their chats, routines, memory and skills.
- **Topics they own or that are shared with them.** In a topic, everyone in it can add their *own* Bots; nobody can add someone else's Bot. Other people's Bots in a topic show with their owner's color ("Luke · Andrew's").
- **The family:** names, colors, and which PCs each has lent (Settings › Family).
- Other people's Bot chats, accounts, keys and routines never appear: not in `/state`, not on the event stream, not in push.

Bot-to-Bot help (`message_bot`) stays within one person's Bots. A Bot can only consult another person's Bot inside a topic they share.

## 3. Models and keys

- **Shared models:** providers with no owner, added by the host. Every Bot can use them; the host pays.
- **My models:** anyone can add their own provider and key. Only their Bots can use it. Keys are never shown to anyone, including the host's app.
- The model picker groups them: "Shared" and "Yours". New Bots default to the person's own default model, or to the shared default.
- The host can't see personal keys in the app; they're in the database like everything else.

## 4. PCs

- **A PC belongs to whoever lent it** (the login on the desktop app's connection). Node connections are open to all family, not just the host, fixing the phase 6 gap.
- **Being family is the permission.** Any family Bot can use any lent PC, within that PC's switches. The per-Bot levels in a Bot's profile go away.
- **The PC's owner hears about every use.** Approval rules are as before (browser once per task; screen, terminal and file writes every time), but they go to the PC's owner, naming the Bot and its owner: "Luke (Andrew's) wants to run `npm test` on your laptop".
- **An offline PC is simply unavailable.** Bots keep running on the server; a Bot that needs the PC says it's offline and carries on. Nothing is queued for later.
- **Bots pick a PC.** `pc_*` tools take an optional `pc` name. With one PC lent, it's that one; the Bot's owner's own PC comes first otherwise.
- The on-screen pill names the Bot and its owner, and Stop still ends that Bot's turn.

## 5. Approvals

Each approval gets an `approver_id`:

| Action | Who approves |
|---|---|
| Sending mail, inviting, changing a calendar | the person who connected that account |
| Using a 1Password login | the person who connected that vault |
| Anything on a lent PC | the PC's owner |
| Browser takeover and other actions on a Bot's own computer | the Bot's owner |

Approval cards show to everyone who can see the chat, but only the approver gets the buttons and the push; others see "Waiting for Marija".

## 6. Per-person settings

Settings splits into **You** and **This Colony**:

- **You** (everyone): My models, My accounts, This PC (in the desktop app), Calls (quiet hours, whether your Bots may ring you), Notifications, What Bots know about you (USER.md).
- **This Colony** (host only): Shared models, Voice provider, Updates, Family (read-only list for others).

Voice: the provider stays shared (host); quiet hours, calls on/off and each Bot's voice become per person (a Bot rings only its owner).

## 7. Web

- **Roster:** "Your Bots" (only yours), then Topics. Topics shared with you show the owner's dot.
- **Create Bot** is open to everyone; the Bot is yours.
- **Topic dialog:** "Your Bots in this topic" plus a read-only row of other people's Bots already in it; "Shared with" as now.
- **Messages:** other people's Bots carry a small owner dot.
- **Approval card:** buttons for the approver; "Waiting for {name}" for everyone else.
- **Settings:** You / This Colony split (section 6). The Family page replaces People: no Add/Ignore, just who's here and what they've lent.

## 8. Spending

- **Every model step records its usage:** tokens in and out (and cached), model, provider, whose key paid (a person, or shared), the Bot, and the Bot's owner. Migration: `usage(id, at, bot_id, owner_id, provider_id, payer_id, model, input_tokens, output_tokens, cached_tokens, cost_micros)`; `payer_id` is null for shared keys.
- **Prices per model:** each provider's models carry a price per million tokens in and out (and cached in). Common models come pre-filled from a small built-in table; anyone can edit the prices on their own providers, the host on shared ones. A model with no price counts tokens and shows "no price set".
- **Settings › You › Spending:** your spending this month, per Bot, split into your keys and shared keys, with a 30-day chart.
- **Settings › This Colony › Shared keys** (host): this month's spending on shared keys, by person and by Bot, and an optional **monthly limit per person**.
- **Over the limit:** that person's Bots switch to their own key if they have one; otherwise their next turn on a shared model stops before calling the model and posts "Your share of Andrew's keys is used up for October. Add your own key in Settings to keep going." The person and the host both get a notification. Limits reset on the 1st.
- Turns already running finish; the check happens before each model call, so a turn can go slightly over.

## 9. Handing a Bot over

- In a Bot's profile, its owner picks **Give {Bot} to…** and a family member, and chooses whether its memory goes with it ("Keep its memory", the default, or "Start fresh"). The dialog lists what moves and what stays.
- The recipient gets a card and a push: **Accept / Decline**. Nothing changes until they accept; the giver can cancel while it waits. A declined or cancelled hand-over leaves everything as it was.
- **What moves:** the Bot (persona, skills, routines, its own computer and workspace), and its memory unless "Start fresh" was chosen. Routines keep their schedule but their chat becomes the new owner's chat with the Bot.
- **What stays with the giver:** their chat history with the Bot (archived on their side as "Chat with Luke (now Marija's)", never shown to the recipient); the Bot's access to their accounts (removed); their personal model key (a Bot on one switches to the recipient's default model). Spending before the hand-over stays on the giver's record.
- **Topics:** the Bot stays in the topics it was in, now tagged as the recipient's. If the recipient can't see a topic, the Bot leaves it.
- Migration: `bot_transfers(id, bot_id, from_id, to_id, keep_memory, status, created_at)`.

## 10. Phases

1. **Ownership and visibility.** Migration, `owner_id` everywhere, the visibility rules in `/state`, events, push and the API; Create Bot for everyone; first-run card. Exit check: two logins each make a Bot and can't see each other's.
2. **Models and accounts per person.** Providers in the database with owners; the model picker; accounts owned by whoever connected them; access grants limited to your own Bots.
3. **Approvals to the right person.** `approver_id`, routing, cards and push.
4. **PCs for the family.** Nodes owned by the lender, no per-Bot levels, `pc` parameter, approvals to the PC's owner.
5. **Settings split and Family page; per-person voice.**
6. **Spending.** Usage records, prices, your Spending page, the host's Shared keys page, monthly limits and what happens when one is reached.
7. **Handing a Bot over.** The Give dialog, the accept card, and moving or archiving everything as above.

## 11. Tests

- Visibility: a family member's `/state`, events and push never include another person's Bot chat, account, key or routine.
- A topic member can add only their own Bots.
- Model resolution: a Bot can use shared providers and its owner's, never another person's.
- Approvals: each row of the table in section 5 routes to the right person; another person's approve call gets 403.
- PCs: a family Bot uses another person's PC within its switches; the approval goes to the PC's owner; a switched-off capability is refused.
- Migration: an existing single-user database becomes a family of one with everything owned by the host.
- Spending: each step writes one usage row with the right payer; costs follow the price table; a person over their limit on shared keys falls back to their own key, or is stopped before the model call.
- Hand-over: nothing moves before Accept; after it, the recipient owns the Bot, routines and computer; the giver keeps an archived chat the recipient can't load; account access is gone; "Start fresh" empties MEMORY.md.

## Decisions

1. Logins from outside the tailnet (Tailscale's machine sharing) count as family. `COLONY_ALLOWED_USERS` keeps anyone out; Settings › Family says so.
2. Spending is tracked per person and per Bot, with optional monthly limits on shared keys (section 8).
3. Bots can be handed to another family member (section 9).
