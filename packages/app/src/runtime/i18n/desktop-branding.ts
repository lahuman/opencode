const appMessages = new Set([
  "provider.connect.chatgptWelcome.description",
  "provider.connect.apiKey.description",
  "error.chain.mcpFailed",
  "settings.about.description",
  "settings.about.notices.description",
  "settings.general.row.language.description",
  "settings.general.row.colorScheme.description",
  "settings.general.row.theme.description",
  "project.settings.name.description",
  "project.settings.extensions.empty.mcps.description",
  "project.settings.extensions.empty.plugins.description",
  "project.settings.extensions.empty.skills.description",
  "settings.workspaces.empty.description",
])

export function desktopBrandTemplate(key: string, template: string) {
  if (!key.startsWith("desktop.") && !appMessages.has(key)) return template
  return template.replace(/OpenCode|OPENCODE/g, "CHAI")
}
