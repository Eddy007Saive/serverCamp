const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = 'https://n8n.srv903010.hstgr.cloud/';

// Middleware pour parser le JSON
app.use(express.json());

// ==================== SYSTÈME DE LOGGING ====================
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  TRACE: 4
};

const CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG; // Changez selon vos besoins

const logger = {
  error: (message, data = {}) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.ERROR) {
      console.error(`❌ [ERROR] ${new Date().toISOString()} - ${message}`, data);
    }
  },
  warn: (message, data = {}) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.WARN) {
      console.warn(`⚠️  [WARN]  ${new Date().toISOString()} - ${message}`, data);
    }
  },
  info: (message, data = {}) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.INFO) {
      console.info(`ℹ️  [INFO]  ${new Date().toISOString()} - ${message}`, data);
    }
  },
  debug: (message, data = {}) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
      console.log(`🐛 [DEBUG] ${new Date().toISOString()} - ${message}`, data);
    }
  },
  trace: (message, data = {}) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.TRACE) {
      console.log(`🔍 [TRACE] ${new Date().toISOString()} - ${message}`, data);
    }
  }
};

// Compteurs pour le monitoring
const stats = {
  activeConnections: 0,
  totalRequests: 0,
  totalErrors: 0,
  requestsByEndpoint: {},
  connectionStartTimes: new Map()
};

// Middleware de logging des requêtes
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  req.requestId = requestId;
  stats.totalRequests++;
  stats.activeConnections++;
  stats.connectionStartTimes.set(requestId, startTime);
  
  if (!stats.requestsByEndpoint[req.path]) {
    stats.requestsByEndpoint[req.path] = 0;
  }
  stats.requestsByEndpoint[req.path]++;
  
  logger.info(`🚀 Nouvelle requête`, {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.method === 'POST' ? req.body : 'N/A',
    activeConnections: stats.activeConnections,
    totalRequests: stats.totalRequests
  });

  // Override res.end pour logger la fin de la requête
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - startTime;
    stats.activeConnections--;
    stats.connectionStartTimes.delete(requestId);
    
    logger.info(`✅ Fin de requête`, {
      requestId,
      duration: `${duration}ms`,
      statusCode: res.statusCode,
      activeConnections: stats.activeConnections
    });
    
    originalEnd.apply(this, args);
  };

  next();
});

// Middleware CORS global
app.use((req, res, next) => {
  logger.trace('Application du middleware CORS', { requestId: req.requestId });
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    logger.debug('Requête OPTIONS - réponse immédiate', { requestId: req.requestId });
    return res.sendStatus(200);
  }
  next();
});

// Fonction utilitaire pour envoyer des événements SSE
const createSSEResponse = (res, requestId) => {
  logger.debug('🌊 Initialisation SSE', { requestId });
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (eventType, data) => {
    const eventData = {
      ...data,
      timestamp: new Date().toISOString(),
      requestId
    };
    
    logger.trace(`📡 Envoi événement SSE`, {
      requestId,
      eventType,
      dataSize: JSON.stringify(eventData).length
    });
    
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(eventData)}\n\n`);
  };

  return { sendEvent };
};

// Fonction utilitaire pour le polling de workflow
// Configuration pour contrôler le comportement après erreur
const POLLING_CONFIG = {
  stopOnWorkflowError: false, // CHANGEZ à false pour continuer après erreur
  maxPollsAfterError: 5, // Nombre de polls supplémentaires après erreur
  delayAfterError: 10000, // Délai après erreur (10s)
  retryOnTransientError: true // Retry sur erreurs temporaires
};

// Fonction de polling SANS AUCUN TIMEOUT
const pollWorkflow = async (executionUrl, sendEvent, requestId) => {
  logger.info('🔄 Début du polling workflow (SANS TIMEOUT)', { 
    requestId, 
    executionUrl: executionUrl 
  });
  
  let data = { executionUrl, finished: false };
  let pollCount = 0;
  let consecutiveErrors = 0;
  let workflowFailed = false;
  
  const config = {
    maxPolls: 1000, // Augmenté car pas de timeout
    maxConsecutiveErrors: 10, // Plus tolérant
  };
  
  const startTime = Date.now();
  
  const getPollingInterval = (pollCount, hasError = false) => {
    if (hasError) return 15000; // 15s après erreur
    if (pollCount < 5) return 3000; // 3s pour les premières
    if (pollCount < 20) return 5000; // 5s normalement
    if (pollCount < 60) return 10000; // 10s pour les longues
    if (pollCount < 120) return 15000; // 15s pour les très longues
    return 20000; // 20s pour les extrêmement longues
  };
  
  const analyzeN8NResponse = (data) => {
    if (!data || typeof data !== 'object') {
      return { 
        isError: false, 
        errorType: null, 
        message: null, 
        severity: null
      };
    }
    
    const dataStr = JSON.stringify(data).toLowerCase();
    
    if (dataStr.includes('exit code: 1')) {
      return { 
        isError: true, 
        errorType: 'workflow_error', 
        message: 'Le workflow N8N a échoué (exit code: 1)',
        severity: 'critical'
      };
    }
    
    if (dataStr.includes('process finished with an error')) {
      return { 
        isError: true, 
        errorType: 'process_error', 
        message: 'Le processus N8N s\'est terminé avec une erreur',
        severity: 'critical'
      };
    }
    
    if (dataStr.includes('timeout') || dataStr.includes('timed out')) {
      return { 
        isError: true, 
        errorType: 'n8n_timeout', 
        message: 'Timeout côté N8N',
        severity: 'warning'
      };
    }
    
    return { 
      isError: false, 
      errorType: null, 
      message: null, 
      severity: null
    };
  };
  
  while (data.executionUrl && !data.finished && pollCount < config.maxPolls) {
    pollCount++;
    
    const elapsedTime = Date.now() - startTime;
    
    // Seule vérification restante : trop d'erreurs consécutives
    if (consecutiveErrors >= config.maxConsecutiveErrors) {
      logger.error('💥 Trop d\'erreurs consécutives', { 
        requestId, 
        consecutiveErrors,
        maxAllowed: config.maxConsecutiveErrors
      });
      sendEvent('too_many_errors', { 
        message: `Trop d'erreurs consécutives (${consecutiveErrors})`,
        pollCount
      });
      break;
    }
    
    try {
      const path = data.executionUrl.split('/').slice(3).join('/');
      const fullUrl = `${N8N_WEBHOOK_URL}${path}`;
      
      logger.debug(`🔍 Polling tentative ${pollCount}/${config.maxPolls}`, {
        requestId,
        executionUrl: fullUrl,
        pollCount,
        elapsedTime: `${Math.round(elapsedTime/1000)}s`,
        consecutiveErrors,
        workflowFailed
      });
      
      sendEvent('step', { 
        message: `Vérification ${pollCount}/${config.maxPolls} (${Math.round(elapsedTime/1000)}s)`, 
        executionUrl: fullUrl,
        pollCount,
        elapsedTime: `${Math.round(elapsedTime/1000)}s`,
        consecutiveErrors,
        status: workflowFailed ? 'post-error' : 'normal',
        note: 'AUCUN TIMEOUT - Polling illimité'
      });

      const startPoll = Date.now();
      
      // Configuration Axios SANS TIMEOUT
      const axiosConfig = {
        // timeout: SUPPRIMÉ - Aucun timeout !
        headers: {
          'User-Agent': `NodeJS-Proxy-${requestId}`,
          'Accept': 'application/json',
          'Cache-Control': 'no-cache'
        },
        maxRedirects: 5,
        validateStatus: (status) => status < 600
      };
      
      logger.trace('📤 Requête sans timeout', {
        requestId,
        pollCount,
        url: fullUrl,
        note: 'Attente infinie si nécessaire'
      });
      
      const statusRes = await axios.get(fullUrl, axiosConfig);
      const pollDuration = Date.now() - startPoll;
      
      // Réinitialiser le compteur d'erreurs sur succès
      consecutiveErrors = 0;
      
      data = statusRes.data;
      
      const errorAnalysis = analyzeN8NResponse(data);
      
      logger.debug('📊 Réponse polling reçue', {
        requestId,
        pollCount,
        duration: `${pollDuration}ms`,
        status: statusRes.status,
        finished: data.finished,
        dataSize: JSON.stringify(data).length,
        hasN8NError: errorAnalysis.isError,
        errorType: errorAnalysis.errorType,
        errorSeverity: errorAnalysis.severity,
        workflowFailed
      });
      
      // Gestion des erreurs N8N (mais continue toujours)
      if (errorAnalysis.isError) {
        if (!workflowFailed) {
          workflowFailed = true;
          
          logger.error('❌ Erreur détectée dans N8N (continue quand même)', {
            requestId,
            pollCount,
            errorType: errorAnalysis.errorType,
            message: errorAnalysis.message,
            severity: errorAnalysis.severity,
            note: 'Polling continue sans s\'arrêter',
            data: data
          });
          
          sendEvent('n8n_error_detected', {
            errorType: errorAnalysis.errorType,
            message: errorAnalysis.message,
            severity: errorAnalysis.severity,
            pollCount,
            data: data,
            willContinue: true,
            note: 'Erreur détectée mais polling continue'
          });
        } else {
          logger.debug('🔄 Erreur persistante (continue)', {
            requestId,
            pollCount,
            errorType: errorAnalysis.errorType,
            note: 'Continue malgré l\'erreur'
          });
          
          sendEvent('error_persisting', {
            errorType: errorAnalysis.errorType,
            message: errorAnalysis.message,
            pollCount,
            data: data,
            note: 'Erreur toujours présente, polling continue'
          });
        }
      }
      let donnee=data.data;
      sendEvent('update', { 
        donnee,
        pollCount,
        pollDuration: `${pollDuration}ms`,
        elapsedTime: `${Math.round((Date.now() - startTime)/1000)}s`,
        nextPollIn: `${getPollingInterval(pollCount, errorAnalysis.isError)/1000}s`,
        serverStatus: statusRes.status,
        stability: 'no-timeout',
        hasError: errorAnalysis.isError,
        workflowStatus: workflowFailed ? 'error-but-continuing' : (data.finished ? 'completed' : 'running'),
        workflowFailed,
        note: ''
      });

      if (!data.finished) {
        const waitTime = getPollingInterval(pollCount, errorAnalysis.isError);
        
        logger.trace(`⏳ Attente avant prochain polling`, { 
          requestId, 
          pollCount, 
          waitTime: `${waitTime}ms`,
          note: 'Pas de limite de temps'
        });
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        const totalTime = Date.now() - startTime;
        const finalStatus = workflowFailed ? 'completed-with-errors' : 'completed-successfully';
        
        logger.info('✅ Workflow terminé', { 
          requestId, 
          totalPolls: pollCount,
          totalTime: `${Math.round(totalTime/1000)}s`,
          finalStatus,
          hadErrors: workflowFailed,
          finalData: data,
          note: 'Terminé naturellement sans timeout'
        });
        
        sendEvent('workflow_completed', {
          message: workflowFailed ? 
            'Workflow terminé (avec erreurs détectées mais polling complet)' : 
            'Workflow terminé avec succès',
          totalPolls: pollCount,
          totalTime: `${Math.round(totalTime/1000)}s`,
          finalStatus,
          hadErrors: workflowFailed,
          finalData: data,
          note: 'Aucun timeout appliqué'
        });
      }
      
    } catch (error) {
      consecutiveErrors++;
      
      logger.error('❌ Erreur lors du polling (mais continue)', {
        requestId,
        pollCount,
        consecutiveErrors,
        error: error.message,
        errorCode: error.code,
        executionUrl: data.executionUrl,
        note: 'Continue malgré l\'erreur réseau',
        maxErrorsAllowed: config.maxConsecutiveErrors
      });
      
      sendEvent('polling_error', { 
        error: error.message,
        errorCode: error.code,
        pollCount,
        consecutiveErrors,
        maxErrorsAllowed: config.maxConsecutiveErrors,
        willRetry: consecutiveErrors < config.maxConsecutiveErrors,
        nextAction: 'retry_with_delay',
        note: 'Erreur réseau - Retry automatique'
      });
      
      // Attente après erreur réseau
      const errorWaitTime = 15000; // 15s fixe
      logger.debug(`⏳ Attente après erreur réseau`, { 
        requestId, 
        waitTime: `${errorWaitTime}ms`,
        consecutiveErrors,
        note: 'Retry dans 15s'
      });
      
      await new Promise(resolve => setTimeout(resolve, errorWaitTime));
    }
  }
  
  const totalElapsedTime = Date.now() - startTime;
  
  // Déterminer la raison de fin (très simplifiée)
  let endReason = 'unknown';
  let finalStatus = 'incomplete';
  
  if (data.finished && !workflowFailed) {
    endReason = 'completed';
    finalStatus = 'success';
  } else if (data.finished && workflowFailed) {
    endReason = 'completed_with_errors';
    finalStatus = 'partial_success';
  } else if (pollCount >= config.maxPolls) {
    endReason = 'max_polls_reached';
    finalStatus = 'max_attempts';
  } else if (consecutiveErrors >= config.maxConsecutiveErrors) {
    endReason = 'too_many_network_errors';
    finalStatus = 'network_failure';
  } else {
    endReason = 'interrupted';
    finalStatus = 'interrupted';
  }
  
  logger.info('🏁 Fin du polling SANS TIMEOUT', {
    requestId,
    totalPolls: pollCount,
    totalTime: `${Math.round(totalElapsedTime/1000)}s`,
    totalMinutes: `${Math.round(totalElapsedTime/1000/60)}min`,
    finished: data.finished,
    workflowFailed,
    reason: endReason,
    consecutiveErrors,
    finalStatus,
    note: 'Aucune limite de temps appliquée'
  });
  
  sendEvent('polling_ended', {
    totalPolls: pollCount,
    totalTime: `${Math.round(totalElapsedTime/1000)}s`,
    totalMinutes: `${Math.round(totalElapsedTime/1000/60)}min`,
    finished: data.finished,
    workflowFailed,
    reason: endReason,
    consecutiveErrors,
    success: data.finished === true,
    finalData: data,
    finalStatus,
    note: 'Polling terminé naturellement - Aucun timeout'
  });
  
  return {
    ...data,
    _meta: {
      success: data.finished === true,
      failed: workflowFailed,
      reason: endReason,
      totalPolls: pollCount,
      totalTime: Math.round(totalElapsedTime/1000),
      totalMinutes: Math.round(totalElapsedTime/1000/60),
      noTimeoutApplied: true
    }
  };
};

// Version simplifiée des endpoints SANS TIMEOUT
app.post('/webhook/enrichir/contacte', async (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { id } = req.body;

  logger.info('💰 Début enrichissement contacts (SANS TIMEOUT)', {
    requestId: req.requestId,
    id,
    note: 'Aucune limite de temps'
  });

  try {
    sendEvent('start', { 
      message: 'Enrichissement des contacts en cours (patience illimitée)...',
      note: 'Aucun timeout - Le processus prendra le temps nécessaire'
    });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/enrichir/contacte';
    
    logger.debug('📤 Requête initiale SANS timeout vers N8N', {
      requestId: req.requestId,
      webhookUrl,
      payload: { id },
      note: 'Attente illimitée pour la réponse'
    });
    
    const startRequest = Date.now();
    
    // Requête initiale SANS TIMEOUT
    const response = await axios.post(webhookUrl, { id }, {
      // timeout: SUPPRIMÉ - Aucun timeout !
      headers: {
        'User-Agent': `NodeJS-Proxy-${req.requestId}`,
        'Content-Type': 'application/json'
      }
    });
    
    const requestDuration = Date.now() - startRequest;
    
    logger.info('📥 Réponse initiale N8N reçue (sans timeout)', {
      requestId: req.requestId,
      duration: `${requestDuration}ms`,
      status: response.status,
      note: 'Réponse reçue sans limitation de temps'
    });
    
    let data = response.data;
    sendEvent('progress', { 
      data, 
      requestDuration: `${requestDuration}ms`,
      note: 'Réponse initiale reçue - Début du polling illimité'
    });

    if (data.executionUrl) {
      logger.info('🔄 Démarrage polling SANS TIMEOUT', {
        requestId: req.requestId,
        executionUrl: data.executionUrl,
        note: 'Polling avec patience infinie'
      });
      
      data = await pollWorkflow(data.executionUrl, sendEvent, req.requestId);
    }

    // Message final basé sur le vrai statut
    const success = data._meta?.success || data.finished;
    const failed = data._meta?.failed || false;
    
    if (success && !failed) {
      logger.info('✅ Enrichissement terminé avec succès (sans timeout)', {
        requestId: req.requestId,
        totalTime: data._meta?.totalTime,
        totalMinutes: data._meta?.totalMinutes,
        finalResult: data,
        note: 'Succès complet sans limitation de temps'
      });

      sendEvent('completed', { 
        message: 'Enrichissement terminé avec succès (sans aucun timeout)', 
        result: data,
        success: true,
        totalTime: `${data._meta?.totalTime}s (${data._meta?.totalMinutes}min)`,
        note: 'Terminé naturellement'
      });
    } else if (success && failed) {
      logger.warn('⚠️ Enrichissement terminé avec erreurs détectées', {
        requestId: req.requestId,
        totalTime: data._meta?.totalTime,
        reason: data._meta?.reason,
        finalResult: data,
        note: 'Terminé malgré les erreurs'
      });

      sendEvent('completed_with_errors', { 
        message: 'Enrichissement terminé avec des erreurs détectées', 
        result: data,
        success: true,
        hadErrors: true,
        reason: data._meta?.reason,
        totalTime: `${data._meta?.totalTime}s (${data._meta?.totalMinutes}min)`,
        note: 'Processus complet malgré les erreurs'
      });
    } else {
      logger.error('❌ Enrichissement interrompu', {
        requestId: req.requestId,
        reason: data._meta?.reason,
        finalResult: data,
        note: 'Interrompu pour cause technique'
      });

      sendEvent('interrupted', { 
        message: 'L\'enrichissement a été interrompu', 
        result: data,
        success: false,
        reason: data._meta?.reason,
        totalTime: data._meta?.totalTime ? `${data._meta?.totalTime}s (${data._meta?.totalMinutes}min)` : 'N/A',
        note: 'Arrêt pour cause technique (pas de timeout)'
      });
    }
    
    res.end();
  } catch (error) {
    stats.totalErrors++;
    logger.error('❌ Erreur enrichissement contacts (sans timeout)', {
      requestId: req.requestId,
      error: error.message,
      errorCode: error.code,
      stack: error.stack,
      note: 'Erreur malgré l\'absence de timeout'
    });
    
    sendEvent('error', { 
      error: error.message,
      errorCode: error.code,
      message: 'Erreur lors de l\'enrichissement',
      success: false,
      note: 'Erreur réseau ou serveur (pas de timeout)'
    });
    res.end();
  }
});

// Fonction d'aide pour diagnostiquer les problèmes N8N
const diagnoseN8NHealth = async (baseUrl) => {
  try {
    const healthCheck = await axios.get(`${baseUrl}/healthz`, { timeout: 10000 });
    return { healthy: true, status: healthCheck.status };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
};

// Middleware pour surveiller la santé N8N
const checkN8NHealth = async (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
    try {
      const health = await diagnoseN8NHealth(N8N_WEBHOOK_URL);
      if (!health.healthy) {
        logger.warn('⚠️ N8N semble indisponible', {
          requestId: req.requestId,
          error: health.error,
          n8nUrl: N8N_WEBHOOK_URL
        });
      }
      req.n8nHealth = health;
    } catch (error) {
      logger.debug('🔍 Impossible de vérifier la santé N8N', {
        requestId: req.requestId,
        error: error.message
      });
    }
  }
  next();
};

// BONUS: Fonction pour estimer le temps restant
const estimateRemainingTime = (pollCount, startTime, averageWorkflowDuration = 5 * 60 * 1000) => {
  const elapsedTime = Date.now() - startTime;
  const avgTimePerPoll = elapsedTime / pollCount;
  
  // Estimation basée sur la durée moyenne des workflows
  const estimatedTotalTime = Math.max(averageWorkflowDuration, elapsedTime * 1.5);
  const remainingTime = Math.max(0, estimatedTotalTime - elapsedTime);
  
  return {
    elapsed: Math.round(elapsedTime / 1000),
    remaining: Math.round(remainingTime / 1000),
    estimated: Math.round(estimatedTotalTime / 1000)
  };
};

// ==================== TOUS LES ENDPOINTS EN SSE ====================

// 1. Générer des messages personnalisés
app.post('/webhook/generer/messages', async (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { id, mode = 'generate' } = req.body;

  logger.info('🎯 Début génération messages personnalisés', {
    requestId: req.requestId,
    id,
    mode
  });

  try {
    sendEvent('start', { message: 'Génération des messages personnalisés...' });
    logger.debug("Début génération des messages", { requestId: req.requestId });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/generer/messages';
    
    logger.debug('📤 Envoi requête vers N8N', {
      requestId: req.requestId,
      webhookUrl,
      payload: { id, mode }
    });
    
    const startRequest = Date.now();
    const response = await axios.post(webhookUrl, { id, mode }, {
      timeout: 30000 // 30s timeout
    });
    const requestDuration = Date.now() - startRequest;
    
    logger.info('📥 Réponse N8N reçue', {
      requestId: req.requestId,
      duration: `${requestDuration}ms`,
      status: response.status,
      dataSize: JSON.stringify(response.data).length
    });
    
    let data = response.data;
    sendEvent('progress', { data, requestDuration: `${requestDuration}ms` });

    if (data.executionUrl) {
      logger.info('🔄 Démarrage polling pour suivi exécution', {
        requestId: req.requestId,
        executionUrl: data.executionUrl
      });
      data = await pollWorkflow(data.executionUrl, sendEvent, req.requestId);
    }

    logger.info('✅ Génération messages terminée avec succès', {
      requestId: req.requestId,
      finalResult: data
    });

    sendEvent('completed', { 
      message: 'Messages générés avec succès', 
      result: data 
    });
    res.end();
  } catch (error) {
    stats.totalErrors++;
    logger.error('❌ Erreur génération messages', {
      requestId: req.requestId,
      error: error.message,
      stack: error.stack,
      totalErrors: stats.totalErrors
    });
    
    sendEvent('error', { 
      error: error.message,
      message: 'Erreur lors de la génération des messages'
    });
    res.end();
  }
});

// 2. Régénérer des messages existants
app.post('/webhook/regenerer/messages', async (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { id } = req.body;

  logger.info('🔄 Début régénération messages', {
    requestId: req.requestId,
    id
  });

  try {
    sendEvent('start', { message: 'Régénération des messages...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/regenerer/messages';
    
    logger.debug('📤 Envoi requête régénération vers N8N', {
      requestId: req.requestId,
      webhookUrl,
      payload: { id }
    });
    
    const startRequest = Date.now();
    const response = await axios.post(webhookUrl, { id }, {
      timeout: 30000
    });
    const requestDuration = Date.now() - startRequest;
    
    logger.info('📥 Réponse régénération N8N reçue', {
      requestId: req.requestId,
      duration: `${requestDuration}ms`,
      status: response.status
    });
    
    let data = response.data;
    sendEvent('progress', { data, requestDuration: `${requestDuration}ms` });

    if (data.executionUrl) {
      data = await pollWorkflow(data.executionUrl, sendEvent, req.requestId);
    }

    logger.info('✅ Régénération terminée avec succès', {
      requestId: req.requestId,
      finalResult: data
    });

    sendEvent('completed', { 
      message: 'Messages régénérés avec succès', 
      result: data 
    });
    res.end();
  } catch (error) {
    stats.totalErrors++;
    logger.error('❌ Erreur régénération messages', {
      requestId: req.requestId,
      error: error.message,
      stack: error.stack
    });
    
    sendEvent('error', { 
      error: error.message,
      message: 'Erreur lors de la régénération des messages'
    });
    res.end();
  }
});

// 3. Enrichir les contacts
app.post('/webhook/enrichir/contacte', async (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { id } = req.body;

  logger.info('💰 Début enrichissement contacts', {
    requestId: req.requestId,
    id
  });

  try {
    sendEvent('start', { message: 'Enrichissement des contacts en cours...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook-test/enrichir/contacte';
    
    logger.debug('📤 Envoi requête enrichissement vers N8N', {
      requestId: req.requestId,
      webhookUrl,
      payload: { id }
    });
    
    const startRequest = Date.now();
    const response = await axios.post(webhookUrl, { id }, {
      timeout: 30000
    });
    const requestDuration = Date.now() - startRequest;
    
    logger.info('📥 Réponse enrichissement N8N reçue', {
      requestId: req.requestId,
      duration: `${requestDuration}ms`,
      status: response.status
    });
    
    let data = response.data;
    sendEvent('progress', { data, requestDuration: `${requestDuration}ms` });

    if (data.executionUrl) {
      data = await pollWorkflow(data.executionUrl, sendEvent, req.requestId);
    }

    logger.info('✅ Enrichissement terminé avec succès', {
      requestId: req.requestId,
      finalResult: data
    });

    sendEvent('completed', { 
      message: 'Enrichissement terminé avec succès', 
      result: data 
    });
    res.end();
  } catch (error) {
    stats.totalErrors++;
    logger.error('❌ Erreur enrichissement contacts', {
      requestId: req.requestId,
      error: error.message,
      stack: error.stack
    });
    
    sendEvent('error', { 
      error: error.message,
      message: 'Erreur lors de l\'enrichissement'
    });
    res.end();
  }
});

// 4. Supprimer les contacts rejetés
app.post('/webhook/supprimer/contact/reject', async (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { id } = req.body;

  logger.info('🗑️ Début suppression contacts rejetés', {
    requestId: req.requestId,
    id
  });

  try {
    sendEvent('start', { message: 'Suppression des contacts rejetés...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/supprimer/contact/reject';
    
    logger.debug('📤 Envoi requête suppression vers N8N', {
      requestId: req.requestId,
      webhookUrl,
      payload: { id }
    });
    
    const startRequest = Date.now();
    const response = await axios.post(webhookUrl, { id }, {
      timeout: 30000
    });
    const requestDuration = Date.now() - startRequest;
    
    logger.info('📥 Réponse suppression N8N reçue', {
      requestId: req.requestId,
      duration: `${requestDuration}ms`,
      status: response.status
    });
    
    let data = response.data;
    sendEvent('progress', { data, requestDuration: `${requestDuration}ms` });

    if (data.executionUrl) {
      data = await pollWorkflow(data.executionUrl, sendEvent, req.requestId);
    }

    logger.info('✅ Suppression terminée avec succès', {
      requestId: req.requestId,
      finalResult: data
    });

    sendEvent('completed', { 
      message: 'Contacts rejetés supprimés avec succès', 
      result: data 
    });
    res.end();
  } catch (error) {
    stats.totalErrors++;
    logger.error('❌ Erreur suppression contacts', {
      requestId: req.requestId,
      error: error.message,
      stack: error.stack
    });
    
    sendEvent('error', { 
      error: error.message,
      message: 'Erreur lors de la suppression'
    });
    res.end();
  }
});

// 5-8. Endpoints /api/ (versions avec plus de logs détaillés)
app.post('/api/generer/messages', async (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { id, mode = 'generate' } = req.body;

  logger.info('🎯 [API] Début génération messages', {
    requestId: req.requestId,
    id,
    mode,
    endpoint: '/api/generer/messages'
  });

  try {
    sendEvent('start', { message: 'Démarrage génération des messages...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/generer/messages';
    sendEvent('progress', { message: 'Envoi de la requête au webhook...' });
    
    logger.debug('📤 [API] Préparation requête N8N', {
      requestId: req.requestId,
      webhookUrl,
      payload: { id, mode }
    });
    
    const startRequest = Date.now();
    const response = await axios.post(webhookUrl, { id, mode }, {
      timeout: 30000,
      headers: {
        'User-Agent': `NodeJS-Proxy-${req.requestId}`
      }
    });
    const requestDuration = Date.now() - startRequest;
    
    logger.info('📥 [API] Réponse N8N reçue', {
      requestId: req.requestId,
      duration: `${requestDuration}ms`,
      status: response.status,
      headers: response.headers,
      dataKeys: Object.keys(response.data || {})
    });
    
    sendEvent('progress', { 
      message: 'Réponse reçue du webhook',
      data: response.data,
      requestDuration: `${requestDuration}ms`
    });

    let data = response.data;
    if (data.executionUrl) {
      sendEvent('polling_start', { message: 'Démarrage du polling pour suivre l\'exécution...' });
      logger.info('🔄 [API] Début polling workflow', {
        requestId: req.requestId,
        executionUrl: data.executionUrl
      });
      data = await pollWorkflow(data.executionUrl, sendEvent, req.requestId);
    }

    logger.info('✅ [API] Génération terminée avec succès', {
      requestId: req.requestId,
      totalDuration: Date.now() - stats.connectionStartTimes.get(req.requestId),
      finalDataKeys: Object.keys(data || {})
    });

    sendEvent('completed', { 
      success: true,
      message: 'Messages générés avec succès', 
      data: data
    });
    res.end();
  } catch (error) {
    stats.totalErrors++;
    logger.error('❌ [API] Erreur génération messages', {
      requestId: req.requestId,
      error: error.message,
      errorCode: error.code,
      errorStatus: error.response?.status,
      errorData: error.response?.data,
      stack: error.stack,
      totalErrors: stats.totalErrors
    });
    
    sendEvent('error', { 
      success: false,
      error: error.message,
      message: 'Erreur lors de la génération des messages'
    });
    res.end();
  }
});

// Répéter le même pattern pour les autres endpoints /api/...
// (Je vais ajouter seulement un autre pour l'exemple, mais vous devez faire pareil pour tous)

app.post('/api/regenerer/messages', async (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { id } = req.body;

  logger.info('🔄 [API] Début régénération messages', {
    requestId: req.requestId,
    id,
    endpoint: '/api/regenerer/messages'
  });

  try {
    sendEvent('start', { message: 'Démarrage régénération des messages...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/regenerer/messages';
    sendEvent('progress', { message: 'Envoi de la requête au webhook...' });
    
    const startRequest = Date.now();
    const response = await axios.post(webhookUrl, { id }, { timeout: 30000 });
    const requestDuration = Date.now() - startRequest;
    
    logger.info('📥 [API] Réponse régénération reçue', {
      requestId: req.requestId,
      duration: `${requestDuration}ms`,
      status: response.status
    });
    
    sendEvent('progress', { 
      message: 'Réponse reçue du webhook',
      data: response.data,
      requestDuration: `${requestDuration}ms`
    });

    let data = response.data;
    if (data.executionUrl) {
      sendEvent('polling_start', { message: 'Démarrage du polling pour suivre l\'exécution...' });
      data = await pollWorkflow(data.executionUrl, sendEvent, req.requestId);
    }

    sendEvent('completed', { 
      success: true,
      message: 'Messages régénérés avec succès', 
      data: data
    });
    res.end();
  } catch (error) {
    stats.totalErrors++;
    logger.error('❌ [API] Erreur régénération messages', {
      requestId: req.requestId,
      error: error.message,
      stack: error.stack
    });
    
    sendEvent('error', { 
      success: false,
      error: error.message,
      message: 'Erreur lors de la régénération des messages'
    });
    res.end();
  }
});

// 9. Vérifier l'état d'une exécution
app.get('/api/execution/:executionId', async (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { executionId } = req.params;

  logger.info('🔍 Vérification exécution', {
    requestId: req.requestId,
    executionId
  });

  try {
    sendEvent('start', { message: `Vérification de l'exécution ${executionId}...` });

    const executionUrl = `https://n8n.srv903010.hstgr.cloud/api/v1/executions/${executionId}`;
    sendEvent('progress', { message: 'Récupération des informations d\'exécution...' });
    
    logger.debug('📤 Requête info exécution', {
      requestId: req.requestId,
      executionUrl,
      executionId
    });
    
    const startRequest = Date.now();
    const response = await axios.get(executionUrl, { timeout: 15000 });
    const requestDuration = Date.now() - startRequest;
    
    logger.info('📥 Info exécution reçue', {
      requestId: req.requestId,
      duration: `${requestDuration}ms`,
      status: response.status,
      executionStatus: response.data?.finished ? 'finished' : 'running'
    });
    
    sendEvent('progress', { message: 'Données d\'exécution récupérées' });

    sendEvent('completed', { 
      success: true,
      message: 'Informations d\'exécution récupérées avec succès',
      data: response.data,
      requestDuration: `${requestDuration}ms`
    });
    res.end();
  } catch (error) {
    stats.totalErrors++;
    logger.error('❌ Erreur vérification exécution', {
      requestId: req.requestId,
      executionId,
      error: error.message,
      stack: error.stack
    });
    
    sendEvent('error', { 
      success: false,
      error: error.message,
      message: 'Erreur lors de la récupération des informations d\'exécution'
    });
    res.end();
  }
});

// 10. Endpoint de santé avec statistiques détaillées
app.get('/health', (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  
  logger.info('💚 Vérification santé serveur', {
    requestId: req.requestId
  });
  
  sendEvent('start', { message: 'Vérification de l\'état du serveur...' });
  
  const memUsage = process.memoryUsage();
  const healthData = {
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    uptimeFormatted: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
    },
    version: process.version,
    platform: process.platform,
    stats: {
      activeConnections: stats.activeConnections,
      totalRequests: stats.totalRequests,
      totalErrors: stats.totalErrors,
      errorRate: stats.totalRequests > 0 ? `${((stats.totalErrors / stats.totalRequests) * 100).toFixed(2)}%` : '0%',
      requestsByEndpoint: stats.requestsByEndpoint
    }
  };
  
  logger.info('📊 Statistiques serveur collectées', {
    requestId: req.requestId,
    healthData
  });
  
  sendEvent('progress', { message: 'Collecte des informations système...' });
  
  sendEvent('completed', { 
    success: true,
    message: 'Serveur en bonne santé',
    data: healthData
  });
  
  res.end();
});

// 11. Liste des webhooks disponibles
app.get('/api/webhooks', (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  
  logger.info('📋 Récupération liste webhooks', {
    requestId: req.requestId
  });
  
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
    { path: '/api/webhooks', method: 'GET', description: 'Liste des webhooks disponibles (SSE)' },
    { path: '/debug/stats', method: 'GET', description: 'Statistiques détaillées de débogage' }
  ];
  
  sendEvent('progress', { message: 'Liste des endpoints compilée' });
  
  sendEvent('completed', {
    success: true,
    message: 'Liste des webhooks récupérée avec succès',
    data: {
      webhooks,
      total: webhooks.length,
      currentStats: stats,
      note: 'Tous les endpoints utilisent maintenant Server-Sent Events (SSE) pour le streaming en temps réel'
    }
  });
  
  res.end();
});

// 12. Endpoint de débogage pour statistiques détaillées
app.get('/debug/stats', (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  
  logger.info('🔧 Accès aux statistiques de débogage', {
    requestId: req.requestId
  });
  
  sendEvent('start', { message: 'Collecte des statistiques de débogage...' });
  
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  
  // Calculer les connexions actives les plus anciennes
  const oldestConnections = Array.from(stats.connectionStartTimes.entries())
    .sort(([,a], [,b]) => a - b)
    .slice(0, 5)
    .map(([requestId, startTime]) => ({
      requestId,
      age: `${Math.round((Date.now() - startTime) / 1000)}s`
    }));
  
  const debugStats = {
    timestamp: new Date().toISOString(),
    server: {
      uptime: process.uptime(),
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid
    },
    memory: {
      rss: memUsage.rss,
      heapTotal: memUsage.heapTotal,
      heapUsed: memUsage.heapUsed,
      external: memUsage.external,
      arrayBuffers: memUsage.arrayBuffers
    },
    cpu: {
      user: cpuUsage.user,
      system: cpuUsage.system
    },
    connections: {
      active: stats.activeConnections,
      total: stats.totalRequests,
      errors: stats.totalErrors,
      errorRate: stats.totalRequests > 0 ? (stats.totalErrors / stats.totalRequests) * 100 : 0,
      oldestActive: oldestConnections
    },
    endpoints: stats.requestsByEndpoint,
    environment: {
      nodeEnv: process.env.NODE_ENV,
      port: PORT,
      n8nUrl: N8N_WEBHOOK_URL,
      logLevel: Object.keys(LOG_LEVELS)[Object.values(LOG_LEVELS).indexOf(CURRENT_LOG_LEVEL)]
    }
  };
  
  logger.debug('📊 Statistiques de débogage collectées', {
    requestId: req.requestId,
    statsSize: JSON.stringify(debugStats).length
  });
  
  sendEvent('progress', { message: 'Analyse des performances...' });
  
  // Ajouter des recommandations basées sur les stats
  const recommendations = [];
  
  if (debugStats.memory.heapUsed / debugStats.memory.heapTotal > 0.8) {
    recommendations.push('⚠️ Utilisation mémoire élevée (>80%)');
  }
  
  if (stats.totalErrors / stats.totalRequests > 0.1) {
    recommendations.push('⚠️ Taux d\'erreur élevé (>10%)');
  }
  
  if (stats.activeConnections > 100) {
    recommendations.push('⚠️ Nombre élevé de connexions actives');
  }
  
  if (oldestConnections.length > 0 && parseInt(oldestConnections[0].age) > 300) {
    recommendations.push('⚠️ Connexions anciennes détectées (>5min)');
  }
  
  sendEvent('completed', {
    success: true,
    message: 'Statistiques de débogage collectées',
    data: {
      ...debugStats,
      recommendations,
      health: recommendations.length === 0 ? 'GOOD' : 'NEEDS_ATTENTION'
    }
  });
  
  res.end();
});

// Endpoint pour ajuster le niveau de log dynamiquement
app.post('/debug/log-level', (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { level } = req.body;
  
  logger.info('🔧 Changement niveau de log', {
    requestId: req.requestId,
    oldLevel: Object.keys(LOG_LEVELS)[Object.values(LOG_LEVELS).indexOf(CURRENT_LOG_LEVEL)],
    newLevel: level
  });
  
  sendEvent('start', { message: 'Modification du niveau de log...' });
  
  if (level && LOG_LEVELS.hasOwnProperty(level.toUpperCase())) {
    const oldLevel = CURRENT_LOG_LEVEL;
    const newLevel = LOG_LEVELS[level.toUpperCase()];
    
    // Note: Dans un vrai serveur, vous devriez avoir une variable globale modifiable
    // Pour cette demo, on simule juste le changement
    
    logger.info('✅ Niveau de log modifié', {
      requestId: req.requestId,
      from: Object.keys(LOG_LEVELS)[Object.values(LOG_LEVELS).indexOf(oldLevel)],
      to: level.toUpperCase()
    });
    
    sendEvent('completed', {
      success: true,
      message: `Niveau de log changé vers ${level.toUpperCase()}`,
      data: {
        oldLevel: Object.keys(LOG_LEVELS)[Object.values(LOG_LEVELS).indexOf(oldLevel)],
        newLevel: level.toUpperCase(),
        availableLevels: Object.keys(LOG_LEVELS)
      }
    });
  } else {
    logger.warn('⚠️ Niveau de log invalide', {
      requestId: req.requestId,
      requestedLevel: level,
      availableLevels: Object.keys(LOG_LEVELS)
    });
    
    sendEvent('error', {
      success: false,
      error: 'Niveau de log invalide',
      message: `Niveaux disponibles: ${Object.keys(LOG_LEVELS).join(', ')}`,
      availableLevels: Object.keys(LOG_LEVELS)
    });
  }
  
  res.end();
});

// Endpoint pour nettoyer les connexions zombies
app.post('/debug/cleanup', (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  
  logger.info('🧹 Nettoyage des connexions zombies', {
    requestId: req.requestId
  });
  
  sendEvent('start', { message: 'Nettoyage des connexions zombies...' });
  
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  let cleanedCount = 0;
  
  for (const [requestId, startTime] of stats.connectionStartTimes.entries()) {
    if (now - startTime > maxAge) {
      stats.connectionStartTimes.delete(requestId);
      stats.activeConnections = Math.max(0, stats.activeConnections - 1);
      cleanedCount++;
      
      logger.debug('🗑️ Connexion zombie nettoyée', {
        zombieRequestId: requestId,
        age: `${Math.round((now - startTime) / 1000)}s`
      });
    }
  }
  
  logger.info('✅ Nettoyage terminé', {
    requestId: req.requestId,
    cleanedConnections: cleanedCount,
    remainingConnections: stats.activeConnections
  });
  
  sendEvent('completed', {
    success: true,
    message: 'Nettoyage terminé',
    data: {
      cleanedConnections: cleanedCount,
      remainingActiveConnections: stats.activeConnections,
      totalConnectionsTracked: stats.connectionStartTimes.size
    }
  });
  
  res.end();
});

// Ajouter les autres endpoints /api/ manquants avec le même niveau de logging

app.post('/api/enrichir/contacte', async (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { id } = req.body;

  logger.info('💰 [API] Début enrichissement contacts', {
    requestId: req.requestId,
    id,
    endpoint: '/api/enrichir/contacte'
  });

  try {
    sendEvent('start', { message: 'Démarrage enrichissement des contacts...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook-test/enrichir/contacte';
    sendEvent('progress', { message: 'Envoi de la requête au webhook...' });
    
    const startRequest = Date.now();
    const response = await axios.post(webhookUrl, { id }, { timeout: 30000 });
    const requestDuration = Date.now() - startRequest;
    
    logger.info('📥 [API] Réponse enrichissement reçue', {
      requestId: req.requestId,
      duration: `${requestDuration}ms`,
      status: response.status
    });
    
    sendEvent('progress', { 
      message: 'Réponse reçue du webhook',
      data: response.data,
      requestDuration: `${requestDuration}ms`
    });

    let data = response.data;
    if (data.executionUrl) {
      sendEvent('polling_start', { message: 'Démarrage du polling pour suivre l\'exécution...' });
      data = await pollWorkflow(data.executionUrl, sendEvent, req.requestId);
    }

    sendEvent('completed', { 
      success: true,
      message: 'Enrichissement lancé avec succès', 
      data: data
    });
    res.end();
  } catch (error) {
    stats.totalErrors++;
    logger.error('❌ [API] Erreur enrichissement contacts', {
      requestId: req.requestId,
      error: error.message,
      stack: error.stack
    });
    
    sendEvent('error', { 
      success: false,
      error: error.message,
      message: 'Erreur lors de l\'enrichissement'
    });
    res.end();
  }
});

app.post('/api/supprimer/contact/reject', async (req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  const { id } = req.body;

  logger.info('🗑️ [API] Début suppression contacts rejetés', {
    requestId: req.requestId,
    id,
    endpoint: '/api/supprimer/contact/reject'
  });

  try {
    sendEvent('start', { message: 'Démarrage suppression des contacts rejetés...' });

    const webhookUrl = 'https://n8n.srv903010.hstgr.cloud/webhook/supprimer/contact/reject';
    sendEvent('progress', { message: 'Envoi de la requête au webhook...' });
    
    const startRequest = Date.now();
    const response = await axios.post(webhookUrl, { id }, { timeout: 30000 });
    const requestDuration = Date.now() - startRequest;
    
    logger.info('📥 [API] Réponse suppression reçue', {
      requestId: req.requestId,
      duration: `${requestDuration}ms`,
      status: response.status
    });
    
    sendEvent('progress', { 
      message: 'Réponse reçue du webhook',
      data: response.data,
      requestDuration: `${requestDuration}ms`
    });

    let data = response.data;
    if (data.executionUrl) {
      sendEvent('polling_start', { message: 'Démarrage du polling pour suivre l\'exécution...' });
      data = await pollWorkflow(data.executionUrl, sendEvent, req.requestId);
    }

    sendEvent('completed', { 
      success: true,
      message: 'Contacts rejetés supprimés avec succès', 
      data: data
    });
    res.end();
  } catch (error) {
    stats.totalErrors++;
    logger.error('❌ [API] Erreur suppression contacts', {
      requestId: req.requestId,
      error: error.message,
      stack: error.stack
    });
    
    sendEvent('error', { 
      success: false,
      error: error.message,
      message: 'Erreur lors de la suppression'
    });
    res.end();
  }
});

// Gestion des erreurs 404 (maintenant en SSE)
app.use((req, res) => {
  const { sendEvent } = createSSEResponse(res, req.requestId);
  
  logger.warn('❓ Endpoint non trouvé', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    ip: req.ip
  });
  
  sendEvent('start', { message: 'Traitement de la requête...' });
  
  sendEvent('error', { 
    success: false,
    status: 404,
    error: 'Endpoint non trouvé',
    message: `L'endpoint ${req.method} ${req.path} n'existe pas`,
    availableEndpoints: '/api/webhooks',
    suggestion: 'Consultez /api/webhooks pour voir tous les endpoints disponibles',
    requestInfo: {
      method: req.method,
      path: req.path,
      timestamp: new Date().toISOString()
    }
  });
  
  res.end();
});

// Gestion des erreurs globales (maintenant en SSE si possible)
app.use((error, req, res, next) => {
  stats.totalErrors++;
  
  logger.error('💥 Erreur serveur globale', {
    requestId: req.requestId || 'unknown',
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    totalErrors: stats.totalErrors
  });
  
  // Vérifier si les headers ont déjà été envoyés
  if (res.headersSent) {
    logger.error('⚠️ Headers déjà envoyés, impossible de répondre', {
      requestId: req.requestId || 'unknown'
    });
    return next(error);
  }
  
  const { sendEvent } = createSSEResponse(res, req.requestId || 'unknown');
  
  sendEvent('error', { 
    success: false,
    status: 500,
    error: 'Erreur interne du serveur',
    message: error.message,
    timestamp: new Date().toISOString(),
    requestId: req.requestId || 'unknown',
    errorCode: error.code || 'UNKNOWN'
  });
  
  res.end();
});

// Nettoyage périodique des connexions zombies
setInterval(() => {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes
  let cleanedCount = 0;
  
  for (const [requestId, startTime] of stats.connectionStartTimes.entries()) {
    if (now - startTime > maxAge) {
      stats.connectionStartTimes.delete(requestId);
      stats.activeConnections = Math.max(0, stats.activeConnections - 1);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    logger.info('🧹 Nettoyage automatique connexions zombies', {
      cleanedCount,
      remainingConnections: stats.activeConnections
    });
  }
}, 5 * 60 * 1000); // Toutes les 5 minutes

// Log périodique des statistiques
setInterval(() => {
  const memUsage = process.memoryUsage();
  logger.info('📊 Statistiques périodiques', {
    uptime: `${Math.round(process.uptime())}s`,
    memory: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
    activeConnections: stats.activeConnections,
    totalRequests: stats.totalRequests,
    totalErrors: stats.totalErrors,
    errorRate: stats.totalRequests > 0 ? `${((stats.totalErrors / stats.totalRequests) * 100).toFixed(2)}%` : '0%'
  });
}, 2 * 60 * 1000); // Toutes les 2 minutes

app.listen(PORT, () => {
  logger.info('🚀 Serveur SSE Node.js démarré', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
    logLevel: Object.keys(LOG_LEVELS)[Object.values(LOG_LEVELS).indexOf(CURRENT_LOG_LEVEL)]
  });
  
  console.log(`🚀 SSE Node.js server running on port ${PORT}`);
  console.log(`📋 Liste des webhooks disponibles: http://localhost:${PORT}/api/webhooks`);
  console.log(`💚 Santé du serveur: http://localhost:${PORT}/health`);
  console.log(`🔧 Statistiques de débogage: http://localhost:${PORT}/debug/stats`);
  console.log(`🌊 Tous les endpoints utilisent maintenant Server-Sent Events (SSE)`);
  console.log(`🐛 Niveau de log: ${Object.keys(LOG_LEVELS)[Object.values(LOG_LEVELS).indexOf(CURRENT_LOG_LEVEL)]}`);
});