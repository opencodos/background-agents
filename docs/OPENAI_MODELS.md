# Using OpenAI Models

Open-Inspect supports OpenAI Codex models in addition to Anthropic Claude models. This guide covers
how to configure your deployment to use them.

OpenAI subscriptions are managed as installation-wide provider accounts. Sessions and automations
can use the installation default, select a specific account, or explicitly use API-key mode.

---

## Supported Models

See [Available Models — OpenAI](AVAILABLE_MODELS.md#openai) for supported model IDs, reasoning
effort options, and defaults.

Existing sessions and saved bot settings selecting `gpt-5.3-codex` or `gpt-5.3-codex-spark` resolve
to `openai/gpt-6-sol` when used. The retired models are no longer offered in the picker; update
saved defaults and automations to a model available to your account.

---

## Setup

There are three ways to pay for OpenAI models:

| Credentials                                             | Billing                                               | Setup                                                            |
| ------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| A connected ChatGPT account (Plus/Pro)                  | Included in the subscription; fails at its quota      | [Steps 1–3](#step-1-connect-chatgpt)                             |
| `OPENAI_API_KEY`, with **Use API key**                  | Metered, per token                                    | [Step 3](#step-3-select-authentication)                          |
| A connected ChatGPT account + `OPENAI_API_KEY_FALLBACK` | Subscription up to a ceiling you choose, then metered | [Spilling over](#spilling-over-before-the-subscription-runs-out) |

### Step 1: Connect ChatGPT

1. Open **Settings > Provider Accounts**.
2. Choose **Add account > ChatGPT**. Device authorization starts automatically.
3. Use **Open ChatGPT Settings** and enable device code authorization for Codex.
4. Use **Open Device Authorization**, then enter the code shown by Open-Inspect when OpenAI asks for
   it.
5. Keep the dialog open while Open-Inspect waits for authorization. The new account appears after
   OpenAI confirms the connection.

Open-Inspect creates the account as **ChatGPT account** by default. Use **Rename** afterward if you
want a different display name. Provider accounts are shared by all admitted users in this
single-tenant deployment; they are not repository-scoped or private to their creator.

### Step 2: Configure Defaults

In the OpenAI section of **Settings > Provider Accounts**:

1. Choose the **Default account** used when an interactive session follows provider policy.
2. Choose **Unattended mode**:
   - **Use default account** makes Slack, GitHub, Linear, and unpinned automation runs use the
     subscription account.
   - **Use API key** keeps unattended launches on the existing API-key path.

Defaults are resolved when a session starts. Changing them does not move a running session to a
different paid account.

### Step 3: Select Authentication

Choose an OpenAI model when creating a session and use the **OpenAI authentication** selector to
choose provider policy, a specific connected account, or **Use API key**. Account mode overrides
`OPENAI_API_KEY` for that session.

Automation editors expose the same choices for every subscription provider. **Use defaults when each
run starts** resolves current policy for every run; selecting an account or API-key mode pins that
choice for future runs.

---

## Spilling over before the subscription runs out

A ChatGPT subscription that hits its Codex quota fails the session outright:
`Execution failed: The usage limit has been reached...`. Two optional secrets let a deployment keep
working on a per-token key, and cap how much of the subscription sandboxes may take in the first
place:

| Secret Name                       | Value                                                                     |
| --------------------------------- | ------------------------------------------------------------------------- |
| `OPENAI_API_KEY_FALLBACK`         | A platform API key, used only as a spillover                              |
| `OPENAI_SUBSCRIPTION_MAX_PERCENT` | Optional share of a rate-limit window sandboxes may consume (default 100) |

Spillover applies to OpenCode sessions only. Codex harness sessions run the Codex CLI, which never
loads the plugin that implements it, and their environment drops `OPENAI_*` variables other than
`OPENAI_API_KEY`; a Codex harness session on a subscription still fails at its quota.

`OPENAI_API_KEY_FALLBACK` is deliberately a separate name from `OPENAI_API_KEY`: the latter is the
key API-key mode uses, and the control plane strips it from sessions routed to a subscription, while
this one rides along unused until the subscription cannot answer. It works with a connected ChatGPT
account and with legacy `OPENAI_OAUTH_*` secrets alike. Set `OPENAI_SUBSCRIPTION_MAX_PERCENT` to
`80` to reserve the last fifth of each window for whoever else uses that ChatGPT account.

With `OPENAI_API_KEY_FALLBACK` configured, a sandbox sends OpenAI traffic to the subscription until
one of these happens, then latches to a successful fallback path for the rest of its life. Without
that secret nothing below applies — every response is passed through unchanged, including a
usage-limit `429`:

- when `OPENAI_SUBSCRIPTION_MAX_PERCENT` is below `100`, usage is already at or above that ceiling
  before the first turn. The percentage comes from `GET /backend-api/wham/usage`, which reports both
  windows without consuming either
- a Codex response reports either window at or above the ceiling. On a successful response the
  in-flight reply is kept and only the next request moves over, because a started stream cannot be
  replayed
- Codex answers `429` with a quota signal: a recognized primary/secondary
  `x-codex-rate-limit-reached-type`, a specific usage-limit-reached message, or a window at or above
  the ceiling. That request is retried on the fallback key immediately
- the control plane reports that the subscription credential is unusable or requires reconnection.
  Sandbox-auth, transient broker, network, timeout, configuration, and storage failures do not spend
  the fallback key

A plain `429` with no quota signal is passed through untouched, so short-window throttling does not
spend money. Codex tracks a short (roughly 5-hour) and a weekly window, and the higher usage of the
two decides. An unparseable ceiling is ignored with a log line and treated as 100. If the usage
probe fails, the sandbox stays on the subscription and relies on response headers instead.

Requests are sent to the platform with the model unchanged. If the platform refuses the key itself
(`401`), that turn fails once with an error naming `OPENAI_API_KEY_FALLBACK`, and the sandbox stops
using the key: later turns go to the subscription only, as if no key were configured, until a new
session starts with a working key. Any other platform failure, including a `403` (which can refuse
one model or request while the key still serves others), is returned to that turn as the platform
sent it and clears the latch, and the next turn retries the subscription instead of remaining on a
failing paid path; the key stays available for later spillover.

Every switch is logged in the sandbox logs as
`[codex-auth-plugin] spilling OpenAI traffic over to OPENAI_API_KEY_FALLBACK: <reason>`.

The ceiling is a soft bound, and it and the latch are per sandbox, not shared across sessions. Each
request is checked against the latest usage reading and nothing reserves capacity, so concurrent
requests within one sandbox, as well as separate sandboxes on one ChatGPT account, can run past the
ceiling before a response reports it and spillover latches. After a successful spillover, the latch
lasts for the rest of that sandbox's life even if the subscription window resets under it; the next
sandbox measures afresh.

---

## How It Works

The OpenAI device authorization result is encrypted with `PROVIDER_ACCOUNTS_ENCRYPTION_KEY` in the
control plane and is never exposed to the browser or sandboxes. A session stores the selected
account ID, not credential material. When the sandbox needs OpenAI access, its runtime plugin calls
the sandbox-authenticated `POST /sessions/:id/provider-auth/openai/access-token` endpoint. The
control plane refreshes and rotates the account credential and returns only short-lived access
material.

Children inherit their parent's pinned provider authentication. Disabling or archiving an account
blocks future broker calls, but an access token already issued to a running sandbox remains usable
until it expires.

## Deployment and Coexistence

Legacy scoped OAuth and provider accounts can coexist. Existing sessions retain their legacy
binding. Add and verify provider accounts at any time, then set a provider default when new sessions
should use that account. Defaults never move existing sessions. The settings page lists remaining
legacy OAuth key locations; remove them only after dependent legacy-bound sessions are no longer
needed. Older manually provisioned credentials continue to work, but new ChatGPT accounts should use
the first-party device authorization flow in Settings. Do not copy the same rotating refresh token
into both credential systems.

---

## Troubleshooting

### Model doesn't appear in the dropdown

Ensure your deployment is up to date. OpenAI model support requires the latest version of
Open-Inspect.

### Session fails to start with an OpenAI model

Confirm that the selected/default OpenAI account is active and the account is verified. If the
session explicitly uses API-key mode, confirm `OPENAI_API_KEY` is available in its secret scope.

### "The usage limit has been reached"

The ChatGPT subscription hit its Codex quota. Wait for the window to reset, switch the session to
another provider's model, or configure a spillover key
([Spilling over](#spilling-over-before-the-subscription-runs-out)) so OpenCode sessions continue on
metered billing.

### "Token refresh failed" errors

The OAuth grant may have been revoked, expired, or rotated elsewhere. Use **Reconnect** on the
existing account and complete the same device authorization flow. Reconnect preserves the account's
display name and must authenticate the same OpenAI account identity; connect a new provider account
if the identity changed.
