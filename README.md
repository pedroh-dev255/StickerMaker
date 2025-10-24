# Bot WhatsApp com whatsapp-web.js

Este projeto é um bot para WhatsApp utilizando a biblioteca [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).  
Ele permite gerar stickers a partir de imagens ou vídeos enviados pelos usuários, salvar esses arquivos no servidor e exibir relatórios de stickers criados.

## Funcionalidades

### Conexão
- Conexão com o WhatsApp via QR Code.  

### Comando `!sticker`
- Ativa o modo de espera para gerar **um sticker único**.  
- O próximo envio de imagem ou vídeo será transformado em sticker.  
- O arquivo original é salvo no diretório `./temp`.  
- Os dados de quem criou o sticker são salvos no banco de dados MySQL.  
- Caso o usuário envie outro tipo de arquivo que não seja imagem ou vídeo, o processo é cancelado.  

### Comando `!stickers`
- Ativa o modo de múltiplos stickers.  
- Permite enviar **várias imagens ou vídeos** consecutivos.  
- O usuário deve digitar `!pronto` quando terminar.  
- Todos os arquivos válidos enviados entre `!stickers` e `!pronto` serão processados e transformados em stickers.  
- Se algum arquivo for inválido ou houver erro, o bot avisa, mas processa os arquivos válidos normalmente.  

### Comando `!pronto`
- Finaliza a sessão de múltiplos stickers iniciada pelo `!stickers`.  
- Processa todos os arquivos enviados na sessão.  
- Exibe um resumo indicando **quantos stickers foram processados com sucesso** e quantos **falharam**.  

### Comando `!todos`
- Exibe um **relatório resumido** dos stickers criados pelo usuário.  
- Mostra o total de stickers, quantos foram criados em grupos e quantos em chats privados.  
- Para visualizar os stickers, instrui o usuário a usar o comando `!exibir`.  

### Comando `!exibir [página]`
- Exibe os stickers do usuário de forma **paginada**, 5 stickers por página.  
- Se nenhum número de página for fornecido, exibe a **primeira página**.  
- Informa o total de páginas (`Página X de Y`).  
- Caso algum sticker não exista mais, exibe: `"O sticker X não está mais acessível"`.  

## Requisitos

- Node.js LTS instalado.
- Banco de dados MYSQL
- Uma conta ativa no WhatsApp.  
- Dependências instaladas via `npm install`.  

## Estrutura de arquivos

- `index.js` – arquivo principal do bot.  
- `./temp` – diretório onde os arquivos são salvos.  
- `.env` – arquivo com as credenciais do banco de dados MySQL.  

## Banco de Dados

- MySQL é usado para registrar os stickers criados pelos usuários.  
- Tabela `stickers`:
  - `id` – identificador do sticker.  
  - `contact_name` – nome do usuário que criou o sticker.  
  - `contact_id` – ID do contato no WhatsApp.  
  - `is_group` – indica se o sticker foi enviado em grupo (1) ou privado (0).  
  - `group_name` – nome do grupo, se aplicável.  
  - `file_name` – nome do arquivo do sticker no diretório `./temp`.  

## Observações

- Todos os stickers são enviados **como stickers do WhatsApp**.  
- O bot processa imagens e vídeos, ignorando arquivos inválidos.  
- O processamento de múltiplos stickers é feito **em paralelo** para maior eficiência.  
