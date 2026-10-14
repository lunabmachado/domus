# Domus — sua própria plataforma de automação de Instagram

Alternativa caseira ao ManyChat: você cria automações que respondem sozinhas no seu Instagram, com **gatilhos**, **mensagens com botões** e **condições (se/senão) que podem ter outras condições dentro**, sem pagar mensalidade. Usa a API oficial da Meta, então não arrisca bloqueio da conta.

## O que dá para fazer

**Gatilhos**
- Alguém **comentou** em um post/reel (com palavra-chave, numa publicação específica ou em qualquer uma)
- Alguém **mandou DM** com uma palavra-chave (ou qualquer mensagem)
- Alguém **respondeu um story**
- Alguém **mencionou você no story**

**Passos do fluxo**
| Passo | O que faz |
|---|---|
| Enviar mensagem | Texto (com `{{name}}`, `{{username}}`, `{{last_reply}}`, `{{var.campo}}`), imagem e até 13 botões de resposta rápida |
| Condição (se / senão) | Regras com "todas" ou "qualquer": segue minha conta, última resposta contém/igual/é e-mail/é número/maior que…, tem etiqueta, campo salvo, @usuário. Dentro de "Então" e "Senão" você pode colocar **outras condições, sem limite** |
| Aguardar resposta | Pausa até a pessoa responder (ou tocar num botão), salva a resposta num campo e, opcionalmente, tem um ramo "se não responder em X minutos" |
| Esperar um tempo | Segundos, minutos, horas ou dias |
| Responder o comentário | Resposta pública no comentário ("Te mandei no direct!") |
| Etiquetas e campos | Marca contatos (`vip`, `lead_quente`…) e salva dados (e-mail, nome…) |
| Encerrar fluxo | Para tudo ali |

Também tem **simulador** (testa os fluxos sem Instagram), **lista de contatos** com histórico das conversas e **modelos prontos** ("comentou EU QUERO → recebe o link", "qualificação de lead").

## Rodando no seu computador

Precisa do **Node.js 22.5 ou mais novo** (não precisa instalar banco de dados — usa SQLite embutido).

```bash
npm install
cp .env.example .env     # edite a senha
npm start
```

Abra http://localhost:3000. Sem as credenciais do Instagram tudo funciona em **modo simulação** — use a aba *Simulador* para testar.

```bash
npm test   # roda os testes do motor
```

## Conectando ao seu Instagram

Requisitos: conta do Instagram **profissional** (Criador ou Empresa) e o Domus publicado num endereço **https** público (veja "Colocando no ar").

1. Em https://developers.facebook.com crie um app do tipo **Empresa** e adicione o produto **Instagram** → *API setup with Instagram login*.
2. Em **Generate access tokens**, adicione sua conta e gere o token → `IG_ACCESS_TOKEN`. O ID que aparece ao lado da conta → `IG_USER_ID`.
3. Em *App settings → Basic*, copie o **App secret** → `META_APP_SECRET`.
4. Invente um texto qualquer para `WEBHOOK_VERIFY_TOKEN`.
5. Em **Configure webhooks**:
   - Callback URL: `https://SEU-DOMINIO/webhook`
   - Verify token: o mesmo do passo 4
   - Assine os campos `comments`, `messages` e `messaging_postbacks`.
6. No app Instagram do celular: *Configurações → Mensagens e respostas a stories → Controles de mensagens → Ferramentas conectadas* → ative **Permitir acesso às mensagens**.
7. Reinicie o Domus. A aba *Configuração* mostra se está tudo verde.

Enquanto o app da Meta estiver em **modo de desenvolvimento**, as automações só funcionam para contas adicionadas como testadoras do app. Para funcionar com qualquer seguidor, envie o app para **App Review** pedindo `instagram_business_basic`, `instagram_business_manage_messages` e `instagram_business_manage_comments` (é gratuito; a Meta pede um vídeo mostrando o uso). Contas que só usam o próprio app costumam ser aprovadas sem grandes dificuldades.

> O token gerado no painel dura ~60 dias. Renove em *Generate access tokens* (ou pela rota `refresh_access_token` da API) antes de expirar.

## Regras do Instagram que valem a pena saber

- **Comentário → DM:** o Instagram deixa mandar **uma** mensagem privada por comentário (até 7 dias depois). Por isso os fluxos de comentário seguem o padrão do ManyChat: a primeira mensagem tem um botão ("Quero o link") e depois vem *Aguardar resposta*. Quando a pessoa toca no botão, a conversa abre e você pode mandar quantas mensagens quiser. O Domus faz isso automaticamente: a primeira mensagem de um fluxo de comentário vai como resposta privada.
- **Janela de 24h:** depois que a pessoa manda mensagem, você pode responder por 24h. Delays maiores que isso podem falhar no envio (o erro aparece no histórico do contato).
- **"Segue minha conta"** só é confiável depois que a pessoa já conversou com você no direct (por isso, no modelo, a condição vem depois do botão).
- A primeira automação ativa (mais antiga) que combinar com o evento é a que roda. Se a pessoa estiver no meio de um fluxo esperando resposta, a resposta dela continua esse fluxo.

## Colocando no ar (barato ou de graça)

Qualquer lugar que rode Node e mantenha um disco persistente serve:

- **VPS** (Hetzner, Contabo, Oracle Cloud Free Tier…): `npm install && npm start` com `pm2` ou systemd, atrás de um Caddy/Nginx com https.
- **Railway / Render / Fly.io**: aponte para este repositório, comando `npm start`, e monte um volume persistente no caminho de `DB_PATH`.
- Para testar do seu computador: `npx cloudflared tunnel --url http://localhost:3000` gera um https público temporário.

Defina sempre `ADMIN_PASSWORD` — o painel pede usuário `admin` e essa senha.

## Estrutura

```
src/
  server.js     API do painel, webhook e agendador
  engine.js     motor: gatilhos, passos, condições aninhadas, esperas
  webhook.js    leitura e validação dos webhooks da Meta
  instagram.js  chamadas à Instagram Graph API
  db.js         banco SQLite (automações, contatos, mensagens, agendamentos)
public/         painel (HTML/CSS/JS puro, sem build)
test/           testes do motor
```
