# Bot WhatsApp com whatsapp-web.js

Este projeto é um bot simples para WhatsApp utilizando a biblioteca [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).  
Ele permite gerar stickers a partir de imagens ou vídeos enviados pelos usuários e salvar esses arquivos no servidor.  

## Funcionalidades

- Conexão com o WhatsApp via QR Code.  
- Comando `!sticker`:  
  - Ativa o modo de espera.  
  - O próximo envio de imagem ou vídeo será transformado em sticker.  
  - O sticker gerado é salvo no diretório `./temp`.  
  - Caso o usuário envie outra coisa que não seja imagem ou vídeo, o processo é cancelado.  
- Comando `!todos`:  
  - Envia todos os stickers já salvos no diretório `./temp`.  
  - Caso não existam stickers salvos, informa que não há arquivos disponíveis.   

## Requisitos

- Node.js LTS instalado.  
- Uma conta ativa no WhatsApp.  
- Dependências instaladas via `npm install`.  
