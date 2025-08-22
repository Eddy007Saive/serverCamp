const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = 'https://n8n.srv903010.hstgr.cloud/';

// Middleware pour parser le JSON
app.use(express.json());

// Middleware CORS global
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Fonction utilitaire pour envoyer des événements SSE
const createSSEResponse = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (eventType, data) => {
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  return { sendEvent };
};

// Fonction utilitaire pour le polling de workflow
const pollWorkflow = async (executionUrl, sendEvent) => {
  let data = { executionUrl, finished: false };
  
  while (data.executionUrl && !data.finished) {
    try {
      const path = data.executionUrl.split('/').slice(3).join('/');
      data.executionUrl = `${N8N_WEBHOOK_URL}${path}`;
      
      sendEvent('step', { 
        message: "Vérification de l'état...", 
        executionUrl: data.executionUrl 
      });

      const statusRes = await axios.get(data.executionUrl);
      data = statusRes.data;
      sendEvent('update', { data });

      if (!data.finished) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      sendEvent('error', { error: error.message });
      break;
    }
  }
  
  return data;
};

// ==================== TOUS LES ENDPOINTS EN SSE ====================

// 1. Générer des messages personnalisés
app.post('/webhook/generer/messages', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const { id, mode = 'generate' } = req.body;

  try {
    sendEvent('start', { message: 'Génération des messages personnalisés...' });
console.log("debut génération des messages");

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/generer/messages';
    const response = await axios.post(webhookUrl, { id, mode });
    
    let data = response.data;
    sendEvent('progress', { data });

    if (data.executionUrl) {
      data = await pollWorkflow(data.executionUrl, sendEvent);
    }

    sendEvent('completed', { 
      message: 'Messages générés avec succès', 
      result: data 
    });
    res.end();
  } catch (error) {
    sendEvent('error', { 
      error: error.message,
      message: 'Erreur lors de la génération des messages'
    });
    res.end();
  }
});

// 2. Régénérer des messages existants
app.post('/webhook/regenerer/messages', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const { id } = req.body;

  try {
    sendEvent('start', { message: 'Régénération des messages...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/regenerer/messages';
    const response = await axios.post(webhookUrl, { id });
    
    let data = response.data;
    sendEvent('progress', { data });

    if (data.executionUrl) {
      data = await pollWorkflow(data.executionUrl, sendEvent);
    }

    sendEvent('completed', { 
      message: 'Messages régénérés avec succès', 
      result: data 
    });
    res.end();
  } catch (error) {
    sendEvent('error', { 
      error: error.message,
      message: 'Erreur lors de la régénération des messages'
    });
    res.end();
  }
});

// 3. Enrichir les contacts
app.post('/webhook/enrichir/contacte', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const { id } = req.body;

  try {
    sendEvent('start', { message: 'Enrichissement des contacts en cours...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook-test/enrichir/contacte';
    const response = await axios.post(webhookUrl, { id });
    
    let data = response.data;
    sendEvent('progress', { data });

    if (data.executionUrl) {
      data = await pollWorkflow(data.executionUrl, sendEvent);
    }

    sendEvent('completed', { 
      message: 'Enrichissement terminé avec succès', 
      result: data 
    });
    res.end();
  } catch (error) {
    sendEvent('error', { 
      error: error.message,
      message: 'Erreur lors de l\'enrichissement'
    });
    res.end();
  }
});

// 4. Supprimer les contacts rejetés
app.post('/webhook/supprimer/contact/reject', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const { id } = req.body;

  try {
    sendEvent('start', { message: 'Suppression des contacts rejetés...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/supprimer/contact/reject';
    const response = await axios.post(webhookUrl, { id });
    
    let data = response.data;
    sendEvent('progress', { data });

    if (data.executionUrl) {
      data = await pollWorkflow(data.executionUrl, sendEvent);
    }

    sendEvent('completed', { 
      message: 'Contacts rejetés supprimés avec succès', 
      result: data 
    });
    res.end();
  } catch (error) {
    sendEvent('error', { 
      error: error.message,
      message: 'Erreur lors de la suppression'
    });
    res.end();
  }
});

// 5. Générer messages (ancien endpoint /api/ maintenant en SSE)
app.post('/api/generer/messages', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const { id, mode = 'generate' } = req.body;

  try {
    sendEvent('start', { message: 'Démarrage génération des messages...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/generer/messages';
    sendEvent('progress', { message: 'Envoi de la requête au webhook...' });
    
    const response = await axios.post(webhookUrl, { id, mode });
    
    sendEvent('progress', { 
      message: 'Réponse reçue du webhook',
      data: response.data 
    });

    let data = response.data;
    if (data.executionUrl) {
      sendEvent('polling_start', { message: 'Démarrage du polling pour suivre l\'exécution...' });
      data = await pollWorkflow(data.executionUrl, sendEvent);
    }

    sendEvent('completed', { 
      success: true,
      message: 'Messages générés avec succès', 
      data: data
    });
    res.end();
  } catch (error) {
    sendEvent('error', { 
      success: false,
      error: error.message,
      message: 'Erreur lors de la génération des messages'
    });
    res.end();
  }
});

// 6. Régénérer messages (ancien endpoint /api/ maintenant en SSE)
app.post('/api/regenerer/messages', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const { id } = req.body;

  try {
    sendEvent('start', { message: 'Démarrage régénération des messages...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/regenerer/messages';
    sendEvent('progress', { message: 'Envoi de la requête au webhook...' });
    
    const response = await axios.post(webhookUrl, { id });
    
    sendEvent('progress', { 
      message: 'Réponse reçue du webhook',
      data: response.data 
    });

    let data = response.data;
    if (data.executionUrl) {
      sendEvent('polling_start', { message: 'Démarrage du polling pour suivre l\'exécution...' });
      data = await pollWorkflow(data.executionUrl, sendEvent);
    }

    sendEvent('completed', { 
      success: true,
      message: 'Messages régénérés avec succès', 
      data: data
    });
    res.end();
  } catch (error) {
    sendEvent('error', { 
      success: false,
      error: error.message,
      message: 'Erreur lors de la régénération des messages'
    });
    res.end();
  }
});

// 7. Enrichir contacts (ancien endpoint /api/ maintenant en SSE)
app.post('/api/enrichir/contacte', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const { id } = req.body;

  try {
    sendEvent('start', { message: 'Démarrage enrichissement des contacts...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/enrichir/contacte';
    sendEvent('progress', { message: 'Envoi de la requête au webhook...' });
    
    const response = await axios.post(webhookUrl, { id });
    
    sendEvent('progress', { 
      message: 'Réponse reçue du webhook',
      data: response.data 
    });

    let data = response.data;
    if (data.executionUrl) {
      sendEvent('polling_start', { message: 'Démarrage du polling pour suivre l\'exécution...' });
      data = await pollWorkflow(data.executionUrl, sendEvent);
    }

    sendEvent('completed', { 
      success: true,
      message: 'Enrichissement lancé avec succès', 
      data: data
    });
    res.end();
  } catch (error) {
    sendEvent('error', { 
      success: false,
      error: error.message,
      message: 'Erreur lors de l\'enrichissement'
    });
    res.end();
  }
});

// 8. Supprimer contacts rejetés (ancien endpoint /api/ maintenant en SSE)
app.post('/api/supprimer/contact/reject', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const { id } = req.body;

  try {
    sendEvent('start', { message: 'Démarrage suppression des contacts rejetés...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/supprimer/contact/reject';
    sendEvent('progress', { message: 'Envoi de la requête au webhook...' });
    
    const response = await axios.post(webhookUrl, { id });
    
    sendEvent('progress', { 
      message: 'Réponse reçue du webhook',
      data: response.data 
    });

    let data = response.data;
    if (data.executionUrl) {
      sendEvent('polling_start', { message: 'Démarrage du polling pour suivre l\'exécution...' });
      data = await pollWorkflow(data.executionUrl, sendEvent);
    }

    sendEvent('completed', { 
      success: true,
      message: 'Contacts rejetés supprimés avec succès', 
      data: data
    });
    res.end();
  } catch (error) {
    sendEvent('error', { 
      success: false,
      error: error.message,
      message: 'Erreur lors de la suppression'
    });
    res.end();
  }
});

// 9. Vérifier l'état d'une exécution (maintenant en SSE)
app.get('/api/execution/:executionId', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const { executionId } = req.params;

  try {
    sendEvent('start', { message: `Vérification de l'exécution ${executionId}...` });

    const executionUrl = `https://n8n.srv903010.hstgr.cloud/api/v1/executions/${executionId}`;
    sendEvent('progress', { message: 'Récupération des informations d\'exécution...' });
    
    const response = await axios.get(executionUrl);
    
    sendEvent('progress', { message: 'Données d\'exécution récupérées' });

    sendEvent('completed', { 
      success: true,
      message: 'Informations d\'exécution récupérées avec succès',
      data: response.data 
    });
    res.end();
  } catch (error) {
    sendEvent('error', { 
      success: false,
      error: error.message,
      message: 'Erreur lors de la récupération des informations d\'exécution'
    });
    res.end();
  }
});

// 10. Endpoint de santé (maintenant en SSE)
app.get('/health', (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  
  sendEvent('start', { message: 'Vérification de l\'état du serveur...' });
  
  const healthData = {
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.version
  };
  
  sendEvent('progress', { message: 'Collecte des informations système...' });
  
  sendEvent('completed', { 
    success: true,
    message: 'Serveur en bonne santé',
    data: healthData
  });
  
  res.end();
});

// 11. Liste des webhooks disponibles (maintenant en SSE)
app.get('/api/webhooks', (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  
  sendEvent('start', { message: 'Récupération de la liste des webhooks...' });
  
  const webhooks = [
    { path: '/webhook/generer/messages', method: 'POST', description: 'Générer des messages personnalisés (SSE)' },
    { path: '/webhook/regenerer/messages', method: 'POST', description: 'Régénérer des messages (SSE)' },
    { path: '/webhook/enrichir/contacte', method: 'POST', description: 'Enrichir les contacts (SSE)' },
    { path: '/webhook/supprimer/contact/reject', method: 'POST', description: 'Supprimer contacts rejetés (SSE)' },
    { path: '/api/generer/messages', method: 'POST', description: 'Générer des messages (SSE)' },
    { path: '/api/regenerer/messages', method: 'POST', description: 'Régénérer des messages (SSE)' },
    { path: '/api/enrichir/contacte', method: 'POST', description: 'Enrichir les contacts (SSE)' },
    { path: '/api/supprimer/contact/reject', method: 'POST', description: 'Supprimer contacts rejetés (SSE)' },
    { path: '/api/execution/:executionId', method: 'GET', description: 'Vérifier l\'état d\'une exécution (SSE)' },
    { path: '/health', method: 'GET', description: 'Vérifier l\'état du serveur (SSE)' },
    { path: '/api/webhooks', method: 'GET', description: 'Liste des webhooks disponibles (SSE)' }
  ];
  
  sendEvent('progress', { message: 'Liste des endpoints compilée' });
  
  sendEvent('completed', {
    success: true,
    message: 'Liste des webhooks récupérée avec succès',
    data: {
      webhooks,
      total: webhooks.length,
      note: 'Tous les endpoints utilisent maintenant Server-Sent Events (SSE) pour le streaming en temps réel'
    }
  });
  
  res.end();
});

// Gestion des erreurs 404 (maintenant en SSE)
app.use((req, res) => {
  const { sendEvent } = createSSEResponse(res);
  
  sendEvent('start', { message: 'Traitement de la requête...' });
  
  sendEvent('error', { 
    success: false,
    status: 404,
    error: 'Endpoint non trouvé',
    message: `L'endpoint ${req.method} ${req.path} n'existe pas`,
    availableEndpoints: '/api/webhooks',
    suggestion: 'Consultez /api/webhooks pour voir tous les endpoints disponibles'
  });
  
  res.end();
});

// Gestion des erreurs globales (maintenant en SSE si possible)
app.use((error, req, res, next) => {
  console.error('Erreur serveur:', error);
  
  // Vérifier si les headers ont déjà été envoyés
  if (res.headersSent) {
    return next(error);
  }
  
  const { sendEvent } = createSSEResponse(res);
  
  sendEvent('error', { 
    success: false,
    status: 500,
    error: 'Erreur interne du serveur',
    message: error.message,
    timestamp: new Date().toISOString()
  });
  
  res.end();
});

app.listen(PORT, () => {
  console.log(`🚀 SSE Node.js server running on port ${PORT}`);
  console.log(`📋 Liste des webhooks disponibles: http://localhost:${PORT}/api/webhooks`);
  console.log(`💚 Santé du serveur: http://localhost:${PORT}/health`);
  console.log(`🌊 Tous les endpoints utilisent maintenant Server-Sent Events (SSE)`);
});