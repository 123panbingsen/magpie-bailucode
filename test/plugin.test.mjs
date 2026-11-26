import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BailucodeAuthPlugin, _internal } from "../index.mjs"

const { normalizeBase, modelEntry, modelIds, protocolOf, quotaWindows, extractJson, BASE, KEY_PAGE, SEED_MODELS } = _internal

function fakeAuth(metadata = {}) {
  return { type: "api", key: "sk-live-test", metadata }
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }
}

function mockFetch(handler) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  fn.calls = calls
  return fn
}

test("normalizeBase accepts a host, /openapi, and the full gateway path", () => {
  assert.equal(normalizeBase(""), BASE)
  assert.equal(normalizeBase("bailucode.com"), "https://bailucode.com/openapi/v1")
  assert.equal(normalizeBase("https://bailucode.com"), "https://bailucode.com/openapi/v1")
  assert.equal(normalizeBase("https://bailucode.com/"), "https://bailucode.com/openapi/v1")
  assert.equal(normalizeBase("https://bailucode.com/openapi"), "https://bailucode.com/openapi/v1")
  assert.equal(normalizeBase("https://bailucode.com/openapi/v1/"), "https://bailucode.com/openapi/v1")
  assert.equal(normalizeBase("https://mirror.example.com/v1"), "https://mirror.example.com/v1")
})

test("protocolOf only knows openai and anthropic", () => {
  assert.equal(protocolOf("anthropic"), "anthropic")
  assert.equal(protocolOf("openai"), "openai")
  assert.equal(protocolOf(undefined), "openai")
  assert.equal(protocolOf("responses"), "openai")
})

test("modelIds reads OpenAI, Anthropic and bare-array model lists", () => {
  assert.equal(modelIds({ data: [{ id: "a" }, { id: "b" }] }).length, 2)
  assert.equal(modelIds({ models: [{ id: "c" }] }).length, 1)
  assert.equal(modelIds([{ id: "d" }]).length, 1)
  assert.equal(modelIds([{ name: "bailu-2.9-preview" }]).length, 1)
  assert.equal(modelIds({}).length, 0)
})

test("modelEntry carries the gateway, npm, limits and vision", () => {
  const [id, entry] = modelEntry({ id: "bailu-2.9-preview", context_length: 1048576, max_output_tokens: 131072 }, BASE, "@ai-sdk/openai-compatible")
  assert.equal(id, "bailu-2.9-preview")
  assert.equal(entry.id, "bailu-2.9-preview")
  assert.deepEqual(entry.provider, { npm: "@ai-sdk/openai-compatible", api: BASE })
  assert.deepEqual(entry.limit, { context: 1048576, output: 131072 })
  assert.equal(entry.tool_call, true)
  const [, vision] = modelEntry("bailu-2.8", BASE, "@ai-sdk/openai-compatible")
  assert.equal(vision.attachment, true)
  assert.deepEqual(vision.modalities.input, ["text", "image"])
})

test("config registers the provider with the gateway, npm and seed models", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const cfg = {}
  await plugin.config(cfg)
  const provider = cfg.provider.bailucode
  assert.equal(provider.name, "BAILU（白鹿）")
  assert.equal(provider.api, BASE)
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  assert.ok(Object.keys(provider.models).length >= SEED_MODELS.length)
  assert.ok(provider.models["bailu-2.9-preview"])
})

test("config keeps what the user already configured and merges their models", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const cfg = { provider: { bailucode: { api: "https://mirror.example.com/v1", models: { mine: { id: "mine" } } } } }
  await plugin.config(cfg)
  assert.equal(cfg.provider.bailucode.api, "https://mirror.example.com/v1")
  assert.ok(cfg.provider.bailucode.models.mine)
  assert.ok(cfg.provider.bailucode.models["bailu-2.9-preview"])
})

test("config follows the anthropic protocol option", async () => {
  const plugin = await BailucodeAuthPlugin({}, { protocol: "anthropic" })
  const cfg = {}
  await plugin.config(cfg)
  assert.equal(cfg.provider.bailucode.npm, "@ai-sdk/anthropic")
  assert.equal(cfg.provider.bailucode.models["bailu-2.9-preview"].provider.npm, "@ai-sdk/anthropic")
})

test("loader hands magpie the gateway base, the key and headers", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const hook = await plugin.auth.loader(async () => fakeAuth({ baseURL: "https://bailucode.com/openapi" }))
  assert.equal(hook.baseURL, `${BASE}`)
  assert.equal(hook.apiKey, "sk-live-test")
  assert.equal(hook.headers.accept, "application/json")
})

test("loader returns nothing without an api key", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  assert.deepEqual(await plugin.auth.loader(async () => ({ type: "oauth" })), {})
  assert.deepEqual(await plugin.auth.loader(async () => null), {})
})

test("models asks the gateway with the key and returns what it lists", async () => {
  const fetch = mockFetch(() =>
    response({
      object: "list",
      data: [
        { id: "bailu-2.9-preview", context_length: 1048576, max_output_tokens: 131072 },
        { id: "bailu-apex-2.7", context_length: 1048576 },
      ],
    })
  )
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false })
  const models = await plugin.provider.models({ api: BASE }, { auth: fakeAuth() })
  assert.deepEqual(Object.keys(models).sort(), ["bailu-2.9-preview", "bailu-apex-2.7"].sort())
  assert.equal(models["bailu-2.9-preview"].provider.api, BASE)
  const [call] = fetch.calls
  assert.equal(call.url, `${BASE}/models`)
  assert.equal(call.init.headers.authorization, "Bearer sk-live-test")
})

test("models keeps the known list when the key is rejected", async () => {
  const fetch = mockFetch(() => response({ error: { message: "Invalid API key", code: "invalid_api_key" } }, 401))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false })
  const provider = { api: BASE, models: { "seed-model": { id: "seed-model" } } }
  const models = await plugin.provider.models(provider, { auth: fakeAuth() })
  assert.deepEqual(Object.keys(models), ["seed-model"])
})

test("models without a key is the config's own list", async () => {
  const fetch = mockFetch(() => response({}, 500))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false })
  const provider = { api: BASE, models: { "seed-model": { id: "seed-model" } } }
  const models = await plugin.provider.models(provider, { auth: { type: "api" } })
  assert.deepEqual(Object.keys(models), ["seed-model"])
  assert.equal(fetch.calls.length, 0)
})

test("usage says the key is accepted, and names the page when it is not", async () => {
  const ok = mockFetch(() => response({ data: [{ id: "bailu-2.9-preview" }] }))
  const accepted = await (await BailucodeAuthPlugin({}, { fetch: ok, session: false })).auth.usage(async () => fakeAuth())
  assert.equal(accepted.plan, "BAILU Open Platform")
  assert.equal(accepted.error, undefined)

  const rejected = mockFetch(() => response({ error: { message: "Invalid API key" } }, 401))
  const refused = await (await BailucodeAuthPlugin({}, { fetch: rejected, session: false })).auth.usage(async () => fakeAuth())
  assert.equal(refused.plan, "BAILU Open Platform")
  assert.match(refused.error, /API key/)
  assert.ok(refused.error.includes(KEY_PAGE))
})

test("usage names the proxy problem when Cloudflare answers instead of the gateway", async () => {
  const blocked = mockFetch(() => response("<!DOCTYPE html><title>Just a moment...</title>", 403))
  const refused = await (await BailucodeAuthPlugin({}, { fetch: blocked, session: false })).auth.usage(async () => fakeAuth())
  assert.match(refused.error, /Cloudflare/)
})

test("chat.headers keeps the honest client UA that Cloudflare lets through", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const output = { headers: {} }
  await plugin["chat.headers"]({ model: "bailu-2.9-preview" }, output)
  assert.match(output.headers["user-agent"], /^magpie-bailucode\/\d+\.\d+\.\d+$/)
  assert.equal(output.headers.accept, "application/json")

  const custom = await BailucodeAuthPlugin({}, { headers: { "x-team": "lab" } })
  const out2 = { headers: { accept: "text/event-stream" } }
  await custom["chat.headers"]({}, out2)
  assert.equal(out2.headers["x-team"], "lab")
  assert.equal(out2.headers.accept, "text/event-stream")
})

test("sign-in asks for the key and nothing else", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const methods = plugin.auth.methods
  const api = methods.find((m) => m.type === "api")
  assert.ok(api)
  assert.equal(api.placeholder, "sk-…")
  // no extra prompt to click through: the gateway address is fixed
  assert.deepEqual(api.prompts ?? [], [])
  assert.match(api.label, /bailucode\.com/)
  // the browser route is its own choice, not a prompt on the key one
  const oauth = methods.find((m) => m.label.includes("浏览器登录"))
  assert.ok(oauth && typeof oauth.authorize === "function")
})

test("a different gateway comes from options or a stored address, never a prompt", async () => {
  const viaOptions = await BailucodeAuthPlugin({}, { baseURL: "https://mirror.example.com/openapi" })
  const hook = await viaOptions.auth.loader(async () => fakeAuth())
  assert.equal(hook.baseURL, "https://mirror.example.com/openapi/v1")

  const stored = await BailucodeAuthPlugin({}, {})
  const kept = await stored.auth.loader(async () => fakeAuth({ baseURL: "https://bailucode.com/openapi" }))
  assert.equal(kept.baseURL, BASE)
})

test("usage is null without a key", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  assert.equal(await plugin.auth.usage(async () => ({ type: "api" })), null)
})

// ---- 白鹿通行证 quota ----------------------------------------------------------

const WALLET = {
  seed: "user@example.com",
  code: { planRemain: 8000, planQuota: 8000, addonTokens: 13500000 },
  api: { ok: true, quota: 305000000, used: 657, addonRem: 13500000, addonCons: 0, usedEff: 657, quotaEff: 318500000 },
  packs: [{ id: "anthropic", q: 5000000, u: 0 }],
}

const DASHBOARD = `<!doctype html><html><body>
<div class="wl-q__value"><span id="wlCodeVal">21,500</span><span class="wl-q__unit">Credits</span></div>
<dl class="wl-kv"><dt>用量重置</dt><dd>12月3日</dd></dl>
<script>var S = ${JSON.stringify(WALLET)};</script>
</body></html>`

test("quotaWindows turns the portal wallet into the three lines the dashboard shows", () => {
  const windows = quotaWindows(WALLET, DASHBOARD, new Date("2026-11-26T10:00:00+08:00"))
  assert.equal(windows.length, 3)
  const [code, api, pack] = windows
  assert.equal(code.name, "白鹿编码")
  assert.equal(code.display, "21,500 Credits") // 8,000 plan + 13,500 add-on
  assert.equal(code.limit, 21500)
  assert.equal(code.used, 0)

  assert.equal(api.name, "API 平台")
  assert.equal(api.display, "657 / 3.18 亿 Tokens")
  assert.equal(api.limit, 318500000)
  assert.ok(api.used < 0.01)
  assert.equal(api.resetsAt, "2026-12-02T16:00:00.000Z") // 12月3日 00:00 +08:00

  assert.equal(pack.name, "Anthropic 协议 定向")
  assert.equal(pack.display, "剩 500 万 / 共 500 万 Tokens")
  assert.equal(pack.aside, true)
})

test("extractJson follows braces inside strings", () => {
  const html = `<script>var S = {"a":"}not the end{","b":{"c":1}}; var T = 1;</script>`
  const got = extractJson(html, "var S = ")
  assert.deepEqual(got, { a: "}not the end{", b: { c: 1 } })
  assert.equal(extractJson("<html>no wallet</html>", "var S = "), null)
})

test("usage reads the portal when a session is configured", async () => {
  const fetch = mockFetch(() => response(DASHBOARD, 200))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: "session_token=abc; PHPSESSID=def" })
  const usage = await plugin.auth.usage(async () => fakeAuth())
  assert.equal(usage.plan, "白鹿通行证")
  assert.equal(usage.user, "user@example.com")
  assert.equal(usage.windows.length, 3)
  const [call] = fetch.calls
  assert.equal(call.url, "https://bailucode.com/auth/")
  assert.equal(call.init.headers.cookie, "session_token=abc; PHPSESSID=def")
})

test("an expired portal session says so and where to refresh it", async () => {
  const fetch = mockFetch(() => ({ ok: false, status: 302, headers: new Headers({ location: "/auth/login" }), text: async () => "" }))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: "session_token=old" })
  const usage = await plugin.auth.usage(async () => fakeAuth())
  assert.equal(usage.plan, "白鹿通行证")
  assert.match(usage.error, /会话已过期/)
  assert.match(usage.error, /session\.txt|session/)
})

test("without a session the card falls back to the key check, never the portal", async () => {
  const fetch = mockFetch(() => response({ data: [{ id: "bailu-2.9-preview" }] }))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false })
  const usage = await plugin.auth.usage(async () => fakeAuth())
  assert.equal(usage.plan, "BAILU Open Platform")
  assert.equal(fetch.calls[0].url, `${BASE}/models`)
})

// ---- 浏览器登录 -----------------------------------------------------------------

test("only bailucode cookies become the cookie header", () => {
  const header = _internal.cookieHeader([
    { name: "a", value: "1", domain: ".bailucode.com" },
    { name: "b", value: "2", domain: "bailucode.com" },
    { name: "c", value: "3", domain: ".example.com" },
    { name: "d", value: "", domain: ".bailucode.com" },
  ])
  assert.equal(header, "a=1; b=2")
})

test("DevToolsActivePort's first line is the port", () => {
  assert.equal(_internal.parseDevToolsPort("9222\n/devtools/browser/abc"), 9222)
  assert.equal(_internal.parseDevToolsPort("0\n"), null)
  assert.equal(_internal.parseDevToolsPort(""), null)
})

test("the working key is a full sk- key, active one first", () => {
  const keys = [
    { api_key_full: "sk-old", is_active: 0 },
    { api_key_full: "sk-live", is_active: 1 },
  ]
  assert.equal(_internal.workingKey(keys).api_key_full, "sk-live")
  assert.equal(_internal.workingKey([{ api_key_full: "sk-only" }]).api_key_full, "sk-only")
  assert.equal(_internal.workingKey([]), null)
  assert.equal(_internal.workingKey([{ api_key_masked: "sk-…" }]), null)
})

function portalFetch(handlers) {
  return mockFetch((url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {}
    const handler = handlers[body.action]
    if (!handler) return response({ success: false, message: "无效的操作" }, 400)
    return handler(url, body)
  })
}

test("the browser route reuses a key the portal already lists", async () => {
  const tmp = path.join(os.tmpdir(), `bailu-session-test-${Date.now()}`)
  const fetch = portalFetch({
    get_keys: () => response({ success: true, keys: [{ id: 7, is_active: 1, api_key_full: "sk-existing-1234", key_name: "we" }] }),
  })
  const plugin = await BailucodeAuthPlugin(
    {},
    { fetch, session: false, sessionFile: tmp, browserSignIn: async () => ({ cookie: "a=b; c=d" }) }
  )
  const oauth = plugin.auth.methods.find((m) => m.label.includes("浏览器登录"))
  const auth = await oauth.authorize()
  assert.equal(auth.type, "success")
  assert.equal(auth.key, "sk-existing-1234")
  assert.equal(fs.readFileSync(tmp, "utf8").trim(), "a=b; c=d")
  assert.equal(fetch.calls[0].url, "https://bailucode.com/api/api_keys")
  assert.equal(fetch.calls[0].init.headers.cookie, "a=b; c=d")
  fs.rmSync(tmp, { force: true })
})

test("with no key in the portal the browser route creates one", async () => {
  const tmp = path.join(os.tmpdir(), `bailu-session-test-${Date.now()}-2`)
  const fetch = portalFetch({
    get_keys: () => response({ success: true, keys: [] }),
    create_key: (url, body) =>
      response({ success: true, key: { api_key_full: "sk-new-9999", key_name: body.key_name } }),
  })
  const plugin = await BailucodeAuthPlugin(
    {},
    { fetch, session: false, sessionFile: tmp, browserSignIn: async () => ({ cookie: "a=b" }) }
  )
  const oauth = plugin.auth.methods.find((m) => m.label.includes("浏览器登录"))
  const auth = await oauth.authorize()
  assert.equal(auth.key, "sk-new-9999")
  const created = fetch.calls.find((c) => JSON.parse(c.init.body).action === "create_key")
  assert.equal(JSON.parse(created.init.body).key_name, "magpie")
  fs.rmSync(tmp, { force: true })
})

test("a portal that refuses to list keys fails the browser route loudly", async () => {
  const fetch = portalFetch({
    get_keys: () => response({ success: false, message: "请先完成平台协议确认" }, 400),
  })
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false, browserSignIn: async () => ({ cookie: "a=b" }) })
  const oauth = plugin.auth.methods.find((m) => m.label.includes("浏览器登录"))
  await assert.rejects(() => oauth.authorize(), /平台协议确认/)
})