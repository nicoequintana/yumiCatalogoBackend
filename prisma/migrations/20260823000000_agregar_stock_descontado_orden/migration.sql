-- Orden.stockDescontado: ¿esta orden tiene stock TOMADO ahora mismo?
--
-- Lo enciende la escritura guardada que descuenta al confirmar y lo apaga la
-- que libera al cancelar. Es lo que permite devolver el stock exactamente una
-- vez, sin deducirlo del estado (la re-confirmación está fuera de alcance, así
-- que "está en CONFIRMADA" no implica "tiene stock tomado").
ALTER TABLE [dbo].[Orden] ADD [stockDescontado] BIT NOT NULL CONSTRAINT [Orden_stockDescontado_df] DEFAULT 0;

-- Backfill: las órdenes que ya pasaron por CONFIRMADA tienen su stock tomado.
--
-- Sin esto, el default 0 solo sería correcto en una base vacía: cancelar una
-- orden confirmada ANTES de este deploy no devolvería nada, y en silencio.
--
-- **Va dentro de un EXEC a propósito, y sacarlo rompe la migración.** SQL
-- Server compila el lote entero antes de ejecutar la primera sentencia, así
-- que un UPDATE que nombra la columna recién agregada arriba falla al
-- parsearse con "Invalid column name" — la migración ni siquiera llega a
-- crear la columna. `EXEC` difiere esa compilación hasta que el ALTER ya
-- corrió. (Fuera de Prisma esto se resolvería con un `GO`, que separa lotes;
-- Prisma no lo soporta.)
--
-- Las CANCELADA quedan en 0, que es lo correcto: marcarlas como tenedoras
-- haría que una segunda cancelación devolviera stock que ya no corresponde.
EXEC('UPDATE [dbo].[Orden] SET [stockDescontado] = 1 WHERE [estado] IN (''CONFIRMADA'', ''EN_PREPARACION'', ''ENTREGADA'');');
