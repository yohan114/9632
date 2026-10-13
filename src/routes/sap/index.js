'use strict';

const express = require('express');
const router = express.Router();
const odataRouter = require('./odata');
const { getOpenApiSpec } = require('./spec');
const { requireSapAuth } = require('./auth');

// 1. Gateway Information & Health
router.get('/', (req, res) => {
  res.json({
    service: 'WorkshopOne SAP Integration Gateway',
    version: '1.0.0',
    standards: ['OData v4', 'OpenAPI 3.0.3', 'SAP API Style Guide 2025.01'],
    endpoints: {
      odataServiceDocument: '/api/sap/v1/odata/',
      odataMetadata: '/api/sap/v1/odata/$metadata',
      openApiSpec: '/api/sap/v1/openapi.json',
      health: '/api/sap/v1/healthz'
    },
    'x-sap-stateInfo': {
      state: 'active'
    }
  });
});

router.get('/healthz', (req, res) => {
  res.json({
    status: 'UP',
    gateway: 'active',
    timestamp: new Date().toISOString()
  });
});

// 2. OpenAPI 3.0 Specification
router.get('/openapi.json', (req, res) => {
  res.json(getOpenApiSpec());
});

// 3. SAP BTP MDI Sync & Queue Status (sap-btp-master-data-integration)
const sapSync = require('../../lib/sap_sync');
router.get('/sync/status', requireSapAuth(), (req, res) => {
  res.json(sapSync.getSyncStatus());
});

// 4. SAP Analytics, CDS & Datasphere Exporter (sap-datasphere & sap-abap-cds)
const sapAnalytics = require('../../lib/sap_analytics');
router.get('/analytics/datasphere-package', requireSapAuth(), (req, res) => {
  res.json(sapAnalytics.extractDataspherePackage());
});

router.get('/analytics/cds-models', (req, res) => {
  res.type('text/plain').send(sapAnalytics.getCdsAnalyticalModels());
});

router.get('/analytics/hana-ddl', (req, res) => {
  res.type('text/plain').send(sapAnalytics.getHanaSqlScriptDdl());
});

// 5. Mount OData v4 engine
router.use('/odata', odataRouter);

module.exports = router;
