const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

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
      data.executionUrl = `https://n8n.srv903010.hstgr.cloud/${path}`;
      
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

// ==================== WEBHOOKS EXISTANTS ====================

// Webhook de test existant
app.get('/workflow', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook-test/test';
  const payload = { name: 'Serge' };

  try {
    sendEvent('start', { message: 'Workflow démarré...' });

    let response = await axios.post(webhookUrl, payload);
    let data = response.data;
    sendEvent('progress', { data });

    data = await pollWorkflow(data.executionUrl, sendEvent);
    sendEvent('completed', { result: data });
    res.end();
  } catch (err) {
    sendEvent('error', { error: err.message });
    res.end();
  }
});

// ==================== NOUVEAUX WEBHOOKS ====================

// 1. Générer des messages personnalisés
app.post('/webhook/generer/messages', async (req, res) => {
  const { sendEvent } = createSSEResponse(res);
  const { id, mode = 'generate' } = req.body;

  try {
    sendEvent('start', { message: 'Génération des messages personnalisés...' });

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

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/enrichir/contacte';
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

// ==================== WEBHOOKS SIMPLE (SANS SSE) ====================

// Ces endpoints peuvent être utilisés pour des réponses rapides sans streaming

// 1. Générer messages (version simple)
app.post('/api/generer/messages', async (req, res) => {
  try {
    const { id, mode = 'generate' } = req.body;
    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/generer/messages';
    
    const response = await axios.post(webhookUrl, { id, mode });
    res.json({ 
      success: true, 
      data: response.data,
      message: 'Messages générés avec succès'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      message: 'Erreur lors de la génération des messages'
    });
  }
});

// 2. Régénérer messages (version simple)
app.post('/api/regenerer/messages', async (req, res) => {
  try {
    const { id } = req.body;
    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/regenerer/messages';
    
    const response = await axios.post(webhookUrl, { id });
    res.json({ 
      success: true, 
      data: response.data,
      message: 'Messages régénérés avec succès'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      message: 'Erreur lors de la régénération des messages'
    });
  }
});

// 3. Enrichir contacts (version simple)
app.post('/api/enrichir/contacte', async (req, res) => {
  try {
    const { id } = req.body;
    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/enrichir/contacte';
    
    const response = await axios.post(webhookUrl, { id });
    res.json({ 
      success: true, 
      data: response.data,
      message: 'Enrichissement lancé avec succès'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      message: 'Erreur lors de l\'enrichissement'
    });
  }
});

// 4. Supprimer contacts rejetés (version simple)
app.post('/api/supprimer/contact/reject', async (req, res) => {
  try {
    const { id } = req.body;
    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/supprimer/contact/reject';
    
    const response = await axios.post(webhookUrl, { id });
    res.json({ 
      success: true, 
      data: response.data,
      message: 'Contacts rejetés supprimés avec succès'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      message: 'Erreur lors de la suppression'
    });
  }
});

// ==================== ENDPOINTS D'ÉTAT ET MONITORING ====================

// Vérifier l'état d'une exécution
app.get('/api/execution/:executionId', async (req, res) => {
  try {
    const { executionId } = req.params;
    const executionUrl = `https://n8n.srv903010.hstgr.cloud/api/v1/executions/${executionId}`;
    
    const response = await axios.get(executionUrl);
    res.json({ 
      success: true, 
      data: response.data 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Endpoint de santé
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Liste des webhooks disponibles
app.get('/api/webhooks', (req, res) => {
  const webhooks = [
    { path: '/webhook/generer/messages', method: 'POST', description: 'Générer des messages personnalisés (SSE)' },
    { path: '/webhook/regenerer/messages', method: 'POST', description: 'Régénérer des messages (SSE)' },
    { path: '/webhook/enrichir/contacte', method: 'POST', description: 'Enrichir les contacts (SSE)' },
    { path: '/webhook/supprimer/contact/reject', method: 'POST', description: 'Supprimer contacts rejetés (SSE)' },
    { path: '/api/generer/messages', method: 'POST', description: 'Générer des messages (Simple)' },
    { path: '/api/regenerer/messages', method: 'POST', description: 'Régénérer des messages (Simple)' },
    { path: '/api/enrichir/contacte', method: 'POST', description: 'Enrichir les contacts (Simple)' },
    { path: '/api/supprimer/contact/reject', method: 'POST', description: 'Supprimer contacts rejetés (Simple)' },
    { path: '/workflow', method: 'GET', description: 'Workflow de test (SSE)' },
    { path: '/health', method: 'GET', description: 'Vérifier l\'état du serveur' }
  ];
  
  res.json({ 
    webhooks,
    note: 'Les endpoints /webhook/* utilisent Server-Sent Events (SSE) pour le streaming en temps réel'
  });
});

// Gestion des erreurs 404
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint non trouvé',
    availableEndpoints: '/api/webhooks'
  });
});

// Gestion des erreurs globales
app.use((error, req, res, next) => {
  console.error('Erreur serveur:', error);
  res.status(500).json({ 
    error: 'Erreur interne du serveur',
    message: error.message 
  });
});

app.listen(PORT, () => {
  console.log(`🚀 SSE Node.js server running on port ${PORT}`);
  console.log(`📋 Liste des webhooks disponibles: http://localhost:${PORT}/api/webhooks`);
  console.log(`💚 Santé du serveur: http://localhost:${PORT}/health`);
});