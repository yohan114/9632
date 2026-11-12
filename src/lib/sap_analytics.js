'use strict';

/**
 * SAP Analytics, CDS Models & Datasphere Integration (sap-sqlscript, sap-datasphere, sap-abap-cds, sap-bw-query, sap-hana-ml).
 * Provides semantic CDS definitions and generates HANA Cloud / Datasphere export packages.
 */

const { all } = require('../db');

/**
 * Return semantic Core Data Services (CDS) model definitions
 */
function getCdsAnalyticalModels() {
  return `
namespace workshopone.analytics;

@Analytics.dataCategory: #CUBE
entity C_EquipmentMaintenanceCube {
  key EquipmentId          : Integer;
      EquipmentNumber      : String(40);
      Category             : String(50);
      Brand                : String(50);
      OperatingStatus      : String(20);
      CurrentWorkshop      : String(100);
      
      @DefaultAggregation: #SUM
      TotalJobOrders       : Integer;
      
      @DefaultAggregation: #SUM
      TotalLabourCost      : Decimal(15, 2);
      
      @DefaultAggregation: #SUM
      TotalMaterialCost    : Decimal(15, 2);
      
      @DefaultAggregation: #SUM
      TotalMaintenanceCost : Decimal(15, 2);
};

@Analytics.dataCategory: #DIMENSION
entity C_MaterialInventoryDimension {
  key MaterialId           : Integer;
      MaterialNumber       : String(40);
      Description          : String(255);
      Category             : String(50);
      StockUoM             : String(10);
      CurrentStock         : Decimal(13, 3);
      BinLocation          : String(30);
};
`;
}

/**
 * Return SAP HANA Cloud / SQLScript DDL for deployment into HDI Containers
 */
function getHanaSqlScriptDdl() {
  return `
-- SAP HANA Cloud SQLScript Schema for WorkshopOne Analytics
-- Target HDI Container: WORKSHOPONE_HDI_DB

CREATE COLUMN TABLE "WORKSHOPONE_EQUIPMENT_ANALYTICS" (
    "EQUIPMENT_ID" INTEGER NOT NULL,
    "EQUIPMENT_NUM" NVARCHAR(40) NOT NULL,
    "CATEGORY" NVARCHAR(50),
    "BRAND" NVARCHAR(50),
    "STATUS" NVARCHAR(20),
    "WORKSHOP_NAME" NVARCHAR(100),
    "TOTAL_JOBS" INTEGER,
    "TOTAL_MAINT_COST" DECIMAL(15, 2),
    PRIMARY KEY ("EQUIPMENT_ID")
);

-- Calculation View projection logic
CREATE VIEW "CV_EQUIPMENT_MTBF" AS
SELECT 
    "EQUIPMENT_ID",
    "EQUIPMENT_NUM",
    "CATEGORY",
    "TOTAL_JOBS",
    "TOTAL_MAINT_COST"
FROM "WORKSHOPONE_EQUIPMENT_ANALYTICS";
`;
}

/**
 * Extract Datasphere-ready aggregated dataset for Space ingestion
 */
function extractDataspherePackage() {
  const equipmentAnalytics = all(`
    SELECT a.id AS EquipmentId,
           a.code AS EquipmentNumber,
           COALESCE(a.type, 'Unknown') AS Category,
           COALESCE(a.brand, 'Unknown') AS Brand,
           COALESCE(a.status, 'active') AS OperatingStatus,
           COALESCE(p.name, 'Central Workshop') AS CurrentWorkshop,
           COUNT(j.id) AS TotalJobOrders,
           COALESCE(SUM(j.labour_cost), 0) AS TotalLabourCost,
           COALESCE(SUM(j.material_cost), 0) AS TotalMaterialCost,
           COALESCE(SUM(j.total_cost), 0) AS TotalMaintenanceCost
      FROM assets a
      LEFT JOIN projects p ON p.id = a.current_project_id
      LEFT JOIN job_cards j ON j.asset_id = a.id
     GROUP BY a.id
     ORDER BY TotalMaintenanceCost DESC
     LIMIT 500
  `);

  return {
    metadata: {
      datasphereSpace: 'WORKSHOP_ANALYTICS',
      generatedAt: new Date().toISOString(),
      recordCount: equipmentAnalytics.length,
      modelType: 'FACT_TABLE'
    },
    data: equipmentAnalytics
  };
}

module.exports = {
  getCdsAnalyticalModels,
  getHanaSqlScriptDdl,
  extractDataspherePackage
};
