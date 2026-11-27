# Bot WhatsApp com Baileys

Bot para WhatsApp desenvolvido em Node.js utilizando a biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys).

O projeto permite criar stickers a partir de imagens e vídeos, incluindo **Sound Stickers (figurinhas com áudio)**, armazenar os arquivos no servidor e registrar as informações no MySQL.

## Funcionalidades

### Conexão com WhatsApp

- Conexão utilizando a biblioteca Baileys.
- Autenticação por QR Code.
- Persistência da sessão no diretório `baileys_auth/` por padrão.
- Reconexão automática em caso de desconexão, conforme o tipo de encerramento da conexão.

### Comando `!sticker`

Inicia o modo de criação de um único sticker.

- O próximo envio de imagem ou vídeo pelo usuário será convertido em sticker.
- Imagens são convertidas para WebP.
- Vídeos são convertidos para WebP animado.
- Vídeos com áudio podem ser convertidos em Sound Stickers.
- O processamento respeita os limites de duração e tamanho configurados.
- Os arquivos são armazenados no diretório `./temp`.
- Os dados do sticker e de seu criador são registrados no MySQL.
- O modo de espera é encerrado após o processamento ou quando o envio é inválido.

### Comando `!stickers`

Inicia uma sessão para criação de múltiplos stickers.

- Permite enviar várias imagens e vídeos consecutivamente.
- Os arquivos recebidos são adicionados à fila da sessão.
- O processamento é realizado após o comando `!pronto`.
- Arquivos inválidos ou que apresentem erros não impedem o processamento dos demais.
- Cada sticker processado é registrado individualmente no banco de dados.

### Comando `!pronto`

Finaliza a sessão de múltiplos stickers.

- Encerra o recebimento de arquivos da sessão.
- Processa os arquivos recebidos.
- Informa a quantidade de stickers criados com sucesso e a quantidade de falhas.

### Comando `!todos`

Apresenta um resumo dos stickers registrados pelo usuário.

- Quantidade total de stickers criados.
- Quantidade criada em grupos.
- Quantidade criada em conversas privadas.
- Orientação para utilizar `!exibir` e visualizar os stickers.

### Comando `!relatorio`

Apresenta um relatório dos stickers armazenados no sistema, com informações consolidadas sobre os registros existentes.

### Comando `!exibir [página]`

Permite consultar os stickers criados pelo usuário.

- Exibição paginada, com 5 stickers por página.
- Sem número de página, exibe a primeira página.
- Informa a página atual e o total de páginas.
- Permite navegar informando o número da página.
- Identifica stickers cujos arquivos não estejam mais disponíveis.

## Stickers e processamento de mídia

O processamento de imagens e vídeos é realizado com FFmpeg e FFprobe.

### Imagens

- Conversão para WebP.
- Redimensionamento respeitando a proporção original.
- Limite de dimensão de referência de 512 pixels.
- Preservação de transparência quando suportada pelo arquivo de origem.

### Vídeos

- Conversão para WebP animado.
- Ajuste adaptativo de resolução, FPS e qualidade para respeitar o limite de tamanho.
- Limite padrão de duração de 25 segundos.
- Limite de tamanho do sticker de 500 KiB.
- Vídeos com áudio podem gerar Sound Stickers.

### Sound Stickers

O bot possui suporte experimental para figurinhas com áudio.

- O vídeo original é utilizado para gerar o sticker animado.
- O áudio é extraído e convertido para OGG/Opus.
- O áudio é enviado associado ao sticker utilizando a estrutura de mensagem compatível com Sound Stickers.
- Limite padrão de áudio de 2 MiB.
- Bitrate padrão de áudio de 32 kbps.

O suporte a Sound Stickers depende da compatibilidade do formato experimental utilizado com a versão do WhatsApp.

## Requisitos

- Node.js 22.12 ou superior.
- MySQL.
- FFmpeg.
- FFprobe.
- Conta ativa no WhatsApp.
- Dependências do projeto instaladas com `npm install`.

## Instalação

Clone o repositório:

```bash
git clone <URL_DO_REPOSITORIO>
cd <DIRETORIO_DO_PROJETO>
```

Instale as dependências:

```bash
npm install
```

Configure as variáveis de ambiente no arquivo `.env`.

Inicie o bot:

```bash
node index.js
```

Na primeira execução, será necessário escanear o QR Code exibido no terminal para autenticar a conta do WhatsApp.

A autenticação será armazenada no diretório configurado em `SESSION_DIR`, evitando a necessidade de autenticar novamente a cada inicialização.

## Configuração

As configurações são realizadas por meio de variáveis de ambiente no arquivo `.env`.

### Banco de dados

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASS=sua_senha
DB_NAME=whatsapp_bot
DB_CONNECTION_LIMIT=10
```

### Processamento de mídia

```env
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe

MAX_VIDEO_SECONDS=25
MAX_STICKER_BYTES=512000
MAX_AUDIO_BYTES=2097152

AUDIO_BITRATE=32k
```

### Sessão e logs

```env
SESSION_DIR=baileys_auth
LOG_LEVEL=info
```

| Variável | Descrição |
|---|---|
| `DB_HOST` | Endereço do servidor MySQL |
| `DB_PORT` | Porta do MySQL |
| `DB_USER` | Usuário do banco |
| `DB_PASS` | Senha do banco |
| `DB_NAME` | Nome do banco de dados |
| `DB_CONNECTION_LIMIT` | Limite de conexões simultâneas do pool |
| `FFMPEG_PATH` | Caminho do executável FFmpeg |
| `FFPROBE_PATH` | Caminho do executável FFprobe |
| `MAX_VIDEO_SECONDS` | Duração máxima permitida para vídeos |
| `MAX_STICKER_BYTES` | Tamanho máximo do sticker em bytes |
| `MAX_AUDIO_BYTES` | Tamanho máximo do áudio em bytes |
| `AUDIO_BITRATE` | Bitrate utilizado na conversão do áudio |
| `SESSION_DIR` | Diretório de autenticação do WhatsApp |
| `LOG_LEVEL` | Nível de detalhamento dos logs |

Os valores apresentados são os padrões utilizados quando as variáveis correspondentes não são configuradas.

## Banco de dados

O projeto utiliza MySQL para armazenar os registros dos stickers.

### Tabela `stickers`

A tabela armazena informações sobre o criador, a conversa de origem e os arquivos associados ao sticker.

| Campo | Descrição |
|---|---|
| `id` | Identificador do registro |
| `contact_name` | Nome do usuário que criou o sticker |
| `contact_id` | Identificador do contato no WhatsApp |
| `is_group` | Indica se o sticker foi criado em grupo (`1`) ou conversa privada (`0`) |
| `group_name` | Nome do grupo, quando aplicável |
| `file` | Nome ou referência do arquivo WebP armazenado |
| `audio_file_name` | Nome ou referência do arquivo de áudio, quando existente |
| `is_sound` | Indica se o registro corresponde a um Sound Sticker |

Os campos relacionados a áudio são utilizados para identificar e armazenar os arquivos associados aos Sound Stickers.

## Estrutura de arquivos

```text
projeto/
├── index.js
├── package.json
├── package-lock.json
├── .env
├── baileys_auth/
└── temp/
```

| Arquivo / Diretório | Finalidade |
|---|---|
| `index.js` | Código principal do bot |
| `package.json` | Dependências e configurações do projeto |
| `.env` | Configurações de ambiente e credenciais |
| `baileys_auth/` | Credenciais e dados de autenticação do WhatsApp |
| `temp/` | Armazenamento dos stickers e arquivos de mídia |

## Observações

- O projeto utiliza Baileys, não `whatsapp-web.js`.
- São aceitos arquivos de imagem e vídeo.
- Os vídeos podem gerar stickers animados silenciosos ou Sound Stickers, dependendo da presença de áudio e do processamento.
- O processamento utiliza FFmpeg e FFprobe.
- Os registros são armazenados no MySQL.
- A autenticação do WhatsApp é persistida localmente.
- O processamento de mídia utiliza uma fila para organizar as conversões.
- Os limites de duração e tamanho podem ser ajustados pelas variáveis de ambiente.
- O suporte a Sound Stickers utiliza uma implementação experimental do protocolo do WhatsApp.
