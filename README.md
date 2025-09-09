# Bot WhatsApp com whatsapp-web.js

Este projeto é um bot simples para WhatsApp utilizando a biblioteca [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).  
Ele permite gerar stickers a partir de imagens ou vídeos enviados pelos usuários e salvar esses arquivos no servidor.  

## Funcionalidades

- Conexão com o WhatsApp via QR Code.  
- Comando `!sticker`:  
  - Ativa o modo de espera.  
  - O próximo envio de imagem ou vídeo será transformado em sticker.  
  - O sticker gerado é salvo no diretório `./temp`.  
  - O nome do arquivo é registrado no `stickers.json`, vinculado ao número do usuário que o criou.  
  - Caso o usuário envie outra coisa que não seja imagem ou vídeo, o processo é cancelado.  
- Comando `!todos`:  
  - Envia todos os stickers criados **pelo próprio usuário**.  
  - Caso o usuário não tenha criado nenhum sticker, informa que não há stickers disponíveis para ele.  

## Requisitos

- Node.js LTS instalado.  
- Uma conta ativa no WhatsApp.  
- Dependências instaladas via `npm install`.  
