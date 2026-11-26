// magpie-bailucode — BAILU AI（白鹿）Open Platform as a magpie / OpenCode provider.
//
// API keys: https://bailucode.com/api_platform/#api-keys
// Gateway:  https://bailucode.com/openapi/v1
//
// One base, one Bearer key, three protocol faces (all verified against the
// live gateway with an invalid key — each answered 401 "invalid_api_key"
// instead of 404, so the route exists):
//
//   POST /openapi/v1/chat/completions   OpenAI Chat Completions
//   POST /openapi/v1/messages           Anthropic Messages
//   POST /openapi/v1/responses          OpenAI Responses
//   POST /openapi/v1/embeddings         OpenAI Embeddings
//   GET  /openapi/v1/models             the key's model list
//
// There is no per-key quota route on the gateway (every /usage, /billing,
// /key path answers 404), so this plugin reports what it can prove: whether
// the key is accepted, and how many models it can see.

const PROVIDER = "bailucode"
const PROVIDER_NAME = "BAILU（白鹿）"
const BASE = "https://bailucode.com/openapi/v1"
const KEY_PAGE = "https://bailucode.com/api_platform/#api-keys"
const VERSION = "0.1.0"

// The SDK each protocol face is spoken with, as magpie names packages.
const PROTOCOLS = {
  openai: "@ai-sdk/openai-compatible",
  anthropic: "@ai-sdk/anthropic",
}

// Models the platform advertises publicly. They keep the provider usable
// before the key is added; GET /models replaces them once it answers.
const SEED_MODELS = [
  { id: "bailu-2.9-preview", name: "BAILU 2.9 Preview", context: 1048576, output: 131072 },
  { id: "bailu-2.8", name: "BAILU 2.8", context: 262144, output: 65536, vision: true },
  { id: "bailu-2.7", name: "BAILU 2.7", context: 262144, output: 65536 },
  { id: "bailu-apex-2.7", name: "BAILU APEX 2.7", context: 1048576, output: 65536 },
  { id: "yuyu-air", name: "Yuyu Air", context: 262144, output: 65536 },
]

const TIMEOUT = 20_000
const USAGE_TTL = 60_000
// A 403 here is not the key: Cloudflare answers an HTML challenge on exits it
// mistrusts (a foreign proxy, a datacenter IP) before the gateway sees the key.
const CLOUDFLARE_HINT = "BAILU 网关返回了 Cloudflare 验证页（不是 key 的问题）：让 bailucode.com 走直连，或换一个出口 IP"

// ---- helpers -----------------------------------------------------------------

function protocolOf(value) {
  return value === "anthropic" ? "anthropic" : "openai"
}

// A pasted address may be the bare host, /openapi, or the full /openapi/v1.
function normalizeBase(raw) {
  let value = typeof raw === "string" ? raw.trim() : ""
  if (!value) return BASE
  if (!/^https?:\/\//i.test(value)) value = "https://" + value
  value = value.replace(/\/+$/, "")
  if (/\/openapi\/v1$/i.test(value) || /\/v1$/i.test(value)) return value
  if (/\/openapi$/i.test(value)) return value + "/v1"
  try {
    const url = new URL(value)
    if (url.pathname === "" || url.pathname === "/") return url.origin + "/openapi/v1"
  } catch {
    return BASE
  }
  return value
}

function modelEntry(model, base, npm) {
  const id = typeof model === "string" ? model : String(model?.id ?? model?.name ?? "")
  const name = (typeof model === "object" && (model.name || model.display_name)) || id
  const context =
    Number(typeof model === "object" && (model.context_length || model.context_window || model.context || model.max_context_tokens)) || 262144
  const output =
    Number(typeof model === "object" && (model.max_output_tokens || model.max_completion_tokens || model.max_tokens)) || 65536
  const vision =
    (typeof model === "object" &&
      (model.vision === true || (Array.isArray(model.modalities?.input) && model.modalities.input.includes("image")))) ||
    // BAILU 2.8 / 2.9 are natively multimodal; older families are text-only unless told.
    /vision|vl\b|omni|2\.(?:8|9)/i.test(id)
  return [
    id,
    {
      id,
      name,
      provider: { npm, api: base },
      limit: { context, output },
      reasoning: true,
      tool_call: true,
      attachment: vision,
      modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    },
  ]
}

function seedEntries(base, npm) {
  return SEED_MODELS.map((model) => modelEntry(model, base, npm))
}

function modelIds(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  return list.filter((item) => item && (typeof item === "string" || typeof item.id === "string" || typeof item.name === "string"))
}

function authError(status, body) {
  const said = typeof body?.error?.message === "string" ? body.error.message : typeof body?.message === "string" ? body.message : ""
  const error = new Error(said || (status === 403 ? CLOUDFLARE_HINT : `HTTP ${status}`))
  error.status = status
  return error
}

// ---- the plugin --------------------------------------------------------------

export async function BailucodeAuthPlugin({ client, magpie } = {}, options = {}) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "bailucode", level: "info", message } })
    } catch {}
  }
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : (...args) => globalThis.fetch(...args)
  const usageCache = new Map()

  const metaOf = (auth) => auth?.metadata ?? {}
  const baseOf = (auth) => normalizeBase(metaOf(auth).baseURL || options.baseURL || auth?.baseURL || BASE)
  const protocolOfAuth = (auth) => protocolOf(metaOf(auth).protocol || options.protocol)
  const npmOf = (auth) => PROTOCOLS[protocolOfAuth(auth)]
  const headersOf = (auth) => ({
    accept: "application/json",
    "user-agent": `magpie-bailucode/${VERSION}`,
    ...(options.headers ?? {}),
    ...(metaOf(auth).headers ?? {}),
  })

  async function listModels(base, key, headers) {
    const res = await fetchImpl(`${base}/models`, {
      method: "GET",
      headers: { ...headers, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!res.ok) {
      const error = authError(res.status, body)
      if (typeof body === "string" && body.trimStart().startsWith("<") && res.status === 403) error.cloudflare = true
      throw error
    }
    return modelIds(body)
  }

  const authHook = {
    provider: PROVIDER,
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return { baseURL: baseOf(auth), apiKey: auth.key, headers: headersOf(auth) }
    },
    methods: [
      {
        type: "api",
        label: "BAILU API key（bailucode.com/openapi）",
        placeholder: "sk-…",
        // 只要 key：地址默认就是官网网关，不再多问一次。
        // 要换网关（镜像/自建）用插件选项：magpie plugin options magpie-bailucode '{"baseURL":"…"}'
        prompts: [],
      },
    ],
    // magpie 的卡片：能证明的只有「key 是否被接受」。
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return null
      const base = baseOf(auth)
      const key = String(auth.key)
      const scope = `${base}|${key.slice(-8)}`
      const hit = usageCache.get(scope)
      if (hit && Date.now() - hit.at < USAGE_TTL) return hit.value
      let value
      try {
        const ids = await listModels(base, auth.key, headersOf(auth))
        value = { plan: "BAILU Open Platform", ...(ids.length ? { windows: [] } : {}) }
        log(`BAILU: key accepted, ${ids.length} model(s) visible`)
      } catch (error) {
        value =
          error?.cloudflare
            ? { plan: "BAILU Open Platform", error: CLOUDFLARE_HINT }
            : error?.status === 401 || error?.status === 403
              ? { plan: "BAILU Open Platform", error: `API key 无效或已过期，去 ${KEY_PAGE} 重新生成` }
              : { plan: "BAILU Open Platform", error: error?.message || "无法访问 BAILU 网关" }
      }
      usageCache.set(scope, { at: Date.now(), value })
      return value
    },
  }

  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      const npm = PROTOCOLS[protocolOf(options.protocol)]
      const base = normalizeBase(options.baseURL || was.api || BASE)
      cfg.provider[PROVIDER] = {
        name: PROVIDER_NAME,
        npm,
        api: base,
        ...was,
        models: {
          ...Object.fromEntries(seedEntries(base, npm)),
          ...(was.models ?? {}),
        },
      }
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const base = baseOf(auth) || provider?.api || BASE
        const npm = npmOf(auth)
        if (auth?.type === "api" && auth.key) {
          try {
            const found = await listModels(base, auth.key, headersOf(auth))
            if (found.length) return Object.fromEntries(found.map((model) => modelEntry(model, base, npm)))
            log("BAILU: the key's model list came back empty; keeping the known list")
          } catch (error) {
            log(`BAILU: model list failed — ${error?.message || error}`)
          }
        }
        const known = Array.isArray(metaOf(auth).models) ? metaOf(auth).models : []
        if (known.length) return Object.fromEntries(known.map((model) => modelEntry(model, base, npm)))
        return provider?.models ?? Object.fromEntries(seedEntries(base, npm))
      },
    },

    auth: authHook,

    // Cloudflare challenges clients that lie about being a browser: a
    // "Chrome/131" UA over a non-browser TLS stack gets an HTML 403, while an
    // honest client UA reaches the gateway (verified against the live site).
    // Keep every request carrying this UA, whatever the SDK would send.
    "chat.headers": async (_input, output) => {
      try {
        output.headers ??= {}
        output.headers["user-agent"] = `magpie-bailucode/${VERSION}`
        output.headers.accept ??= "application/json"
        Object.assign(output.headers, options.headers ?? {})
      } catch {}
    },
  }
}

// for tests
export const _internal = {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  KEY_PAGE,
  PROTOCOLS,
  SEED_MODELS,
  normalizeBase,
  modelEntry,
  seedEntries,
  modelIds,
  protocolOf,
}