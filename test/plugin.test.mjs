import test from "node:test"
import assert from "node:assert/strict"

import { BailucodeAuthPlugin, _internal } from "../index.mjs"

const { normalizeBase, modelEntry, modelIds, protocolOf, BASE, KEY_PAGE, SEED_MODELS } = _internal

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
  const plugin = await BailucodeAuthPlugin({}, { fetch })
  const models = await plugin.provider.models({ api: BASE }, { auth: fakeAuth() })
  assert.deepEqual(Object.keys(models).sort(), ["bailu-2.9-preview", "bailu-apex-2.7"].sort())
  assert.equal(models["bailu-2.9-preview"].provider.api, BASE)
  const [call] = fetch.calls
  assert.equal(call.url, `${BASE}/models`)
  assert.equal(call.init.headers.authorization, "Bearer sk-live-test")
})

test("models keeps the known list when the key is rejected", async () => {
  const fetch = mockFetch(() => response({ error: { message: "Invalid API key", code: "invalid_api_key" } }, 401))
  const plugin = await BailucodeAuthPlugin({}, { fetch })
  const provider = { api: BASE, models: { "seed-model": { id: "seed-model" } } }
  const models = await plugin.provider.models(provider, { auth: fakeAuth() })
  assert.deepEqual(Object.keys(models), ["seed-model"])
})

test("models without a key is the config's own list", async () => {
  const fetch = mockFetch(() => response({}, 500))
  const plugin = await BailucodeAuthPlugin({}, { fetch })
  const provider = { api: BASE, models: { "seed-model": { id: "seed-model" } } }
  const models = await plugin.provider.models(provider, { auth: { type: "api" } })
  assert.deepEqual(Object.keys(models), ["seed-model"])
  assert.equal(fetch.calls.length, 0)
})

test("usage says the key is accepted, and names the page when it is not", async () => {
  const ok = mockFetch(() => response({ data: [{ id: "bailu-2.9-preview" }] }))
  const accepted = await (await BailucodeAuthPlugin({}, { fetch: ok })).auth.usage(async () => fakeAuth())
  assert.equal(accepted.plan, "BAILU Open Platform")
  assert.equal(accepted.error, undefined)

  const rejected = mockFetch(() => response({ error: { message: "Invalid API key" } }, 401))
  const refused = await (await BailucodeAuthPlugin({}, { fetch: rejected })).auth.usage(async () => fakeAuth())
  assert.equal(refused.plan, "BAILU Open Platform")
  assert.match(refused.error, /API key/)
  assert.ok(refused.error.includes(KEY_PAGE))
})

test("usage names the proxy problem when Cloudflare answers instead of the gateway", async () => {
  const blocked = mockFetch(() => response("<!DOCTYPE html><title>Just a moment...</title>", 403))
  const refused = await (await BailucodeAuthPlugin({}, { fetch: blocked })).auth.usage(async () => fakeAuth())
  assert.match(refused.error, /Cloudflare/)
})

test("chat.headers keeps the honest client UA that Cloudflare lets through", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const output = { headers: {} }
  await plugin["chat.headers"]({ model: "bailu-2.9-preview" }, output)
  assert.equal(output.headers["user-agent"], "magpie-bailucode/0.1.0")
  assert.equal(output.headers.accept, "application/json")

  const custom = await BailucodeAuthPlugin({}, { headers: { "x-team": "lab" } })
  const out2 = { headers: { accept: "text/event-stream" } }
  await custom["chat.headers"]({}, out2)
  assert.equal(out2.headers["x-team"], "lab")
  assert.equal(out2.headers.accept, "text/event-stream")
})

test("the address prompt validates as magpie's Go side expects: string or nothing", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const [{ prompts }] = plugin.auth.methods
  const { validate } = prompts[0]
  assert.equal(validate(""), undefined)
  assert.equal(validate("   "), undefined)
  assert.equal(validate("https://bailucode.com/openapi/v1"), undefined)
  assert.equal(validate("http://bailucode.com/openapi/v1"), undefined)
  // a bool here fails the login with "cannot unmarshal bool into ... .error of type string"
  assert.equal(typeof validate("bailucode.com"), "string")
  assert.equal(typeof validate("ftp://x"), "string")
  assert.equal(typeof validate("https://u:p@x/?q=1"), "string")
  for (const bad of ["bailucode.com", "ftp://x", "https://u:p@x/?q=1", "not a url"]) {
    assert.notEqual(typeof validate(bad), "boolean")
  }
})

test("usage is null without a key", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  assert.equal(await plugin.auth.usage(async () => ({ type: "api" })), null)
})