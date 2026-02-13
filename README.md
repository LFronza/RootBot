# APPL-E

Bot para a plataforma [Root](https://rootapp.com), inspirado no [FBK](https://github.com/kabiiQ/FBK) (bot do Discord). Nome atual do bot: **APPL-E**. Funcionalidades principais:

- **Notificações de live** – Anuncia quando um streamer entra ao vivo no **YouTube** ou **Twitch** (com opção de mencionar um cargo).
- **Boas-vindas e despedida** – Mensagens automáticas quando um membro entra ou sai da comunidade (com variável `{nickname}`).
- **Cargo automático** – Atribui um cargo configurado a todos que entram na comunidade.
- **Comandos de stream** – No canal de anúncios de live: `!stream add`, `!stream list`, `!stream remove`, `!stream help`.

## Requisitos

- **Node.js 22+**
- Conta no [Root Developer Portal](https://dev.rootapp.com) para obter o **App ID** e o **DEV_TOKEN** (testes locais).

## Configuração

1. **Clone/abra o projeto** e instale dependências:

   ```bash
   npm install
   ```

2. **Manifest** – Em `root-manifest.json`, substitua `YOUR_APP_ID_FROM_DEVELOPER_PORTAL` pelo ID do seu app no Developer Portal.

3. **Variáveis de ambiente** (teste local) – Crie um arquivo `.env` na raiz (veja `.env.example`):

   ```
   DEV_TOKEN=seu_token_do_developer_portal
   COMMUNITY_ID=id_da_comunidade_de_teste
   ```

   O `COMMUNITY_ID` é o ID da comunidade onde o bot vai rodar (a comunidade `-test` criada ao gerar o DEV_TOKEN). Você encontra no Developer Portal ou nas configurações da comunidade no app Root.

4. **Build e execução (teste local)**:

   Para testar o bot na sua comunidade de teste, use o **DevHost** da Root (ele sobe um servidor local que conecta com a Root e roda seu bot):

   ```bash
   npm run build
   npm run bot
   ```

   O comando `npm run bot` inicia o DevHost, que lê o `.env` (DEV_TOKEN e COMMUNITY_ID), sobe o ambiente em `127.0.0.1:8090` e executa o APPL-E. Abra o app Root e entre na comunidade de teste para ver o bot em ação.

   Não use `npm start` para teste local: ele roda só o código do bot, que tenta conectar ao DevHost na porta 8090 e falha com "ECONNREFUSED" se o DevHost não estiver rodando.

## Configurações do app (na Root)

As opções abaixo são definidas pelos administradores da comunidade ao instalar/configurar o bot (Manage Apps).

### Geral

- **Language / Idioma** – Idioma das mensagens do APPL-E (Português ou English). Afeta anúncios de live, respostas dos comandos `!stream` e o fallback “Alguém”/“Someone” em welcome/goodbye.

### Boas-vindas e despedida

- **Canal de boas-vindas** – Onde enviar a mensagem quando alguém entrar.
- **Mensagem de boas-vindas** – Use `{nickname}` para o nome do membro.
- **Canal de despedida** e **Mensagem de despedida** – Idem para quem sair.

### Cargos

- **Cargo ao entrar** – Cargo atribuído automaticamente a novos membros.

### Notificações de live

- **Canal de anúncios de live** – Canal onde o bot publica “X está ao vivo no YouTube/Twitch”.
- **Cargo para mencionar** – (Opcional) Cargo mencionado nesses anúncios.
- **YouTube Data API Key** – Chave da [Google Cloud Console](https://console.cloud.google.com/) (YouTube Data API v3).
- **Twitch Client ID** e **Twitch Client Secret** – Do [Twitch Developer Console](https://dev.twitch.tv/console).

## Comandos de stream (no canal de anúncios)

- `!stream add youtube <channelId> <Nome>` – Adiciona canal YouTube. O **channelId** começa com `UC` (ex.: `UCxxxxxxxx`).
- `!stream add twitch <userId> <Nome>` – Adiciona canal Twitch. O **userId** é o **ID numérico** do usuário (não o login). Ex.: obter em [Twitch API](https://dev.twitch.tv/docs/api/reference#get-users) ou ferramentas como [Twitch Tracker](https://twitchtracker.com/).
- `!stream list` – Lista streamers cadastrados.
- `!stream remove <número>` – Remove pelo índice da lista (use `!stream list` para ver os números).
- `!stream help` – Mostra a ajuda.

## Estrutura do projeto

- `src/main.ts` – Ponto de entrada, lifecycle e registro dos módulos.
- `src/welcome.ts` – Boas-vindas e despedida (eventos `CommunityJoined` / `CommunityLeave`).
- `src/roles.ts` – Cargo automático ao entrar.
- `src/streams.ts` – Checagem de lives (Job Scheduler + YouTube/Twitch APIs) e anúncios.
- `src/commands.ts` – Comandos `!stream` no canal de anúncios.
- `src/types.ts` – Tipos e constantes compartilhados.
- `src/i18n/` – **Idiomas**: `translations.ts` (textos em pt/en), `index.ts` (função `t(locale, key, params)`). Para adicionar um idioma, veja o comentário no topo de `src/i18n/index.ts`.
- `root-manifest.json` – Manifest do APPL-E (ID, versão, package, settings, permissions).

## Referências

- [Root Bot developer home](https://docs.rootapp.com/docs/bot-docs/bot-home/)
- [Root Community API](https://docs.rootapp.com/docs/bot-docs/develop/community-api/)
- [FBK (Discord)](https://github.com/kabiiQ/FBK) – Inspiração para notificações de live, welcome e cargos.
