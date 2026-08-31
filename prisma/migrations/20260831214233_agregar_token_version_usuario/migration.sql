BEGIN TRY

BEGIN TRAN;

-- Revocacion de sesion por version de token (hallazgos AUTH-01/AUTH-02).
--
-- `tokenVersion` se incrementa al cambiar la contrasena de un usuario e
-- invalida todos los JWT emitidos antes del cambio: el login lo copia como
-- claim en el token y `requireAuth` lo compara contra esta columna en cada
-- request. Antes, cambiar la contrasena NO revocaba los tokens ya emitidos —
-- la unica revocacion era borrar el usuario.
--
-- ADITIVA Y SEGURA para las filas existentes: NOT NULL con DEFAULT 0, asi el
-- ADD COLUMN backfillea a 0 sin bloquear el `prisma migrate deploy` que el
-- Dockerfile corre al arrancar. Los tokens viejos (emitidos antes de esta
-- feature) no traen el claim y por eso NO coinciden con este 0: quedan
-- revocados, forzando un unico re-login tras el deploy. Es el comportamiento
-- fail-closed buscado.
--
-- AlterTable
ALTER TABLE [dbo].[Usuario] ADD [tokenVersion] INT NOT NULL CONSTRAINT [Usuario_tokenVersion_df] DEFAULT 0;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
