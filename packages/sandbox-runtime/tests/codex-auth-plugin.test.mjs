import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

const PLUGIN_PATH = "../src/sandbox_runtime/plugins/codex-auth-plugin.js";
const MODEL_REQUEST_URL = "https://api.openai.com/v1/responses";
const REQUEST_INIT = {
  method: "POST",
  body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
  headers: { authorization: "Bearer opencode-oauth-dummy-key", originator: "opencode" },
};

process.env.CONTROL_PLANE_URL = "https://control.test";
process.env.SANDBOX_AUTH_TOKEN = "sandbox-token";
process.env.SESSION_CONFIG = JSON.stringify({ sessionId: "session-1" });
delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;

/**
 * Load a fresh copy of the plugin. The spillover latch is module state, so each
 * case needs its own instance.
 */
async function loadProxy(tag) {
  const { CodexAuthProxy } = await import(`${PLUGIN_PATH}?case=${tag}`);
  const plugin = await CodexAuthProxy({ client: { auth: { set: async () => {} } } });
  return plugin.auth.loader(async () => ({ type: "oauth", refresh: "managed-by-control-plane" }), {
    models: { "gpt-5.4": { cost: {} } },
  });
}

/**
 * Route stubbed traffic by path: the control-plane broker always mints a token
 * unless `broker` overrides it, the usage endpoint answers with `usage`, the
 * Codex backend with `codex`, and the two platform generation endpoints with
 * `platform` (success by default). `other` answers any further destination a
 * case names explicitly. Any other destination, and any route whose
 * stub the case did not supply, is recorded and fails the case afterwards
 * rather than being answered with a convenient 200.
 */
const PLATFORM_ENDPOINTS = new Set([
  "https://api.openai.com/v1/responses",
  "https://api.openai.com/v1/chat/completions",
]);
let unexpectedCalls = [];

afterEach(() => {
  const unexpected = unexpectedCalls;
  unexpectedCalls = [];
  assert.deepEqual(unexpected, [], "every outbound call reaches a stubbed route");
});

function unexpectedCall(target) {
  unexpectedCalls.push(target);
  return new Response(`unexpected call to ${target}`, { status: 599 });
}

function stubFetch({ codex, broker, usage, platform, other } = {}) {
  const calls = [];
  unexpectedCalls = [];
  globalThis.fetch = async (url, init) => {
    // A non-generation call is dispatched as a Request so its own options
    // survive, so the stub must read either shape.
    const request = url instanceof Request ? url : null;
    const target = request ? request.url : String(url);
    calls.push({
      url: target,
      method: init?.method ?? request?.method,
      headers: new Headers(init?.headers ?? request?.headers),
      body: init?.body,
      signal: init?.signal ?? request?.signal,
      init: init ?? {},
      request,
    });
    if (target === "https://control.test/sessions/session-1/provider-auth/openai/access-token") {
      return (
        broker?.() ??
        Response.json({
          accessToken: "cp-access",
          expiresIn: 3600,
          providerMetadata: { accountId: "acct-1" },
        })
      );
    }
    if (target === "https://chatgpt.com/backend-api/wham/usage") {
      return usage ? usage(init) : unexpectedCall(target);
    }
    if (target === "https://chatgpt.com/backend-api/codex/responses") {
      return codex ? codex(calls.length) : unexpectedCall(target);
    }
    if (PLATFORM_ENDPOINTS.has(target)) {
      return platform?.(target, init) ?? new Response("platform-ok", { status: 200 });
    }
    return other ? other(target, init) : unexpectedCall(target);
  };
  return calls;
}

const usageResponse = (primary, secondary) =>
  Response.json({
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: primary, limit_window_seconds: 18000, reset_at: 1 },
      secondary_window: { used_percent: secondary, limit_window_seconds: 604800, reset_at: 2 },
    },
  });

const usageLimitResponse = () =>
  new Response(JSON.stringify({ error: { message: "The usage limit has been reached" } }), {
    status: 429,
    headers: { "x-codex-rate-limit-reached-type": "secondary" },
  });

test("spills over to the platform API on a usage-limit 429, then latches", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("latch");

  const first = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "platform-ok");

  const subscriptionCall = calls.find((call) => call.url.startsWith("https://chatgpt.com/"));
  assert.equal(subscriptionCall.headers.get("authorization"), "Bearer cp-access");
  assert.equal(subscriptionCall.headers.get("chatgpt-account-id"), "acct-1");

  const spilloverCall = calls.at(-1);
  assert.equal(spilloverCall.url, MODEL_REQUEST_URL);
  assert.equal(spilloverCall.headers.get("authorization"), "Bearer sk-fallback");
  assert.equal(spilloverCall.headers.get("chatgpt-account-id"), null);
  assert.equal(spilloverCall.headers.get("originator"), null);
  assert.equal(spilloverCall.body, REQUEST_INIT.body);

  // Latched: the second turn must not retry the exhausted subscription.
  const before = calls.length;
  await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.deepEqual(
    calls.slice(before).map((call) => call.url),
    [MODEL_REQUEST_URL]
  );
});

test("retries the subscription after a failed platform spillover", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  let platformCalls = 0;
  const calls = stubFetch({
    codex: () => usageLimitResponse(),
    platform: () =>
      ++platformCalls === 1
        ? new Response("platform unavailable", { status: 503 })
        : new Response("platform-ok", { status: 200 }),
  });
  const loaded = await loadProxy("fallback-failure");

  assert.equal((await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).status, 503);
  const before = calls.length;
  assert.equal((await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).status, 200);
  assert.ok(
    calls.slice(before).some((call) => call.url.startsWith("https://chatgpt.com/")),
    "the subscription is retried after a failed platform request"
  );
});

test("keeps the Chat Completions contract when spilling over", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("chat-completions");

  const chatUrl = "https://api.openai.com/v1/chat/completions";
  const chatInit = {
    ...REQUEST_INIT,
    body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }),
  };
  const response = await loaded.fetch(chatUrl, chatInit);
  assert.equal(response.status, 200);

  // A Chat Completions body is not a Responses body, so the spillover must not
  // rewrite the path to /v1/responses.
  const spilloverCall = calls.at(-1);
  assert.equal(spilloverCall.url, chatUrl);
  assert.equal(spilloverCall.headers.get("authorization"), "Bearer sk-fallback");
  assert.equal(spilloverCall.body, chatInit.body);
});

test("passes a throttling 429 through without spending the fallback key", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("slow down", { status: 429 }),
  });
  const loaded = await loadProxy("throttle");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), "slow down");
  assert.equal(
    calls.filter((call) => call.url === MODEL_REQUEST_URL).length,
    0,
    "no platform-API call for a transient throttle"
  );
});

test("does not treat generic quota wording as subscription exhaustion", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("temporary quota throttle", { status: 429 }),
  });
  const loaded = await loadProxy("quota-wording");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);

  assert.equal(response.status, 429);
  assert.equal(await response.text(), "temporary quota throttle");
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("leaves a usage-limit 429 alone when no fallback key is configured", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("no-key");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(response.status, 429);
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("spills over when the control plane cannot mint a subscription token", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () =>
      Response.json({ error: "reconnect required", code: "reconnect_required" }, { status: 409 }),
  });
  const loaded = await loadProxy("broker-down");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await response.text(), "platform-ok");
  assert.equal(calls.filter((call) => call.url.startsWith("https://chatgpt.com/")).length, 0);
  assert.equal(calls.at(-1).headers.get("authorization"), "Bearer sk-fallback");
});

test("spills over when the bound provider account is gone", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  // This one answers 404 rather than 409, and no retry can bring the account
  // back, so it belongs on the permanent side with the reconnect cases.
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () =>
      Response.json(
        { error: "Provider account not found", code: "account_not_found" },
        { status: 404 }
      ),
  });
  const loaded = await loadProxy("broker-account-gone");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await response.text(), "platform-ok");
  assert.equal(calls.at(-1).headers.get("authorization"), "Bearer sk-fallback");
});

test("does not spend the fallback key on a transient broker failure", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () => new Response("temporarily unavailable", { status: 503 }),
  });
  const loaded = await loadProxy("broker-transient");

  await assert.rejects(
    loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT),
    /OpenAI token refresh failed \(503\)/
  );
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("does not spend the fallback key on transient exchange contention", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  // The control plane answers 409 for a credential that needs reconnection and
  // for exchange contention alike, so only its own code separates them.
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () =>
      Response.json(
        { error: "openai credential exchange did not complete", code: "exchange_busy" },
        { status: 409 }
      ),
  });
  const loaded = await loadProxy("broker-exchange-busy");

  await assert.rejects(
    loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT),
    /OpenAI token refresh failed \(409\)/
  );
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("does not spend the fallback key on a 409 that carries no code", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () => new Response("conflict", { status: 409 }),
  });
  const loaded = await loadProxy("broker-409-no-code");

  await assert.rejects(
    loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT),
    /OpenAI token refresh failed \(409\)/
  );
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("does not spend the fallback key when sandbox authentication is rejected", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () => new Response("invalid sandbox token", { status: 401 }),
  });
  const loaded = await loadProxy("broker-sandbox-auth");

  await assert.rejects(
    loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT),
    /OpenAI token refresh failed \(401\)/
  );
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("keeps a Request-shaped call intact when the subscription token fails", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () => new Response("unreachable", { status: 500 }),
    broker: () =>
      Response.json({ error: "reconnect required", code: "reconnect_required" }, { status: 409 }),
  });
  const loaded = await loadProxy("request-input-token");

  // A Request carries its own method and body; an absent init must not turn the
  // spillover retry into a bodiless GET.
  const response = await loaded.fetch(new Request(MODEL_REQUEST_URL, REQUEST_INIT));
  assert.equal(await response.text(), "platform-ok");

  const spilloverCall = calls.at(-1);
  assert.equal(spilloverCall.url, MODEL_REQUEST_URL);
  assert.equal(spilloverCall.method, "POST");
  assert.equal(spilloverCall.body, REQUEST_INIT.body);
  assert.equal(spilloverCall.headers.get("authorization"), "Bearer sk-fallback");
});

test("spills over a Request-shaped call on a usage-limit 429", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("request-input-429");

  const response = await loaded.fetch(new Request(MODEL_REQUEST_URL, REQUEST_INIT));
  assert.equal(await response.text(), "platform-ok");

  const subscriptionCall = calls.find((call) => call.url.startsWith("https://chatgpt.com/"));
  assert.equal(subscriptionCall.method, "POST");
  assert.equal(subscriptionCall.body, REQUEST_INIT.body);

  // Retrying a 429 needs the body in hand, which a live Request stream cannot give.
  const spilloverCall = calls.at(-1);
  assert.equal(spilloverCall.url, MODEL_REQUEST_URL);
  assert.equal(spilloverCall.body, REQUEST_INIT.body);
  assert.equal(spilloverCall.headers.get("authorization"), "Bearer sk-fallback");
});

test("forwards a Request's abort signal to both legs", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("request-input-signal");

  const controller = new AbortController();
  const request = new Request(MODEL_REQUEST_URL, { ...REQUEST_INIT, signal: controller.signal });
  await loaded.fetch(request);

  // `new Request(url, { signal })` exposes a dependent signal rather than the
  // one passed in, so cancellation, not identity, is what must survive.
  const subscriptionCall = calls.find((call) => call.url.startsWith("https://chatgpt.com/"));
  const spilloverCall = calls.at(-1);
  assert.ok(subscriptionCall.signal, "subscription call carries a signal");
  assert.ok(spilloverCall.signal, "spillover call carries a signal");
  assert.equal(subscriptionCall.signal.aborted, false);
  controller.abort();
  assert.equal(subscriptionCall.signal.aborted, true);
  assert.equal(spilloverCall.signal.aborted, true);
});

test("latches on exhausted usage headers reported by a successful call", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-secondary-used-percent": "100" },
      }),
  });
  const loaded = await loadProxy("headers");

  const first = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await first.text(), "codex-ok", "the in-flight call is never discarded");

  const before = calls.length;
  const second = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await second.text(), "platform-ok");
  assert.deepEqual(
    calls.slice(before).map((call) => call.url),
    [MODEL_REQUEST_URL]
  );
});

test("spills over before touching the subscription when usage is over the ceiling", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  const calls = stubFetch({
    codex: () => new Response("codex-should-not-be-called", { status: 200 }),
    usage: () => usageResponse(42, 85),
  });
  const loaded = await loadProxy("ceiling-over");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await response.text(), "platform-ok");

  const probe = calls.find((call) => call.url.includes("/wham/usage"));
  assert.equal(probe.headers.get("authorization"), "Bearer cp-access");
  assert.equal(probe.headers.get("chatgpt-account-id"), "acct-1");
  assert.equal(
    calls.filter((call) => call.url.includes("/codex/responses")).length,
    0,
    "no subscription turn is spent past the ceiling"
  );
});

test("keeps the subscription while usage is under the ceiling", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-secondary-used-percent": "50" },
      }),
    usage: () => usageResponse(40, 50),
  });
  const loaded = await loadProxy("ceiling-under");

  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(
    calls.filter((call) => call.url.includes("/wham/usage")).length,
    1,
    "the usage endpoint is probed once per sandbox"
  );
  assert.equal(calls.filter((call) => call.url === MODEL_REQUEST_URL).length, 0);
});

test("stops waiting on the ceiling probe when the caller aborts", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";

  // The probe is shared, so the caller's signal is deliberately not forwarded
  // into it. A cancelled turn must therefore stop waiting on its own rather
  // than hang until USAGE_PROBE_TIMEOUT_MS.
  let probeStarted;
  const probeReached = new Promise((resolve) => (probeStarted = resolve));
  stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    usage: () =>
      new Promise(() => {
        probeStarted();
      }),
  });
  const loaded = await loadProxy("probe-abort");

  const controller = new AbortController();
  const request = new Request(MODEL_REQUEST_URL, { ...REQUEST_INIT, signal: controller.signal });
  const pending = loaded.fetch(request);

  await probeReached;
  controller.abort();

  let stall;
  const outcome = await Promise.race([
    pending.then(
      () => "settled",
      () => "settled"
    ),
    new Promise((resolve) => (stall = setTimeout(() => resolve("blocked"), 500))),
  ]);
  clearTimeout(stall);
  assert.equal(outcome, "settled", "the turn does not wait out the probe timeout");
});

test("holds a concurrent request behind the pending ceiling probe", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";

  // The preflight only counts as spent once it answers. A second request
  // arriving while it is in flight must wait for the same answer instead of
  // spending a subscription turn above the ceiling being measured.
  let releaseProbe;
  let probeStarted;
  const probeReached = new Promise((resolve) => (probeStarted = resolve));
  const calls = stubFetch({
    codex: () => new Response("codex-should-not-be-called", { status: 200 }),
    usage: () =>
      new Promise((resolve) => {
        probeStarted();
        releaseProbe = () => resolve(usageResponse(42, 85));
      }),
  });
  const loaded = await loadProxy("probe-shared");

  const first = loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  await probeReached;
  const second = loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    calls.filter((call) => call.url.includes("/codex/responses")).length,
    0,
    "no turn is spent while the ceiling is still unknown"
  );

  releaseProbe();
  assert.equal(await (await first).text(), "platform-ok");
  assert.equal(await (await second).text(), "platform-ok");
  assert.equal(
    calls.filter((call) => call.url.includes("/wham/usage")).length,
    1,
    "both requests share one probe"
  );
  assert.equal(calls.filter((call) => call.url.includes("/codex/responses")).length, 0);
});

test("keeps a measurement whose only waiter walked away", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";

  let releaseProbe;
  let probeStarted;
  const probeReached = new Promise((resolve) => (probeStarted = resolve));
  const calls = stubFetch({
    codex: () => new Response("codex-should-not-be-called", { status: 200 }),
    usage: () =>
      new Promise((resolve) => {
        probeStarted();
        releaseProbe = () => resolve(usageResponse(42, 85));
      }),
  });
  const loaded = await loadProxy("probe-result-retained");

  const controller = new AbortController();
  const abandoned = loaded.fetch(
    new Request(MODEL_REQUEST_URL, { ...REQUEST_INIT, signal: controller.signal })
  );
  await probeReached;
  controller.abort();
  await abandoned.catch(() => {});

  // The probe answers after its only waiter gave up. Discarding that 85%
  // would send the next request over the 80% ceiling.
  releaseProbe();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const before = calls.length;
  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await response.text(), "platform-ok");
  assert.equal(
    calls.slice(before).filter((call) => call.url.includes("/codex/responses")).length,
    0,
    "no subscription turn is spent above the measured ceiling"
  );
  assert.equal(
    calls.slice(before).filter((call) => call.url.includes("/wham/usage")).length,
    0,
    "the retained measurement is reused rather than re-probed"
  );
});

test("retries the subscription after a fallback chosen by the preflight fails", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  let platformOk = false;
  const calls = stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    usage: () => usageResponse(42, 85),
    platform: () =>
      platformOk
        ? new Response("platform-ok", { status: 200 })
        : new Response("platform down", { status: 503 }),
  });
  const loaded = await loadProxy("preflight-fallback-recovery");

  const first = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(first.status, 503, "the preflight sent this turn to a failing platform");

  // Clearing only the latch is not enough: the retained 85% measurement would
  // pick the platform again and never give the subscription a turn.
  platformOk = true;
  const before = calls.length;
  const second = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await second.text(), "codex-ok");
  assert.equal(
    calls.slice(before).filter((call) => call.url.startsWith("https://chatgpt.com/")).length,
    1,
    "the subscription is retried"
  );
});

test("inherits the source body when an init passes a null body", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ codex: () => new Response("codex-ok", { status: 200 }) });
  const loaded = await loadProxy("null-body-override");

  // native new Request(source, { body: null }) inherits the source body, so a
  // null must not turn a valid POST into a bodiless call.
  await loaded.fetch(new Request(MODEL_REQUEST_URL, REQUEST_INIT), { body: null });

  const call = calls.find((entry) => entry.url.startsWith("https://chatgpt.com/"));
  assert.equal(call.body, REQUEST_INIT.body, "the source body reaches the subscription");
});

test("ignores init members whose value is undefined", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("undefined-init-members");

  // The shape an object spread produces: keys present, values undefined.
  // Request construction ignores those, so they must not erase the source's.
  const request = new Request(MODEL_REQUEST_URL, {
    ...REQUEST_INIT,
    redirect: "manual",
    credentials: "include",
    cache: "no-store",
  });
  await loaded.fetch(request, {
    redirect: undefined,
    credentials: undefined,
    cache: undefined,
  });

  for (const call of [
    calls.find((entry) => entry.url.startsWith("https://chatgpt.com/")),
    calls.at(-1),
  ]) {
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.credentials, "include");
    assert.equal(call.init.cache, "no-store");
  }
});

test("re-measures the ceiling after a recovered turn", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  let platformOk = false;
  const calls = stubFetch({
    // Header-less Codex replies, so the ceiling can only be enforced by the
    // preflight: if the recovery leaves it spent, it is off for good.
    codex: () => new Response("codex-ok", { status: 200 }),
    usage: () => usageResponse(42, 95),
    platform: () =>
      platformOk
        ? new Response("platform-ok", { status: 200 })
        : new Response("platform down", { status: 503 }),
  });
  const loaded = await loadProxy("ceiling-rearm");

  assert.equal((await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).status, 503);

  // Exactly one turn is allowed past the ceiling, to find out whether the
  // subscription answers at all.
  platformOk = true;
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");

  const before = calls.length;
  const third = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await third.text(), "platform-ok");
  assert.equal(
    calls.slice(before).filter((call) => call.url.includes("/wham/usage")).length,
    1,
    "the ceiling is measured again"
  );
  assert.equal(
    calls.slice(before).filter((call) => call.url.includes("/codex/responses")).length,
    0,
    "95% against an 80% ceiling still reserves the window"
  );
});

test("a late fallback failure does not undo a newer successful latch", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";

  // Two requests share one 85% preflight against an 80% ceiling, so both go
  // straight to the platform. The first succeeds and latches; the second fails
  // afterwards and must not send the next turn back to a subscription the
  // first one is already standing in for.
  let platformCall = 0;
  let releaseSecond;
  const secondReleased = new Promise((resolve) => (releaseSecond = resolve));
  const calls = stubFetch({
    codex: () => new Response("codex-should-not-be-called", { status: 200 }),
    usage: () => usageResponse(42, 85),
    platform: async () => {
      platformCall += 1;
      if (platformCall === 1) return new Response("platform-ok", { status: 200 });
      if (platformCall === 2) {
        await secondReleased;
        return new Response("platform down", { status: 503 });
      }
      return new Response("platform-ok", { status: 200 });
    },
  });
  const loaded = await loadProxy("late-failure-race");

  const first = loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  const second = loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await (await first).text(), "platform-ok", "the first fallback latches");
  releaseSecond();
  assert.equal((await second).status, 503);

  const before = calls.length;
  const third = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await third.text(), "platform-ok");
  assert.equal(
    calls.slice(before).filter((call) => call.url.includes("/codex/responses")).length,
    0,
    "the newer successful latch still holds"
  );
});

test("detaches from the source Request when the caller passes a null signal", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("null-signal-detach");

  // Native fetch(request, { signal: null }) detaches, so aborting the source
  // must not reach either reconstructed leg.
  const controller = new AbortController();
  const request = new Request(MODEL_REQUEST_URL, { ...REQUEST_INIT, signal: controller.signal });
  await loaded.fetch(request, { signal: null });
  controller.abort();

  for (const call of [
    calls.find((entry) => entry.url.startsWith("https://chatgpt.com/")),
    calls.at(-1),
  ]) {
    assert.equal(call.signal, undefined, "no signal is attached to the call");
  }
});

test("an init header set replaces the source Request's headers", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  const calls = stubFetch({ codex: () => new Response("codex-ok", { status: 200 }) });
  const loaded = await loadProxy("header-replacement");

  // Native fetch(request, { headers }) replaces rather than merges, so a
  // caller dropping authorization must not have the Request's value survive.
  const request = new Request(MODEL_REQUEST_URL, {
    ...REQUEST_INIT,
    headers: { authorization: "Bearer caller-secret", "x-keep": "no" },
  });
  await loaded.fetch(request, { headers: { "x-replaced": "yes" } });

  const call = calls.find((entry) => entry.url.startsWith("https://chatgpt.com/"));
  assert.equal(call.headers.get("x-replaced"), "yes");
  assert.equal(call.headers.get("x-keep"), null, "the Request's headers are not merged in");
  assert.equal(
    call.headers.get("authorization"),
    "Bearer cp-access",
    "the subscription credential replaces the caller's, not the Request's"
  );
});

test("a spillover drops entity headers that described the original body", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const body = JSON.stringify({ model: "gpt-5.4", input: "hi" });
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("entity-headers");

  await loaded.fetch(MODEL_REQUEST_URL, {
    method: "POST",
    body,
    headers: {
      authorization: "Bearer opencode-oauth-dummy-key",
      "content-length": String(Buffer.byteLength(body)),
      "content-encoding": "identity",
    },
  });

  const spilloverCall = calls.at(-1);
  assert.equal(spilloverCall.headers.get("authorization"), "Bearer sk-fallback");
  assert.equal(spilloverCall.body, body);
  assert.equal(
    spilloverCall.headers.get("content-length"),
    null,
    "fetch sizes the buffered body itself"
  );
  assert.equal(spilloverCall.headers.get("content-encoding"), null);
});

test("never spends the fallback key on a non-generation request", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  let latched = false;
  const calls = stubFetch({
    codex: () => (latched ? new Response("codex-ok", { status: 200 }) : usageLimitResponse()),
    other: () => new Response("retrieved", { status: 200 }),
  });
  const loaded = await loadProxy("non-generation-latched");

  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "platform-ok");
  latched = true;

  // Retrieving an earlier response is not a generation call, so even a latched
  // sandbox sends it to its own URL on the subscription's credential rather than
  // replaying it on the paid key or rewriting it to the Codex endpoint.
  const before = calls.length;
  const response = await loaded.fetch("https://api.openai.com/v1/responses/resp_123", {
    method: "GET",
  });
  assert.equal(await response.text(), "retrieved");
  const sent = calls.slice(before).filter((call) => !call.url.startsWith("https://control.test/"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.openai.com/v1/responses/resp_123");
  assert.equal(sent[0].method, "GET");
  assert.equal(sent[0].headers.get("authorization"), "Bearer cp-access");
});

test("with a fallback key, a lookalike of a generation path is not one", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ other: () => new Response("lookalike", { status: 200 }) });
  const loaded = await loadProxy("non-generation-lookalike");

  const response = await loaded.fetch("https://api.openai.com/v1/chat/completionsXYZ", {
    method: "POST",
    body: "{}",
  });
  assert.equal(await response.text(), "lookalike");
  const sent = calls.filter((call) => !call.url.startsWith("https://control.test/"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.openai.com/v1/chat/completionsXYZ");
  assert.equal(sent[0].headers.get("authorization"), "Bearer cp-access");
});

test("with a fallback key, a non-generation call drops an inherited account id", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({
    broker: () => Response.json({ accessToken: "cp-access", expiresIn: 3600 }),
    other: () => new Response("retrieved", { status: 200 }),
  });
  const loaded = await loadProxy("non-generation-stale-account");

  // The broker answered without an account id, so a copied header would send
  // this token against someone else's account.
  await loaded.fetch("https://api.openai.com/v1/responses/resp_123", {
    method: "GET",
    headers: {
      authorization: "Bearer opencode-oauth-dummy-key",
      "chatgpt-account-id": "acct-stale",
    },
  });
  const call = calls.at(-1);
  assert.equal(call.url, "https://api.openai.com/v1/responses/resp_123");
  assert.equal(call.headers.get("authorization"), "Bearer cp-access");
  assert.equal(call.headers.get("chatgpt-account-id"), null);
});

test("with a fallback key, a non-generation call keeps fetch's own timeout", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ other: () => new Response("retrieved", { status: 200 }) });
  const loaded = await loadProxy("non-generation-timeout");

  // No generation stream here, so OpenCode's stream timeout does not bound it:
  // disabling Bun's idle timer would let a stalled call hang forever.
  await loaded.fetch("https://api.openai.com/v1/responses/resp_123", { method: "GET" });
  const call = calls.at(-1);
  assert.equal(call.url, "https://api.openai.com/v1/responses/resp_123");
  assert.notEqual(call.init.timeout, false);
});

// Pins upstream's subscription proxy, which the no-key path keeps byte for byte:
// its substring match rewrites these to the Codex endpoint with Bun's idle timer
// off, and keeps an inherited account id when the broker returns none.
test("without a fallback key, non-generation calls take upstream's proxy as is", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    broker: () => Response.json({ accessToken: "cp-access", expiresIn: 3600 }),
  });
  const loaded = await loadProxy("no-key-non-generation");

  await loaded.fetch("https://api.openai.com/v1/responses/resp_123", {
    method: "GET",
    headers: { "chatgpt-account-id": "acct-stale" },
  });
  await loaded.fetch("https://api.openai.com/v1/chat/completionsXYZ", {
    method: "POST",
    body: "{}",
  });
  const sent = codexCalls(calls);
  assert.equal(sent.length, 2);
  for (const call of sent) {
    assert.deepEqual(call.init, { timeout: false });
    assert.equal(call.headers.get("authorization"), "Bearer cp-access");
  }
  assert.equal(sent[0].headers.get("chatgpt-account-id"), "acct-stale");
});

test("a fallback that cannot be sent releases the latch", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  let platformReachable = true;
  const calls = stubFetch({
    codex: () => usageLimitResponse(),
    platform: () => {
      if (platformReachable) return new Response("platform-ok", { status: 200 });
      throw new TypeError("fetch failed");
    },
  });
  const loaded = await loadProxy("fallback-transport-reject");

  const latched = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(await latched.text(), "platform-ok", "the sandbox is now latched");

  // A transport rejection never reaches a status check, so without releasing
  // the latch the sandbox would keep dialling a paid path that cannot answer.
  platformReachable = false;
  await assert.rejects(loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT), /fetch failed/);

  platformReachable = true;
  const before = calls.length;
  await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(
    calls.slice(before).filter((call) => call.url.startsWith("https://chatgpt.com/")).length,
    1,
    "the subscription is retried instead of the failing paid path"
  );
});

test("dispatches a non-generation Request without reshaping it", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    other: () => new Response("files-ok", { status: 200 }),
  });
  const loaded = await loadProxy("passthrough-request");

  // Flattening this would UTF-8-decode the body and drop Request-level
  // options, so the call would stop being equivalent to fetch(request).
  const body = new Uint8Array([0xff, 0x00, 0x10]);
  const request = new Request("https://api.openai.com/v1/files", {
    method: "POST",
    body,
    redirect: "manual",
    headers: { authorization: `Bearer ${"opencode-oauth-dummy-key"}`, "x-custom": "kept" },
  });
  await loaded.fetch(request);

  const call = calls.at(-1);
  assert.ok(call.request, "the original Request shape is dispatched");
  assert.equal(call.request.redirect, "manual", "Request-level options survive");
  assert.equal(call.request.headers.get("x-custom"), "kept");
  assert.equal(call.request.headers.get("authorization"), "Bearer cp-access");
  const sent = new Uint8Array(await call.request.arrayBuffer());
  assert.deepEqual([...sent], [...body], "the body bytes are untouched");
});

test("cancels a stalled streaming body when the caller aborts", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  stubFetch({ codex: () => new Response("codex-ok", { status: 200 }) });
  const loaded = await loadProxy("stalled-body-abort");

  // A body that never completes must not keep the buffering await pending, and
  // settling alone is not enough: the producer has to be told to stop, or it
  // keeps being drained by a read nobody is waiting for any more.
  let cancelled;
  let pulled;
  const producerCancelled = new Promise((resolve) => (cancelled = resolve));
  const producerPulled = new Promise((resolve) => (pulled = resolve));
  const controller = new AbortController();
  const body = new ReadableStream({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('{"model":"gpt-5.4","input":"'));
    },
    // Reached once the first chunk has been consumed, so the abort below
    // lands while the read loop is waiting rather than before it starts.
    pull() {
      pulled();
      return new Promise(() => {});
    },
    cancel() {
      cancelled();
    },
  });
  const request = new Request(MODEL_REQUEST_URL, {
    method: "POST",
    body,
    duplex: "half",
    signal: controller.signal,
  });
  const pending = loaded.fetch(request);

  await producerPulled;
  let stall;
  controller.abort();
  const outcome = await Promise.race([
    pending.then(
      () => "settled",
      () => "settled"
    ),
    new Promise((resolve) => (stall = setTimeout(() => resolve("blocked"), 500))),
  ]);
  clearTimeout(stall);
  assert.equal(outcome, "settled", "the turn does not hang on a body that never arrives");

  let cancelStall;
  const producerOutcome = await Promise.race([
    producerCancelled.then(() => "cancelled"),
    new Promise((resolve) => (cancelStall = setTimeout(() => resolve("still draining"), 500))),
  ]);
  clearTimeout(cancelStall);
  assert.equal(producerOutcome, "cancelled", "the stream producer is told to stop");
});

test("carries every Request-level option onto the reconstructed legs", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("request-option-carry");

  await loaded.fetch(
    new Request(MODEL_REQUEST_URL, {
      ...REQUEST_INIT,
      keepalive: true,
      referrer: "https://referrer.test/page",
      referrerPolicy: "origin",
      redirect: "manual",
    })
  );

  for (const call of [
    calls.find((entry) => entry.url.startsWith("https://chatgpt.com/")),
    calls.at(-1),
  ]) {
    assert.equal(call.init.keepalive, true);
    assert.equal(call.init.referrer, "https://referrer.test/page");
    assert.equal(call.init.referrerPolicy, "origin");
    assert.equal(call.init.redirect, "manual");
  }
});

test("never pairs a fresh token with an inherited account id", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    broker: () => Response.json({ accessToken: "cp-access", expiresIn: 3600 }),
  });
  const loaded = await loadProxy("stale-account-header");

  // The broker answered without an account id, so a copied header would send
  // this token against someone else's account.
  const headers = {
    authorization: "Bearer opencode-oauth-dummy-key",
    "chatgpt-account-id": "acct-stale",
  };
  await loaded.fetch(MODEL_REQUEST_URL, { ...REQUEST_INIT, headers });
  assert.equal(calls.at(-1).headers.get("chatgpt-account-id"), null);
});

test("latches at the ceiling from a successful response's headers", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-primary-used-percent": "80.4" },
      }),
    usage: () => usageResponse(10, 10),
  });
  const loaded = await loadProxy("ceiling-headers");

  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  const before = calls.length;
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "platform-ok");
  assert.deepEqual(
    calls.slice(before).map((call) => call.url),
    [MODEL_REQUEST_URL]
  );
});

test("ignores a malformed ceiling and spends the whole subscription", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "eighty";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-secondary-used-percent": "85" },
      }),
    usage: () => usageResponse(85, 85),
  });
  const loaded = await loadProxy("ceiling-invalid");

  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(calls.filter((call) => call.url.includes("/wham/usage")).length, 0);
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
});

test("rejects a partially numeric ceiling", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80garbage";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-secondary-used-percent": "85" },
      }),
    usage: () => usageResponse(85, 85),
  });
  const loaded = await loadProxy("ceiling-suffix");

  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(calls.filter((call) => call.url.includes("/wham/usage")).length, 0);
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
});

test("stays on the subscription when the usage probe fails", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  const calls = stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    usage: () => new Response("boom", { status: 500 }),
  });
  const loaded = await loadProxy("probe-failure");

  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(calls.filter((call) => call.url.includes("/codex/responses")).length, 1);
});

const platformCalls = (calls) => calls.filter((call) => PLATFORM_ENDPOINTS.has(call.url));
const codexCalls = (calls) =>
  calls.filter((call) => call.url === "https://chatgpt.com/backend-api/codex/responses");

test("without a fallback key, requests and responses pass through unchanged", async () => {
  delete process.env.OPENAI_API_KEY_FALLBACK;
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "50";
  const codexResponse = usageLimitResponse();
  const calls = stubFetch({ codex: () => codexResponse });
  const loaded = await loadProxy("no-key-passthrough");

  const body = new Uint8Array([0xff, 0x00, 0x7b]);
  const response = await loaded.fetch(MODEL_REQUEST_URL, {
    method: "POST",
    body,
    redirect: "manual",
    headers: [
      ["authorization", "Bearer opencode-oauth-dummy-key"],
      ["x-repeated", "a"],
      ["x-repeated", "b"],
      ["content-type", "application/json"],
    ],
  });

  assert.equal(response, codexResponse, "the subscription's response object itself is returned");
  const [call] = codexCalls(calls);
  assert.ok(call.request, "the request is forwarded as a Request, as before spillover existed");
  assert.deepEqual(call.init, { timeout: false });
  assert.equal(call.request.method, "POST");
  assert.equal(call.request.redirect, "manual");
  assert.equal(call.request.headers.get("x-repeated"), "a, b");
  assert.equal(call.request.headers.get("authorization"), "Bearer cp-access");
  assert.equal(call.request.headers.get("chatgpt-account-id"), "acct-1");
  assert.deepEqual([...new Uint8Array(await call.request.arrayBuffer())], [...body]);
  assert.equal(platformCalls(calls).length, 0);
  assert.equal(
    calls.filter((entry) => entry.url.includes("/wham/usage")).length,
    0,
    "a ceiling without a fallback key measures nothing"
  );
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
});

// Each 429 quota detector, proven on its own: the response carries exactly one
// quota signal, so removing that detector leaves the 429 on the subscription.
for (const [name, makeResponse] of [
  [
    "a rate-limit-reached header",
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "x-codex-rate-limit-reached-type": "primary" },
      }),
  ],
  [
    "a window at the ceiling",
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "x-codex-secondary-used-percent": "100" },
      }),
  ],
  [
    "a usage-limit message",
    () =>
      new Response(JSON.stringify({ error: { message: "The usage limit has been reached" } }), {
        status: 429,
      }),
  ],
]) {
  test(`spills a 429 over on ${name} alone`, async () => {
    process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
    delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
    const calls = stubFetch({ codex: makeResponse });
    const loaded = await loadProxy(`detector-${name.replaceAll(" ", "-")}`);

    const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
    assert.equal(await response.text(), "platform-ok");
    assert.equal(platformCalls(calls).length, 1);
    assert.equal(platformCalls(calls)[0].headers.get("authorization"), "Bearer sk-fallback");
  });
}

test("returns a 429 that stays on the subscription exactly as it arrived", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const headers = new Headers({ "retry-after": "7", "content-type": "text/plain" });
  headers.append("set-cookie", "a=1");
  headers.append("set-cookie", "b=2");
  const bytes = new Uint8Array([0x73, 0x6c, 0x6f, 0x77, 0xff]);
  const calls = stubFetch({
    codex: () => new Response(bytes, { status: 429, statusText: "Too Many Requests", headers }),
  });
  const loaded = await loadProxy("throttle-fidelity");

  const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(response.status, 429);
  assert.equal(response.statusText, "Too Many Requests");
  assert.equal(response.headers.get("retry-after"), "7");
  assert.deepEqual(response.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytes]);
  assert.equal(platformCalls(calls).length, 0);
});

test("a 429 body that fails to read is an error, not an empty 429", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({
    codex: () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("stream reset"));
          },
        }),
        { status: 429 }
      ),
  });
  const loaded = await loadProxy("throttle-body-error");

  await assert.rejects(loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT), /stream reset/);
  assert.equal(platformCalls(calls).length, 0);
});

test("keeps repeated header tuples on both legs", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("repeated-headers");

  await loaded.fetch(MODEL_REQUEST_URL, {
    ...REQUEST_INIT,
    headers: [
      ["authorization", "Bearer opencode-oauth-dummy-key"],
      ["x-repeated", "a"],
      ["x-repeated", "b"],
    ],
  });
  assert.equal(codexCalls(calls)[0].headers.get("x-repeated"), "a, b");
  assert.equal(platformCalls(calls)[0].headers.get("x-repeated"), "a, b");
});

test("a rejected fallback key fails one turn, then the subscription serves", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-rejected";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  const calls = stubFetch({
    codex: () =>
      new Response("codex-ok", {
        status: 200,
        headers: { "x-codex-secondary-used-percent": "85" },
      }),
    usage: () => usageResponse(10, 85),
    platform: () =>
      Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 }),
  });
  const loaded = await loadProxy("rejected-key");

  // 85% against an 80% ceiling sends the first turn to the platform, which
  // refuses the key. That turn fails once, with an error naming the key.
  const first = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(first.status, 401);
  const error = (await first.json()).error;
  assert.equal(error.code, "fallback_key_rejected");
  assert.match(error.message, /OPENAI_API_KEY_FALLBACK/);

  // Later turns do not alternate between the subscription and the refused key:
  // the key is out of play for the rest of the sandbox.
  for (let turn = 0; turn < 3; turn += 1) {
    const response = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
    assert.equal(await response.text(), "codex-ok");
  }
  assert.equal(platformCalls(calls).length, 1, "the refused key is tried exactly once");
  assert.equal(codexCalls(calls).length, 3);
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
});

test("a fallback key refused while latched is not tried again", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-revoked";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  let platformStatus = 200;
  const calls = stubFetch({
    codex: () => (codexCalls(calls).length === 1 ? usageLimitResponse() : new Response("codex-ok")),
    platform: () => new Response("platform", { status: platformStatus }),
  });
  const loaded = await loadProxy("revoked-while-latched");

  assert.equal((await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).status, 200);
  platformStatus = 401;
  const refused = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(refused.status, 401);
  assert.equal((await refused.json()).error.code, "fallback_key_rejected");
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(platformCalls(calls).length, 2);
});

test("a 403 arriving while latched is returned as it arrived and keeps the key", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  let platformStatus = 200;
  const calls = stubFetch({
    codex: () => (codexCalls(calls).length === 1 ? usageLimitResponse() : new Response("codex-ok")),
    platform: () =>
      new Response("model access denied", {
        status: platformStatus,
        headers: { "x-platform": "403-body" },
      }),
  });
  const loaded = await loadProxy("forbidden-while-latched");

  assert.equal((await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).status, 200);
  platformStatus = 403;
  const forbidden = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get("x-platform"), "403-body");
  assert.equal(await forbidden.text(), "model access denied");
  // Like any other platform failure, the 403 clears the latch: the next turn
  // retries the subscription rather than staying on a failing paid path.
  assert.equal(await (await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT)).text(), "codex-ok");
  assert.equal(platformCalls(calls).length, 2);
});

test("a 403 for one request leaves the key usable for the next spillover", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({
    codex: () => usageLimitResponse(),
    platform: () =>
      platformCalls(calls).length === 1
        ? new Response("model access denied", { status: 403 })
        : new Response("platform-ok"),
  });
  const loaded = await loadProxy("forbidden-then-ok");

  const forbidden = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(forbidden.status, 403);
  assert.equal(await forbidden.text(), "model access denied");

  const next = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal(next.status, 200);
  assert.equal(await next.text(), "platform-ok");
  assert.equal(platformCalls(calls).length, 2);
  assert.equal(platformCalls(calls)[1].headers.get("authorization"), "Bearer sk-fallback");
});

test("a key refused by one request is not sent by a request already in flight", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-rejected";
  process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT = "80";
  const calls = stubFetch({
    codex: () => new Response("codex-ok", { status: 200 }),
    usage: () => usageResponse(10, 85),
    platform: () =>
      Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 }),
  });
  const loaded = await loadProxy("rejected-key-in-flight");

  // B reads the key, then waits on its own streamed body while A runs the
  // whole 85%-against-80% path and has the key refused.
  let finishBody;
  const bodyReady = new Promise((resolve) => (finishBody = resolve));
  const streamed = new ReadableStream({
    async start(controller) {
      await bodyReady;
      controller.enqueue(new TextEncoder().encode(REQUEST_INIT.body));
      controller.close();
    },
  });
  const pendingB = loaded.fetch(
    new Request(MODEL_REQUEST_URL, {
      method: "POST",
      body: streamed,
      duplex: "half",
      headers: REQUEST_INIT.headers,
    })
  );

  const a = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT);
  assert.equal((await a.json()).error.code, "fallback_key_rejected");

  finishBody();
  const b = await pendingB;
  assert.equal(await b.text(), "codex-ok", "B goes to the subscription instead");
  assert.equal(platformCalls(calls).length, 1, "the refused key is sent exactly once");
  assert.equal(codexCalls(calls)[0].body, REQUEST_INIT.body);
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
});

test("a streamed body sent to the subscription is never resent on a 429", async () => {
  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  const calls = stubFetch({ codex: () => usageLimitResponse() });
  const loaded = await loadProxy("streamed-init-body");

  // A URL-shaped call hands its stream to the subscription leg as is, so the
  // stream is spent once that leg is sent and a spillover could only send an
  // empty or locked body. The 429 is returned instead.
  const response = await loaded.fetch(MODEL_REQUEST_URL, {
    method: "POST",
    duplex: "half",
    headers: REQUEST_INIT.headers,
    body: new Response(REQUEST_INIT.body).body,
  });
  assert.equal(response.status, 429);
  assert.equal(codexCalls(calls).length, 1);
  assert.equal(platformCalls(calls).length, 0);
});

/**
 * Every control-plane broker error code, classified. Read from the control
 * plane's own union so a new code fails here until someone decides whether it
 * may spend the fallback key.
 */
const BROKER_CODE_CLASSIFICATION = {
  account_not_found: "permanent",
  account_inactive: "permanent",
  account_archived: "permanent",
  provider_mismatch: "permanent",
  provider_unavailable: "transient",
  credential_not_found: "permanent",
  credential_invalid: "permanent",
  exchange_busy: "transient",
  deadline_exceeded: "transient",
  reconnect_required: "permanent",
  upstream_retry_safe: "transient",
};

test("classifies every control-plane broker error code", async () => {
  const source = await readFile(
    new URL("../../control-plane/src/auth/model-provider-account-broker.ts", import.meta.url),
    "utf8"
  );
  const union = source.match(/export type ModelProviderAccountBrokerErrorCode =([^;]+);/);
  assert.ok(union, "the control plane still declares the broker error code union");
  const codes = [...union[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(codes.toSorted(), Object.keys(BROKER_CODE_CLASSIFICATION).toSorted());

  process.env.OPENAI_API_KEY_FALLBACK = "sk-fallback";
  delete process.env.OPENAI_SUBSCRIPTION_MAX_PERCENT;
  for (const [code, kind] of Object.entries(BROKER_CODE_CLASSIFICATION)) {
    const calls = stubFetch({
      broker: () => Response.json({ error: code, code }, { status: 409 }),
    });
    const loaded = await loadProxy(`broker-code-${code}`);
    const outcome = await loaded.fetch(MODEL_REQUEST_URL, REQUEST_INIT).then(
      () => "permanent",
      () => "transient"
    );
    assert.equal(outcome, kind, `${code} is ${kind}`);
    assert.equal(platformCalls(calls).length, kind === "permanent" ? 1 : 0, code);
  }
});

async function withCatalog(models, run) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-model-prices-"));
  const previous = process.env.OPENCODE_MODELS_PATH;
  process.env.OPENCODE_MODELS_PATH = join(directory, "models.json");
  await writeFile(process.env.OPENCODE_MODELS_PATH, JSON.stringify({ openai: { models } }));
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MODELS_PATH;
    else process.env.OPENCODE_MODELS_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("preserves a source Request while proxying Codex authentication", async () => {
  let upstreamRequest;
  let upstreamInit;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.startsWith("https://control.test/")) {
      return Response.json({
        accessToken: "access-token",
        expiresIn: 3600,
        providerMetadata: { accountId: "account-1" },
      });
    }
    upstreamRequest = request;
    upstreamInit = init;
    return new Response(null, { status: 200 });
  };
  const loaded = await loadProxy("preserve-request");

  await loaded.fetch(
    new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer dummy", "X-Request-Header": "preserved" },
      body: "request-body",
    })
  );

  assert.equal(upstreamRequest.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(upstreamRequest.method, "POST");
  assert.equal(upstreamRequest.headers.get("authorization"), "Bearer access-token");
  assert.equal(upstreamRequest.headers.get("chatgpt-account-id"), "account-1");
  assert.equal(upstreamRequest.headers.get("x-request-header"), "preserved");
  assert.equal(await upstreamRequest.text(), "request-body");
  assert.equal(upstreamInit.timeout, false);
});

test("preserves API-key requests if OpenAI authentication switches away from OAuth", async () => {
  let upstreamRequest;
  globalThis.fetch = async (input, init) => {
    upstreamRequest = input instanceof Request ? input : new Request(input, init);
    return new Response(null, { status: 200 });
  };
  let authReadCount = 0;
  const getAuth = async () =>
    authReadCount++ === 0 ? { type: "oauth", refresh: "managed" } : { type: "api" };
  const { CodexAuthProxy } = await import(`${PLUGIN_PATH}?case=switch-away`);
  const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });
  const loaded = await plugin.auth.loader(getAuth);

  await loaded.fetch(
    new Request("https://api.openai.com/v1/responses", {
      headers: { Authorization: "Bearer api-key" },
    })
  );
  assert.equal(upstreamRequest.url, "https://api.openai.com/v1/responses");
  assert.equal(upstreamRequest.headers.get("authorization"), "Bearer api-key");
  assert.deepEqual(await plugin.auth.loader(async () => ({ type: "api" })), {});
});

test("restores known prices and filters retired Codex models after the built-in OAuth hook", async () => {
  const gpt6Ids = ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"];
  const gpt6Models = gpt6Ids.map((id) => [id, { name: id, cost: { input: 0, output: 0 } }]);
  // OpenCode's built-in hook has zeroed OAuth prices; it may still expose retired models.
  const provider = {
    models: {
      ...Object.fromEntries(gpt6Models),
      "gpt-5.3-codex": { cost: { input: 0 } },
      "gpt-5.3-codex-spark": { cost: { input: 0 } },
      "unsupported-model": { cost: { input: 0 } },
    },
  };
  await withCatalog(
    {
      "gpt-6-astra": { cost: { input: 12, output: 52, cache_read: 1.2 } },
      "gpt-6-sol": { cost: { input: 3, output: 11, cache_read: 0.3 } },
      "gpt-6-luna": { cost: { input: 0.2, output: 0.6 } },
      "gpt-5.3-codex": { cost: { input: 2, output: 15 } },
      "gpt-5.3-codex-spark": { cost: { input: 2.5, output: 16 } },
    },
    async () => {
      const { CodexAuthProxy } = await import(`${PLUGIN_PATH}?case=gpt6-entitlement`);
      const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });

      const apiKeyModels = await plugin.provider.models(provider, { auth: { type: "api" } });
      assert.equal(apiKeyModels, provider.models);

      const priced = await plugin.provider.models(provider, { auth: { type: "oauth" } });
      assert.equal(priced["gpt-6-astra"].cost.input, 12);
      assert.equal(priced["gpt-6-sol"].cost.cache.read, 0.3);
      assert.equal(priced["gpt-6-luna"].cost.output, 0.6);
      assert.equal(priced["unsupported-model"], undefined);
      assert.equal(priced["gpt-5.3-codex"], undefined);
      assert.equal(priced["gpt-5.3-codex-spark"], undefined);
      assert.equal(provider.models["gpt-6-astra"].cost.input, 0);
      assert.equal(provider.models["gpt-5.3-codex"].cost.input, 0);
      await plugin.auth.loader(async () => ({ type: "oauth", refresh: "managed" }));
    }
  );
});

test("converts catalog context pricing without hardcoding the tier rates", async () => {
  await withCatalog(
    {
      "gpt-6-astra": {
        cost: {
          input: 12,
          output: 52,
          cache_read: 1.2,
          cache_write: 13,
          context_over_200k: { input: 24, output: 78, cache_read: 2.4, cache_write: 26 },
          tiers: [
            {
              input: 25,
              output: 80,
              cache_read: 2.5,
              cache_write: 27,
              tier: { type: "context", size: 272_000 },
            },
          ],
        },
      },
    },
    async () => {
      const { CodexAuthProxy } = await import(`${PLUGIN_PATH}?case=context-tier-prices`);
      const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });
      const models = await plugin.provider.models(
        { models: { "gpt-6-astra": { cost: { input: 0, output: 0 } } } },
        { auth: { type: "oauth" } }
      );
      const cost = models["gpt-6-astra"].cost;
      const selected = (tokens) =>
        cost.tiers?.filter(({ tier }) => tokens > tier.size).at(-1) ??
        (tokens > 200_000 ? cost.experimentalOver200K : cost);

      assert.equal(selected(200_000).input, 12);
      assert.equal(selected(200_001).input, 24);
      assert.equal(selected(272_000), cost.experimentalOver200K);
      assert.equal(selected(272_001).input, 25);
      assert.equal(cost.experimentalOver200K.cache.write, 26);
      assert.equal(cost.tiers[0].cache.write, 27);
    }
  );
});

test("uses only OpenCode's cache and picks up prices when it appears", async () => {
  const directory = await mkdtemp(join(tmpdir(), "missing-opencode-models-"));
  const previousPath = process.env.OPENCODE_MODELS_PATH;
  const previousFetch = globalThis.fetch;
  const previousWarn = console.warn;
  process.env.OPENCODE_MODELS_PATH = join(directory, "models.json");
  let requests = 0;
  let warnings = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("unexpected catalog request");
  };
  console.warn = () => warnings++;
  try {
    const { CodexAuthProxy } = await import(`${PLUGIN_PATH}?case=cache-only-prices`);
    const plugin = await CodexAuthProxy({ client: { auth: { set: async () => undefined } } });
    const provider = { models: { "gpt-6-sol": { cost: { input: 0, output: 0 } } } };
    const context = { auth: { type: "oauth" } };
    const missing = await plugin.provider.models(provider, context);
    assert.equal(missing["gpt-6-sol"].cost.input, 0);
    assert.equal(missing["gpt-5.3-codex"], undefined);
    assert.equal(warnings, 1);

    await writeFile(
      process.env.OPENCODE_MODELS_PATH,
      JSON.stringify({ openai: { models: { "gpt-6-sol": { cost: { input: 4, output: 12 } } } } })
    );
    const priced = await plugin.provider.models(provider, context);
    assert.equal(priced["gpt-6-sol"].cost.input, 4);
    assert.equal(requests, 0);
  } finally {
    if (previousPath === undefined) delete process.env.OPENCODE_MODELS_PATH;
    else process.env.OPENCODE_MODELS_PATH = previousPath;
    globalThis.fetch = previousFetch;
    console.warn = previousWarn;
    await rm(directory, { recursive: true, force: true });
  }
});
