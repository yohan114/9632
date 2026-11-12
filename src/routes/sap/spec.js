'use strict';

/**
 * SAP API Style Guide compliant OpenAPI 3.0 Specification.
 * Includes x-sap-stateInfo, Entity Data Model definitions, and standard response envelopes.
 */
function getOpenApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'WorkshopOne SAP Integration Gateway API',
      description: 'Enterprise REST & OData v4 gateway for WorkshopOne Central Workshop Master System. Exposes Equipment Master (PM/EAM), Maintenance Orders, Material Master (MM), and Goods Movements.',
      version: '1.0.0',
      contact: {
        name: 'Edward & Christie Central Workshop Integration Team',
        email: 'workshop@edwardchristie.com'
      },
      'x-sap-stateInfo': {
        state: 'active',
        deprecationDate: null,
        successor: null
      },
      'x-sap-api-type': 'ODATA4'
    },
    servers: [
      {
        url: '/api/sap/v1',
        description: 'WorkshopOne Edge SAP Gateway'
      }
    ],
    paths: {
      '/odata/': {
        get: {
          summary: 'OData v4 Service Document',
          description: 'Lists all available entity sets in the WorkshopOne OData service.',
          responses: {
            '200': {
              description: 'Service document successfully retrieved'
            }
          }
        }
      },
      '/odata/$metadata': {
        get: {
          summary: 'OData v4 Metadata Document',
          description: 'Returns the EDM XML schema definition for WorkshopOne entities.',
          responses: {
            '200': {
              description: 'EDM XML schema document'
            }
          }
        }
      },
      '/odata/Equipments': {
        get: {
          summary: 'Equipment Master List (SAP EAM / PM)',
          description: 'Retrieves vehicles, heavy machinery, and plant assets with operational status, specs, and workshop assignment.',
          parameters: [
            { name: '$top', in: 'query', schema: { type: 'integer' }, description: 'Number of records to return' },
            { name: '$skip', in: 'query', schema: { type: 'integer' }, description: 'Number of records to skip' },
            { name: '$filter', in: 'query', schema: { type: 'string' }, description: 'OData filter expression (e.g. status eq active)' },
            { name: '$count', in: 'query', schema: { type: 'boolean' }, description: 'Include total count of matching records' }
          ],
          responses: {
            '200': {
              description: 'List of Equipment entities',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      '@odata.context': { type: 'string' },
                      '@odata.count': { type: 'integer' },
                      value: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Equipment' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/odata/MaintenanceOrders': {
        get: {
          summary: 'Maintenance Orders & Job Cards (SAP PM / IW31)',
          description: 'Retrieves workshop job cards and transport job requests.',
          parameters: [
            { name: '$top', in: 'query', schema: { type: 'integer' } },
            { name: '$skip', in: 'query', schema: { type: 'integer' } },
            { name: '$filter', in: 'query', schema: { type: 'string' } }
          ],
          responses: {
            '200': {
              description: 'List of Maintenance Orders',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      '@odata.context': { type: 'string' },
                      '@odata.count': { type: 'integer' },
                      value: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/MaintenanceOrder' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/odata/MaterialMaster': {
        get: {
          summary: 'Material Master & Spares Inventory (SAP MM / MARA)',
          description: 'Retrieves store items, part numbers, stock balances, and storage bin locations.',
          responses: {
            '200': {
              description: 'List of Material Master records'
            }
          }
        }
      },
      '/odata/GoodsMovements': {
        get: {
          summary: 'Goods Movements & Inventory Transactions (SAP MM / MSEG)',
          description: 'Retrieves store issue notes (MIN), goods receipts (GRN), and material transfers (MTN).',
          responses: {
            '200': {
              description: 'List of Goods Movements'
            }
          }
        }
      }
    },
    components: {
      schemas: {
        Equipment: {
          type: 'object',
          properties: {
            EquipmentId: { type: 'integer', example: 104 },
            EquipmentNumber: { type: 'string', example: 'WP-EXC-01' },
            LicensePlate: { type: 'string', example: 'WP-1234' },
            Description: { type: 'string', example: 'Komatsu PC200-8 Excavator' },
            Brand: { type: 'string', example: 'Komatsu' },
            Category: { type: 'string', example: 'Excavator' },
            OperatingStatus: { type: 'string', example: 'active' },
            CurrentWorkshop: { type: 'string', example: 'Central Workshop' }
          }
        },
        MaintenanceOrder: {
          type: 'object',
          properties: {
            OrderNumber: { type: 'string', example: 'JC-2026-089' },
            EquipmentId: { type: 'integer', example: 104 },
            OrderType: { type: 'string', example: 'repair' },
            Priority: { type: 'string', example: 'high' },
            WorkDescription: { type: 'string', example: 'Hydraulic main pump seal replacement' },
            OrderDate: { type: 'string', format: 'date', example: '2026-10-13' },
            Status: { type: 'string', example: 'in_progress' },
            EstimatedCost: { type: 'number', example: 45000.00 }
          }
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'RESOURCE_NOT_FOUND' },
                message: { type: 'string', example: 'The requested equipment does not exist.' },
                target: { type: 'string', example: 'EquipmentId' }
              }
            }
          }
        }
      },
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-sap-api-key'
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    },
    security: [
      { ApiKeyAuth: [] },
      { BearerAuth: [] }
    ]
  };
}

module.exports = {
  getOpenApiSpec
};
