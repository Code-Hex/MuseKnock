export const localBearerTokens = ['HOOK_TOKEN', 'MCP_TOKEN', 'MCP_ADMIN_TOKEN'] as const
type TokenName = (typeof localBearerTokens)[number] | 'MCP_RECOVERY_TOKEN'

export function distinctBearerTokens(config: Partial<Record<TokenName, string>>) {
  const values = [
    ...localBearerTokens.map((name) => config[name]),
    config.MCP_RECOVERY_TOKEN,
  ].filter(Boolean)
  return new Set(values).size === values.length
}
