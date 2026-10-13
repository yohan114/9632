'use strict';

const express = require('express');
const router = express.Router();
const { all, get } = require('../../db');
const { requireSapAuth } = require('./auth');

/**
 * Helper to parse standard OData query parameters ($top, $skip, $select, $orderby, $count)
 */
function parseODataParams(query, defaultTop = 50, maxTop = 500) {
  let top = parseInt(query['$top'] || query.top, 10);
  if (isNaN(top) || top <= 0) top = defaultTop;
  if (top > maxTop) top = maxTop;

  let skip = parseInt(query['$skip'] || query.skip, 10);
  if (isNaN(skip) || skip < 0) skip = 0;

  const count = query['$count'] === 'true' || query.count === 'true';
  const select = query['$select'] || query.select;
  const filter = query['$filter'] || query.filter;
  const orderby = query['$orderby'] || query.orderby;

  return { top, skip, count, select, filter, orderby };
}

// 1. OData v4 Service Document
router.get('/', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
  res.json({
    '@odata.context': `${baseUrl}/$metadata`,
    value: [
      { name: 'Equipments', kind: 'EntitySet', url: 'Equipments' },
      { name: 'MaintenanceOrders', kind: 'EntitySet', url: 'MaintenanceOrders' },
      { name: 'MaterialMaster', kind: 'EntitySet', url: 'MaterialMaster' },
      { name: 'GoodsMovements', kind: 'EntitySet', url: 'GoodsMovements' }
    ]
  });
});

// 2. OData v4 Metadata Document ($metadata)
router.get('/\\$metadata', (req, res) => {
  res.set('Content-Type', 'application/xml; charset=utf-8');
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="WorkshopOne.Enterprise" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Equipment">
        <Key>
          <PropertyRef Name="EquipmentId" />
        </Key>
        <Property Name="EquipmentId" Type="Edm.Int32" Nullable="false" />
        <Property Name="EquipmentNumber" Type="Edm.String" Nullable="false" />
        <Property Name="LicensePlate" Type="Edm.String" />
        <Property Name="Description" Type="Edm.String" />
        <Property Name="Brand" Type="Edm.String" />
        <Property Name="Category" Type="Edm.String" />
        <Property Name="OperatingStatus" Type="Edm.String" />
        <Property Name="CurrentWorkshop" Type="Edm.String" />
      </EntityType>
      
      <EntityType Name="MaintenanceOrder">
        <Key>
          <PropertyRef Name="OrderId" />
        </Key>
        <Property Name="OrderId" Type="Edm.Int32" Nullable="false" />
        <Property Name="OrderNumber" Type="Edm.String" Nullable="false" />
        <Property Name="EquipmentId" Type="Edm.Int32" />
        <Property Name="OrderType" Type="Edm.String" />
        <Property Name="Priority" Type="Edm.String" />
        <Property Name="WorkDescription" Type="Edm.String" />
        <Property Name="OrderDate" Type="Edm.Date" />
        <Property Name="Status" Type="Edm.String" />
      </EntityType>

      <EntityType Name="MaterialMaster">
        <Key>
          <PropertyRef Name="MaterialId" />
        </Key>
        <Property Name="MaterialId" Type="Edm.Int32" Nullable="false" />
        <Property Name="MaterialNumber" Type="Edm.String" Nullable="false" />
        <Property Name="Description" Type="Edm.String" />
        <Property Name="Category" Type="Edm.String" />
        <Property Name="StockUoM" Type="Edm.String" />
        <Property Name="CurrentStock" Type="Edm.Decimal" Scale="2" />
        <Property Name="BinLocation" Type="Edm.String" />
      </EntityType>

      <EntityType Name="GoodsMovement">
        <Key>
          <PropertyRef Name="MovementId" />
        </Key>
        <Property Name="MovementId" Type="Edm.Int32" Nullable="false" />
        <Property Name="DocumentNumber" Type="Edm.String" Nullable="false" />
        <Property Name="MovementType" Type="Edm.String" Nullable="false" />
        <Property Name="PostingDate" Type="Edm.Date" />
        <Property Name="MaterialNumber" Type="Edm.String" />
        <Property Name="Quantity" Type="Edm.Decimal" Scale="2" />
      </EntityType>

      <EntityContainer Name="WorkshopOneContainer">
        <EntitySet Name="Equipments" EntityType="WorkshopOne.Enterprise.Equipment" />
        <EntitySet Name="MaintenanceOrders" EntityType="WorkshopOne.Enterprise.MaintenanceOrder" />
        <EntitySet Name="MaterialMaster" EntityType="WorkshopOne.Enterprise.MaterialMaster" />
        <EntitySet Name="GoodsMovements" EntityType="WorkshopOne.Enterprise.GoodsMovement" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
  res.send(xml);
});

// 3. Equipments Entity Set (SAP PM / EAM Equipment Master)
router.get('/Equipments', requireSapAuth('EAM_Tech'), (req, res) => {
  const { top, skip, count } = parseODataParams(req.query);

  const total = count ? (get('SELECT COUNT(*) as cnt FROM assets') || {}).cnt || 0 : undefined;
  const rows = all(`
    SELECT a.id AS EquipmentId,
           a.code AS EquipmentNumber,
           COALESCE(a.registration, a.code) AS LicensePlate,
           TRIM(COALESCE(a.brand, '') || ' ' || COALESCE(a.type, '')) AS Description,
           a.brand AS Brand,
           a.type AS Category,
           COALESCE(a.status, 'active') AS OperatingStatus,
           COALESCE(p.name, 'Central Workshop') AS CurrentWorkshop
      FROM assets a
      LEFT JOIN projects p ON p.id = a.current_project_id
     ORDER BY a.id ASC
     LIMIT ? OFFSET ?
  `, top, skip);

  const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
  const response = {
    '@odata.context': `${baseUrl}/$metadata#Equipments`,
    value: rows
  };
  if (count) response['@odata.count'] = total;
  res.json(response);
});

// 4. MaintenanceOrders Entity Set (SAP PM Maintenance Orders / IW31)
router.get('/MaintenanceOrders', requireSapAuth('EAM_Tech'), (req, res) => {
  const { top, skip, count } = parseODataParams(req.query);

  const total = count ? (get('SELECT COUNT(*) as cnt FROM job_cards') || {}).cnt || 0 : undefined;
  const rows = all(`
    SELECT j.id AS OrderId,
           j.job_no AS OrderNumber,
           j.asset_id AS EquipmentId,
           j.type AS OrderType,
           COALESCE(j.severity, 'normal') AS Priority,
           j.description AS WorkDescription,
           SUBSTR(COALESCE(j.requested_at, CURRENT_TIMESTAMP), 1, 10) AS OrderDate,
           j.status AS Status,
           COALESCE(w.name, 'Central Workshop') AS Workshop
      FROM job_cards j
      LEFT JOIN workshops w ON w.id = j.workshop_id
     ORDER BY j.id DESC
     LIMIT ? OFFSET ?
  `, top, skip);

  const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
  const response = {
    '@odata.context': `${baseUrl}/$metadata#MaintenanceOrders`,
    value: rows
  };
  if (count) response['@odata.count'] = total;
  res.json(response);
});

// 5. MaterialMaster Entity Set (SAP MM Material Master / MARA)
router.get('/MaterialMaster', requireSapAuth('MM_Clerk'), (req, res) => {
  const { top, skip, count } = parseODataParams(req.query);

  const total = count ? (get('SELECT COUNT(*) as cnt FROM store_items') || {}).cnt || 0 : undefined;
  const rows = all(`
    SELECT i.id AS MaterialId,
           COALESCE(i.part_number, i.item_no, 'MAT-' || i.id) AS MaterialNumber,
           COALESCE(i.name, i.description, '') AS Description,
           i.category AS Category,
           COALESCE(i.unit, 'EA') AS StockUoM,
           COALESCE(i.balance, 0) AS CurrentStock,
           COALESCE(i.rack, 'CENTRAL') AS BinLocation
      FROM store_items i
     ORDER BY i.id ASC
     LIMIT ? OFFSET ?
  `, top, skip);

  const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
  const response = {
    '@odata.context': `${baseUrl}/$metadata#MaterialMaster`,
    value: rows
  };
  if (count) response['@odata.count'] = total;
  res.json(response);
});

// 6. GoodsMovements Entity Set (SAP MM Inventory Transactions / MSEG)
router.get('/GoodsMovements', requireSapAuth('MM_Clerk'), (req, res) => {
  const { top, skip, count } = parseODataParams(req.query);

  const total = count ? (get('SELECT COUNT(*) as cnt FROM issues') || {}).cnt || 0 : undefined;
  const rows = all(`
    SELECT iss.id AS MovementId,
           COALESCE(iss.min_no, 'ISS-' || iss.id) AS DocumentNumber,
           '201-GI-Workshop' AS MovementType,
           SUBSTR(COALESCE(iss.issue_date, CURRENT_TIMESTAMP), 1, 10) AS PostingDate,
           COALESCE(item.part_number, item.item_no, 'MAT-' || iss.store_item_id) AS MaterialNumber,
           iss.qty AS Quantity
      FROM issues iss
      LEFT JOIN store_items item ON item.id = iss.store_item_id
     ORDER BY iss.id DESC
     LIMIT ? OFFSET ?
  `, top, skip);

  const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
  const response = {
    '@odata.context': `${baseUrl}/$metadata#GoodsMovements`,
    value: rows
  };
  if (count) response['@odata.count'] = total;
  res.json(response);
});

module.exports = router;
