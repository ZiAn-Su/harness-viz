// Native OpenCode configuration stays authoritative. Only SDK transport is observed.
export default async function observer() {
  const proxy = process.env.HARNESS_VIZ_PROXY
  const providers = JSON.parse(process.env.HARNESS_VIZ_PROVIDERS ?? "[]")
  return {
    config(config) {
      if (!proxy) return
      config.provider ??= {}
      for (const id of providers) {
        const item = config.provider[id] ??= {}
        item.options ??= {}
        const previous = item.options.fetch
        item.options.fetch = async (input, init) => {
          const url = new URL(typeof input === "string" ? input : input.url ?? input.href)
          if (!/\/(messages|responses|chat\/completions)$/.test(url.pathname) || init?.method && init.method !== "POST") return (previous ?? fetch)(input, init)
          const headers = new Headers(init?.headers)
          headers.set("x-harness-upstream-url", url.href)
          headers.set("x-harness-provider", id)
          return fetch(proxy + "/opencode-observe", { ...init, headers })
        }
      }
    },
  }
}
