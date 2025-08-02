const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const os = require('os');
const axios = require('axios');
const WebSocket = require('ws');
const url_whatts = process.env.URL_WHATS || 'http://whts.neurelix.com.br';
const MEDIA_API_URL = url_whatts + '/chat/getBase64FromMediaMessage/Giuseph';
const MEDIA_API_KEY = process.env.MEDIA_API_KEY || 'jesuseateu';
const url_transcricao = process.env.URL_TRANSCRICAO + '/Audio' || 'http://10.100.10.113:8098/Audio';

require('dotenv').config();

const app = express();
const prisma = new PrismaClient();

// Criar servidor HTTP
const server = require('http').createServer(app);

// Criar servidor WebSocket
const wss = new WebSocket.Server({ server });

// Armazenar conexões ativas
const clients = new Map();

// Armazenar mensagens pendentes para cada chat
const pendingMessages = new Map();

// Função para monitorar novas mensagens no banco
async function monitorNewMessages() {
  console.log('\n=== Iniciando Monitoramento do Banco ===');
  
  // Buscar última mensagem para usar como ponto de partida
  const lastMessage = await prisma.message.findFirst({
    orderBy: { messageTimestamp: 'desc' }
  });
  
  let lastTimestamp = lastMessage ? lastMessage.messageTimestamp : 0;
  console.log('Timestamp inicial:', new Date(lastTimestamp * 1000).toLocaleString());
  
  // Função para verificar novas mensagens
  async function checkNewMessages() {
    try {
      const newMessages = await prisma.message.findMany({
        where: {
          messageTimestamp: {
            gt: lastTimestamp
          }
        },
        orderBy: { messageTimestamp: 'asc' }
      });

      if (newMessages.length > 0) {
        console.log(`\n=== ${newMessages.length} Novas Mensagens Encontradas ===`);
        
        for (const message of newMessages) {
          // Atualizar último timestamp
          lastTimestamp = message.messageTimestamp;
          
          // Verificar se é uma mensagem de mídia que precisa ser convertida
          const isMedia = ['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage' , 'stickerMessage'].includes(message.messageType);
          const hasBase64 = Boolean(message.mediaBase64);
          
          if (isMedia && !hasBase64) {
            try {
              console.log(`\n=== Convertendo Mídia ===`);
              console.log('ID da Mensagem:', message.id);
              console.log('Tipo:', message.messageType);
              console.log('Mensagem completa:', JSON.stringify(message, null, 2));
              
              // Preparar a mensagem para a API
              const messageForApi = {
                key: message.key,
                message: message.message,
                messageType: message.messageType,
                messageTimestamp: message.messageTimestamp,
                pushName: message.pushName,
                status: message.status
              };

              const conv = await axios.post(MEDIA_API_URL, {
                message: messageForApi,
                convertToMp4: false,
                instanceId: message.key.remoteJid.split('@')[0] // Extrair o ID da instância do remoteJid
              }, {
                headers: { 
                  apikey: MEDIA_API_KEY,
                  'Content-Type': 'application/json'
                },
                timeout: 30000
              });

              const b64 = conv.data.base64;
              if (b64) {
                console.log('Mídia convertida com sucesso');
                let transcricao_texto = '';
                if (message.messageType === 'audioMessage') {
                  console.log('Iniciando transcricao...');
                  const payload = {
                    "nome": "audio.mp3",
                    "conteudo": b64,
                    "tipo": "medium"
                  }
                  try {
                    const transcricao = await axios.post(url_transcricao, payload);
                    console.log('Transcricao:', transcricao.data);
                    transcricao_texto = transcricao.data.transcricao || '';
                    
                    const updatedMessage_transcription = await prisma.message.update({
                      where: { id: message.id },
                      data: {transcription: transcricao_texto }
                    });
                    console.log('Transcricao:', updatedMessage_transcription);
                  } catch (error) {
                    console.error('Erro na transcrição:', error);
                  }
                }
                const updatedMessage = await prisma.message.update({
                  where: { id: message.id },
                  data: { mediaBase64: b64 }
                });

                // Atualizar a mensagem no banco
                
                
                // Notificar com a mensagem atualizada
                await notifyNewMessage(message.key.remoteJid, updatedMessage);
              } else {
                console.log('Mídia não pôde ser convertida - resposta sem base64');
                // Notificar mesmo sem a conversão
                await notifyNewMessage(message.key.remoteJid, message);
              }
            } catch (err) {
              console.error(`Erro ao converter mídia ${message.key.id}:`, {
                error: err.message,
                response: err.response?.data,
                message: message
              });
              // Notificar mesmo com erro na conversão
              await notifyNewMessage(message.key.remoteJid, message);
            }
          } else {
            // Se não for mídia ou já tiver base64, notifica normalmente
            await notifyNewMessage(message.key.remoteJid, message);
          }
        }
      }
    } catch (error) {
      console.error('Erro ao verificar novas mensagens:', error);
    }
  }

  // Verificar novas mensagens a cada 1 segundo
  setInterval(checkNewMessages, 1000);
}

// Iniciar monitoramento
monitorNewMessages();

// Função para notificar clientes sobre novas mensagens
async function notifyNewMessage(chatId, message) {
  console.log('\n=== Nova Mensagem Recebida ===');
  console.log('Chat:', chatId);
  console.log('ID da Mensagem:', message.id);
  console.log('Tipo:', message.messageType);
  console.log('Conteúdo:', message.message);
  console.log('Timestamp:', new Date(message.messageTimestamp * 1000).toLocaleString());
  console.log('De:', message.key?.fromMe ? 'Eu' : message.pushName || 'Desconhecido');
  console.log('===========================\n');
  
  let notificados = 0;
  
  // Notificar todos os clientes que estão inscritos neste chat
  clients.forEach((ws, clientId) => {
    if (ws.chatId === chatId && ws.readyState === WebSocket.OPEN) {
      const notification = JSON.stringify({
        type: 'new_message',
        message: {
          ...message,
          key: message.key || { fromMe: false }
        }
      });
      console.log(`Enviando notificação para cliente ${clientId}`);
      ws.send(notification);
      notificados++;
    }
  });
  
  // Se não houver clientes conectados, armazena a mensagem
  if (notificados === 0) {
    if (!pendingMessages.has(chatId)) {
      pendingMessages.set(chatId, []);
    }
    pendingMessages.get(chatId).push(message);
    console.log(`Mensagem armazenada para envio posterior (${pendingMessages.get(chatId).length} mensagens pendentes)`);
  }
  
  console.log(`Notificação enviada para ${notificados} clientes\n`);
}

app.use(cors());
app.use(express.json());

// Middleware para extrair instanceId do header
app.use((req, res, next) => {
  // Extrair instanceId do header
  req.instanceId = req.headers.instanceid || 'Giuseph'; // Default fallback
  next();
});

// Gerenciar conexões WebSocket
wss.on('connection', (ws) => {
  console.log('\n=== Nova Conexão WebSocket ===');
  const clientId = Date.now().toString();
  clients.set(clientId, ws);
  console.log('ID do Cliente:', clientId);
  console.log('Total de Clientes:', clients.size);
  console.log('===========================\n');

  // Enviar ID para o cliente
  ws.send(JSON.stringify({
    type: 'connection',
    clientId
  }));

  // Lidar com mensagens do cliente
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('\n=== Mensagem do Cliente ===');
      console.log('Cliente:', clientId);
      console.log('Tipo:', data.type);
      console.log('Dados:', data);
      console.log('===========================\n');
      
      switch (data.type) {
        case 'subscribe_chat':
          // Cliente quer receber atualizações de um chat específico
          ws.chatId = data.chatId;
          console.log(`Cliente ${clientId} inscrito no chat ${data.chatId}`);
          
          // Enviar mensagens pendentes para este chat
          const pending = pendingMessages.get(data.chatId) || [];
          if (pending.length > 0) {
            console.log(`\n=== Enviando Mensagens Pendentes ===`);
            console.log(`Chat: ${data.chatId}`);
            console.log(`Quantidade: ${pending.length}`);
            pending.forEach((msg, index) => {
              console.log(`\nMensagem ${index + 1}:`);
              console.log('ID:', msg.id);
              console.log('Tipo:', msg.messageType);
              console.log('Timestamp:', new Date(msg.messageTimestamp * 1000).toLocaleString());
            });
            console.log('===============================\n');
            
            pending.forEach(msg => {
              ws.send(JSON.stringify({
                type: 'new_message',
                message: msg
              }));
            });
            pendingMessages.delete(data.chatId);
          }
          break;
          
        case 'unsubscribe_chat':
          // Cliente não quer mais receber atualizações
          console.log(`Cliente ${clientId} cancelou inscrição do chat ${ws.chatId}`);
          delete ws.chatId;
          break;
      }
    } catch (error) {
      console.error('Erro ao processar mensagem WebSocket:', error);
    }
  });

  // Lidar com desconexão
  ws.on('close', () => {
    console.log('\n=== Cliente Desconectado ===');
    console.log('ID:', clientId);
    console.log('Chat:', ws.chatId);
    console.log('Clientes Restantes:', clients.size - 1);
    console.log('===========================\n');
    clients.delete(clientId);
  });
});

// Função para obter o IP local
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Ignora endereços IPv6 e interfaces não IPv4
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Get all conversations
app.get('/api/conversations', async (req, res) => {
  try {
    // Busca todos os chats ordenados
    const chats = await prisma.chat.findMany({
      orderBy: {
        updatedAt: 'desc'
      }
    });
    const contacts = await prisma.contact.findMany();
    
    chats.forEach(chat => {
      const contact = contacts.find(contact => contact.remoteJid === chat.remoteJid);
      // Se tiver foto de perfil, usa ela, senão usa a primeira letra do nome
      chat.avatar = contact?.profilePicUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(chat.name || chat.remoteJid)}&background=random`;
      
      // Lógica de prioridade para o nome
      if (contact?.nome_edit) {
        chat.name = contact.nome_edit;
      } else if (contact?.Ultimo_nome) {
        chat.name = contact.Ultimo_nome;
      } else if (contact?.pushName) {
        chat.name = contact.pushName;
      } else {
        chat.name = chat.remoteJid;
      }
    });
    
    res.json(chats);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Buscar chat por remoteJid
app.get('/api/chats/:remoteJid', async (req, res) => {
  try {
    const chat = await prisma.chat.findFirst({
      where: {
        remoteJid: req.params.remoteJid
      }
    });
    const contact = await prisma.contact.findFirst({
      where: {
        remoteJid: req.params.remoteJid
      }
    });
    // Se tiver foto de perfil, usa ela, senão usa a primeira letra do nome
    chat.avatar = contact?.profilePicUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(chat.name || chat.remoteJid)}&background=random`;
    chat.name = contact?.pushName || chat.remoteJid;
    res.json(chat);
  } catch (error) {
    console.error('Error fetching chat:', error);
    res.status(500).json({ error: 'Failed to fetch chat' });
  }
});

app.get('/api/chats/:remoteJid/messages', async (req, res) => {
  try {
    const instanceId = req.query.instanceId || req.instanceId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    
    // 1) Busca as mensagens com paginação usando o campo instanceId para otimização
    let messages = await prisma.message.findMany({
      where: {
        AND: [
          {
            key: {
              path: ['remoteJid'],
              equals: req.params.remoteJid
            }
          },
          {
            instanceId: instanceId // Usar o campo instanceId da tabela para otimização
          }
        ]
      },
      orderBy: { messageTimestamp: 'desc' },
      take: limit,
      skip: skip
    });

    // 2) Para cada mídia sem base64, chamar a API e atualizar no DB
    for (const msg of messages) {
      const isMedia = ['imageMessage','audioMessage', 'videoMessage', 'documentMessage' , 'stickerMessage'].includes(msg.messageType);
      const hasBase64 = Boolean(msg.mediaBase64);
      if (isMedia && !hasBase64) {
        try {
          console.log(`Convertendo mídia para mensagem ${msg.id}`);
          const conv = await axios.post(MEDIA_API_URL, {
            message: {
              key: msg.key,
              message: msg.message,
              messageType: msg.messageType,
              messageTimestamp: msg.messageTimestamp,
              pushName: msg.pushName,
              status: msg.status,
              mediaKey: msg.message[msg.messageType]?.mediaKey
            },
            convertToMp4: true,
            instanceId: instanceId // Usar instanceId do header ou query
          }, {
            headers: { 
              apikey: MEDIA_API_KEY,
              'Content-Type': 'application/json'
            },
            timeout: 3000
          });

          const b64 = conv.data.base64;
          if (b64) {
            console.log(`Mídia convertida para mensagem ${msg.id}, atualizando banco...`);
            // 3) Salva no banco
            const updatedMsg = await prisma.message.update({
              where: { id: msg.id },
              data: { mediaBase64: b64 }
            });
            
            // Atualiza a mensagem local
            msg.mediaBase64 = b64;

            // Notifica os clientes sobre a atualização da mídia
            console.log(`Notificando clientes sobre atualização da mídia ${msg.id}`);
            await notifyNewMessage(req.params.remoteJid, updatedMsg);
          }
        } catch (err) {
          console.error(`Falha ao converter media ${msg.key.id}:`, err.message);
        }
      }
    }

    // 4) Devolve as mensagens (agora com mediaBase64 quando disponível)
    res.json(messages);

  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/', async (req, res) => {
  res.send('Hello World');
});

// Get all contacts
app.get('/api/contacts', async (req, res) => {
  try {
    const instanceId = req.instanceId;
    
    const contacts = await prisma.contact.findMany({
      where: {
        instanceId: instanceId
      },
      orderBy: {
        updatedAt: 'desc'
      }
    });

    // Processa os contatos para mostrar o nome correto
    const processedContacts = contacts.map(contact => {
      // Se tiver nome_edit, usa ele
      if (contact.nome_edit) {
        return {
          ...contact,
          displayName: contact.nome_edit
        };
      }
      // Se não tiver nome_edit mas tiver Ultimo_nome, usa ele
      if (contact.Ultimo_nome) {
        return {
          ...contact,
          displayName: contact.Ultimo_nome
        };
      }
      // Se não tiver nenhum dos dois, usa o número
      return {
        ...contact,
        displayName: contact.remoteJid
      };
    });

    res.json(processedContacts);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Atualizar contato com pushName
app.post('/api/contacts/update', async (req, res) => {
  try {
    const { remoteJid, pushName, instanceId } = req.body;

    // Busca o contato existente
    const existingContact = await prisma.contact.findUnique({
      where: {
        remoteJid_instanceId: {
          remoteJid,
          instanceId
        }
      }
    });

    let contact;
    if (existingContact) {
      // Se o contato existe, atualiza o pushName e Ultimo_nome se o pushName mudou
      if (pushName && pushName !== existingContact.pushName) {
        contact = await prisma.contact.update({
          where: {
            remoteJid_instanceId: {
              remoteJid,
              instanceId
            }
          },
          data: {
            pushName,
            Ultimo_nome: pushName // Atualiza o Ultimo_nome quando o pushName muda
          }
        });
      }
    } else {
      // Se o contato não existe, cria um novo
      contact = await prisma.contact.create({
        data: {
          remoteJid,
          pushName,
          Ultimo_nome: pushName, // Define o Ultimo_nome inicial como o pushName
          instanceId
        }
      });
    }

    // Notificar clientes sobre a atualização
    await notifyContactUpdate(remoteJid);

    res.json({ success: true, contact });
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Obter detalhes do contato
app.get('/api/contact/:remoteJid', async (req, res) => {
  try {
    const { remoteJid } = req.params;

    // Busca o contato usando findFirst
    const contact = await prisma.contact.findFirst({
      where: {
        remoteJid: remoteJid
      }
    });

    if (!contact) {
      return res.status(404).json({ error: 'Contato não encontrado' });
    }

    res.json(contact);
  } catch (error) {
    console.error('Error fetching contact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint para receber novas mensagens
app.post('/api/chats/:remoteJid/messages', async (req, res) => {
  try {
    const { remoteJid } = req.params;
    const message = req.body;

    console.log('Nova mensagem recebida:', {
      remoteJid,
      messageId: message.id,
      type: message.messageType
    });

    // Salvar a mensagem no banco
    const savedMessage = await prisma.message.create({
      data: message
    });

    // Notificar todos os clientes inscritos neste chat
    await notifyNewMessage(remoteJid, savedMessage);

    res.json(savedMessage);
  } catch (error) {
    console.error('Error saving message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 2653;
const IP = getLocalIP();

// Usar server.listen em vez de app.listen
server.listen(PORT, () => {
  console.log(`Server running on:`);
  console.log(`- Local:   http://localhost:${PORT}`);
  console.log(`- Network: http://${IP}:${PORT}`);
  console.log(`\nUse the Network URL in your app configuration`);
}); 