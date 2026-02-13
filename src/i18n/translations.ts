/**
 * Textos por idioma.
 * Para adicionar um novo idioma: copie um bloco existente (ex.: pt), altere a chave para o código do idioma (ex.: es, fr)
 * e preencha as strings. Depois registre o locale em index.ts (SUPPORTED_LOCALES e o objeto translations).
 */

export const pt = {
  someone: "Alguém",

  streamAnnounce: "🔴 **{name}** está ao vivo no {platform}!",
  streamAnnounceTitle: "\n*{title}*",

  cmdHelpGlobalTitle: "**Comandos APPL-E**",
  cmdHelpStreamTitle: "**Comandos APPL-E (streams)**",
  cmdHelpPing: "`!ping` – verificar se o bot está online",
  cmdHelpAddYoutube:
    "`!stream add youtube <channelId> <Nome>` – adicionar canal YouTube (ID começa com UC...)",
  cmdHelpAddTwitch:
    "`!stream add twitch <userId> <Nome>` – adicionar canal Twitch (ID numérico do usuário)",
  cmdHelpList: "`!stream list` – listar streamers",
  cmdHelpRemove: "`!stream remove <número>` – remover pelo índice da lista",
  cmdHelpStreamChannel: "• `!stream channel <#canal>` - Define canal de anúncios",
  cmdHelpStreamRole: "• `!stream role <@cargo>` - Define cargo para mencionar",
  cmdHelpStreamMessage: "• `!stream message <texto>` - Define mensagem personalizada",
  cmdHelpStreamInfo: "• `!stream info` - Ver configurações atuais",
  cmdHelpStreamTest: "• `!stream test` - Testa o anúncio de live",
  cmdHelpStreamReset: "• `!stream reset` - Limpa configurações",
  cmdHelpStreamHint: "• `!stream help` - Ver comandos de live",
  cmdHelpHelp: "`!help` – ver comandos básicos",
  cmdHelpHelpStream: "`!stream help` – ver comandos de live",

  cmdAlreadyInList: "Esse canal já está na lista.",
  cmdAdded: "Adicionado: **{name}** ({platform}).",
  cmdNoStreamers: "Nenhum streamer na lista. Use `!stream add ...`.",
  cmdStreamersHeader: "**Streamers:**",
  cmdInvalidIndex:
    "Índice inválido. Use `!stream list` para ver os números.",
  cmdRemoved: "Removido: **{name}** ({platform}).",
  cmdUseSettings: "Por favor, gerencie os streamers nas **Configurações do App**.",
  cmdManageInSettings: "Gerencie a lista nas Configurações do App.",
  cmdListFromSettings: "**Das Configurações:**",
  cmdListFromDB: "**Do Chat/Banco de Dados:**",

  cmdHelpLive: "`!stream live` – ver quem está ao vivo agora",
  cmdLiveHeader: "**Streamers Online agora:**",
  cmdLiveNone: "Ninguém está online no momento.",

  cmdHelpWelcome: "• `!welcome` - Configura boas-vindas",
  cmdHelpGoodbye: "• `!goodbye` - Configura despedida",
  cmdConfigSaved: "Configuração de **{type}** salva com sucesso!",
  cmdConfigReset: "Configurações de **{type}** resetadas!",
  cmdConfigInfo: "Estrutura atual de **{type}**:\n\n• Canal: {channel}\n• Mensagem: {message}\n• Imagem: {image}",
  cmdConfigInfoStream: "Configuração de **Stream**:\n\n• Canal: {channel}\n• Cargo: {role}\n• Mensagem: {message}",
  cmdConfigTestTriggered: "Teste de **{type}** disparado! Verifique o canal configurado.",
  cmdInvalidArg: "Argumento inválido. Use `!{cmd} help` para ver as opções.",

  permissionDenied: "❌ Você não tem permissão para usar este comando. Apenas usuários com o cargo de administrador do bot podem executá-lo.",
  adminRoleSet: "✅ Cargo de administrador do bot definido com sucesso! Apenas usuários com este cargo poderão configurar o bot.",
  adminRoleCleared: "✅ Requisito de cargo de administrador removido. Agora todos podem configurar o bot.",
  adminRoleCurrent: "Cargo de administrador atual: {role}",
  adminRoleNone: "Nenhum cargo de administrador configurado. Todos podem configurar o bot.",
  cmdHelpSet: "• `!set` - Configurações do bot",
  cmdHelpSetAdminRole: "• `!set adminRole <@cargo>` - Define cargo de administrador do bot",
  cmdHelpSetAdminRoleClear: "• `!set adminRole clear` - Remove requisito de cargo de admin",
  cmdHelpSetLanguage: "• `!set language <pt|en>` - Define idioma do bot",
  languageSet: "✅ Idioma do bot definido para: **{language}**",
  languageCurrent: "Idioma atual: **{language}**",
  languageInvalid: "❌ Idioma inválido. Use: `pt` ou `en`",
  publicCommandsHeader: "**📋 Comandos Públicos**",
  adminCommandsHeader: "**🔧 Comandos de Administração**",
} as const;

export const en = {
  someone: "Someone",

  streamAnnounce: "🔴 **{name}** is live on {platform}!",
  streamAnnounceTitle: "\n*{title}*",

  cmdHelpGlobalTitle: "**APPL-E Commands**",
  cmdHelpStreamTitle: "**APPL-E Commands (streams)**",
  cmdHelpPing: "`!ping` – check if bot is online",
  cmdHelpAddYoutube:
    "`!stream add youtube <channelId> <Name>` – add YouTube channel (ID starts with UC...)",
  cmdHelpAddTwitch:
    "`!stream add twitch <userId> <Name>` – add Twitch channel (numeric user ID)",
  cmdHelpList: "`!stream list` – list streamers",
  cmdHelpRemove: "`!stream remove <number>` – remove by list index",
  cmdHelpStreamChannel: "• `!stream channel <#channel>` - Set announcement channel",
  cmdHelpStreamRole: "• `!stream role <@role>` - Set role to mention",
  cmdHelpStreamMessage: "• `!stream message <text>` - Set custom message",
  cmdHelpStreamInfo: "• `!stream info` - View current settings",
  cmdHelpStreamTest: "• `!stream test` - Test live announcement",
  cmdHelpStreamReset: "• `!stream reset` - Clear settings",
  cmdHelpStreamHint: "• `!stream help` - View live commands",
  cmdHelpHelp: "`!help` – view basic commands",
  cmdHelpHelpStream: "`!stream help` – view live commands",

  cmdAlreadyInList: "That channel is already in the list.",
  cmdAdded: "Added: **{name}** ({platform}).",
  cmdNoStreamers: "No streamers in the list. Use `!stream add ...`.",
  cmdStreamersHeader: "**Streamers:**",
  cmdInvalidIndex: "Invalid index. Use `!stream list` to see the numbers.",
  cmdRemoved: "Removed: **{name}** ({platform}).",
  cmdUseSettings: "Please manage streamers in the **App Settings**.",
  cmdManageInSettings: "Manage the list in App Settings.",
  cmdListFromSettings: "**From Settings:**",
  cmdListFromDB: "**From Chat/Database:**",

  cmdHelpLive: "`!stream live` – see who is live right now",
  cmdLiveHeader: "**Currently Online Streamers:**",
  cmdLiveNone: "No one is online at the moment.",

  cmdHelpWelcome: "• `!welcome` - Configure welcome",
  cmdHelpGoodbye: "• `!goodbye` - Configure goodbye",
  cmdConfigSaved: "**{type}** configuration saved successfully!",
  cmdConfigReset: "**{type}** configurations reset!",
  cmdConfigInfo: "Current **{type}** structure:\n\n• Channel: {channel}\n• Message: {message}\n• Image: {image}",
  cmdConfigInfoStream: "**Stream** configuration:\n\n• Channel: {channel}\n• Role: {role}\n• Message: {message}",
  cmdConfigTestTriggered: "**{type}** test triggered! Check the configured channel.",
  cmdInvalidArg: "Invalid argument. Use `!{cmd} help` to see options.",

  permissionDenied: "❌ You don't have permission to use this command. Only users with the bot admin role can execute it.",
  adminRoleSet: "✅ Bot admin role set successfully! Only users with this role will be able to configure the bot.",
  adminRoleCleared: "✅ Admin role requirement removed. Everyone can now configure the bot.",
  adminRoleCurrent: "Current admin role: {role}",
  adminRoleNone: "No admin role configured. Everyone can configure the bot.",
  cmdHelpSet: "• `!set` - Bot settings",
  cmdHelpSetAdminRole: "• `!set adminRole <@role>` - Set bot admin role",
  cmdHelpSetAdminRoleClear: "• `!set adminRole clear` - Remove admin role requirement",
  cmdHelpSetLanguage: "• `!set language <pt|en>` - Set bot language",
  languageSet: "✅ Bot language set to: **{language}**",
  languageCurrent: "Current language: **{language}**",
  languageInvalid: "❌ Invalid language. Use: `pt` or `en`",
  publicCommandsHeader: "**📋 Public Commands**",
  adminCommandsHeader: "**🔧 Admin Commands**",
} as const;

export type TranslationKey = keyof typeof pt;
