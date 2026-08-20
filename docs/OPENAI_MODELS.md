# Using OpenAI Models

Open-Inspect supports OpenAI Codex models in addition to Anthropic Claude models. This guide covers
how to configure your deployment to use them.

> **Note**: This setup process is temporary and will be streamlined in a future release.

---

## Supported Models

For the full model list, including Claude Fable 5 and other Anthropic models, see
[Available Models](AVAILABLE_MODELS.md).

| Model               | Description               |
| ------------------- | ------------------------- |
| GPT 5.4             | Flagship model            |
| GPT 5.5             | Latest flagship model     |
| GPT 5.3 Codex       | Latest codex variant      |
| GPT 5.3 Codex Spark | Lightweight Codex variant |

OpenAI models support reasoning effort levels: none, low, medium, high, and extra high (default:
high for Codex models).

---

## Setup

There are two ways to pay for OpenAI models. Pick one:

| Credential                                    | Billing                      | Setup                                                |
| --------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| ChatGPT Plus/Pro subscription (managed OAuth) | Included in the subscription | [Steps 1–3](#step-1-obtain-openai-oauth-credentials) |
| OpenAI platform API key                       | Metered, per token           | [Using an API key](#using-an-api-key)                |

### Step 1: Obtain OpenAI OAuth Credentials

You'll use [OpenCode](https://opencode.ai) locally to authenticate with OpenAI and retrieve the
required tokens.

1. Install OpenCode if you haven't already
2. Launch OpenCode:
   ```bash
   opencode
   ```
3. Inside OpenCode, run `/connect setup`
4. Select **ChatGPT** and complete the OAuth login flow in your browser
5. After authenticating, open the credentials file:
   ```bash
   cat ~/.local/share/opencode/auth.json
   ```
6. From the `openai` section, copy the values for:
   - `refresh` — the refresh token
   - `accountId` — your ChatGPT account ID

### Step 2: Add Secrets to Your Deployment

1. Go to your Open-Inspect web app's **Settings** page
2. Add the following repository secrets:

   | Secret Name                  | Value                           |
   | ---------------------------- | ------------------------------- |
   | `OPENAI_OAUTH_REFRESH_TOKEN` | The `refresh` token from Step 1 |
   | `OPENAI_OAUTH_ACCOUNT_ID`    | The `accountId` from Step 1     |

### Step 3: Select an OpenAI Model

When creating a new session, choose any OpenAI model from the model dropdown. Sessions using OpenAI
models will automatically use your configured credentials.

---

## Using an API key

Instead of a ChatGPT subscription, add a single secret on the **Settings** page:

| Secret Name      | Value                                                           |
| ---------------- | --------------------------------------------------------------- |
| `OPENAI_API_KEY` | A key from https://platform.openai.com/api-keys (`sk-proj-...`) |

Global scope makes every session use it; repository or environment scope narrows it to one target.
All OpenAI models in the dropdown — including the Codex variants — are available this way, billed to
the key's project.

**An API key wins over the managed subscription.** When a session can see `OPENAI_API_KEY`, the
control plane skips OAuth broker mode for OpenAI, so the sandbox talks to `api.openai.com` with the
key. The `OPENAI_OAUTH_*` secrets can stay in place; delete the `OPENAI_API_KEY` secret to switch
back to the subscription. The same precedence applies to xAI (`XAI_API_KEY` over SuperGrok OAuth).

Unlike the OAuth path, the key itself is injected into the sandbox environment, because OpenCode
reads `OPENAI_API_KEY` directly.

---

## How It Works (subscription path)

Your refresh token is stored securely in the control plane and is never exposed to sandboxes. When a
sandbox needs to make an OpenAI API call, it requests a short-lived access token from the control
plane, which handles token refresh and rotation automatically. Only the temporary access token is
present inside the sandbox.

Credentials are scoped per repository, so different repos can use different OpenAI accounts. When an
API key takes precedence, none of this applies: no sentinel, no auth proxy plugin, and no token
refresh calls.

---

## Troubleshooting

### Model doesn't appear in the dropdown

Ensure your deployment is up to date. OpenAI model support requires the latest version of
Open-Inspect.

### Session fails to start with an OpenAI model

Verify that both `OPENAI_OAUTH_REFRESH_TOKEN` and `OPENAI_OAUTH_ACCOUNT_ID` are set in your
repository secrets (Settings page). The refresh token may have expired — repeat Step 1 to obtain
fresh credentials.

### "The usage limit has been reached"

The ChatGPT subscription behind `OPENAI_OAUTH_REFRESH_TOKEN` hit its Codex quota. Wait for the quota
window to reset, switch the session to a Claude model, or add an `OPENAI_API_KEY` secret
([Using an API key](#using-an-api-key)) to bill OpenAI usage per token instead.

### "Token refresh failed" errors

The OAuth refresh token may have been revoked or expired. Re-authenticate by repeating Step 1 and
updating the secrets in your Settings page.
