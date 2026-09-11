BEGIN TRY

BEGIN TRAN;

-- CuentaCliente.verificadaEn: fecha de la PRIMERA verificación, nunca se borra.
-- La regla de las 24 h (purga global, login, reenvío, reseteo) aplica solo
-- mientras es NULL: la reasignación operada del email apaga emailVerificado en
-- una cuenta real, con pedidos, que no es un registro abandonado.
-- AlterTable
ALTER TABLE [dbo].[CuentaCliente] ADD [verificadaEn] DATETIME2;

-- Backfill: toda cuenta ya verificada queda cubierta desde hoy. Sin esto, una
-- verificada existente que después se reasigne volvería a caer en la regla de
-- las 24 h. Se usa `createdAt` (inmutable, y nunca posterior a la verificación
-- real); lo único que se lee de la columna es si es NULL o no.
--
-- Va dentro de un EXEC a propósito: SQL Server compila el lote entero antes de
-- ejecutarlo y un UPDATE que nombra la columna recién agregada falla con
-- "Invalid column name" (mismo caso que 20260823000000_agregar_stock_descontado_orden).
EXEC('UPDATE [dbo].[CuentaCliente] SET [verificadaEn] = [createdAt] WHERE [emailVerificado] = 1 AND [verificadaEn] IS NULL;');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
