-- Métricas comerciales: impresiones y clicks del cartel y del slide.
--
-- Aditiva y reversible: las cuatro columnas nacen en NULL para todas las filas
-- existentes y ninguno de los seis tipos de evento históricos las escribe.
--
-- SIN claves foráneas a Campania ni a Promocion, a propósito. Una FK a
-- Campania abriría un segundo camino de cascada
--   EventoTrafico -> Campania -> CampaniaProducto
-- además del que ya existe
--   EventoTrafico -> Product -> CampaniaProducto
-- y SQL Server rechaza la migración con el error 1785 ("may cause cycles or
-- multiple cascade paths"). Es el mismo motivo por el que
-- `modalCtaReferenciaId` no lleva FK — ver
-- 20260904000000_agregar_vitrina_campania/migration.sql.

ALTER TABLE [dbo].[EventoTrafico] ADD [campaniaId] INT NULL;
ALTER TABLE [dbo].[EventoTrafico] ADD [promocionId] INT NULL;
ALTER TABLE [dbo].[EventoTrafico] ADD [origen] VARCHAR(20) NULL;
ALTER TABLE [dbo].[EventoTrafico] ADD [destino] VARCHAR(20) NULL;

CREATE NONCLUSTERED INDEX [EventoTrafico_campaniaId_tipo_createdAt_idx]
  ON [dbo].[EventoTrafico]([campaniaId], [tipo], [createdAt]);
CREATE NONCLUSTERED INDEX [EventoTrafico_promocionId_tipo_createdAt_idx]
  ON [dbo].[EventoTrafico]([promocionId], [tipo], [createdAt]);
