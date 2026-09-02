BEGIN TRY

BEGIN TRAN;

-- Permiso de borrado por usuario admin.
--
-- El sistema NO tiene roles y sigue sin tenerlos: esto es UN flag booleano
-- sobre la unica clase de accion que no tiene vuelta atras (borrar productos,
-- categorias, anuncios y otros usuarios). Lo verifica
-- `middlewares/permisoBorrado.middleware.js` despues de `requireAuth`, que lo
-- lee de esta columna en la misma consulta que ya hacia para verificar
-- `tokenVersion` — o sea, sin consulta extra.
--
-- Se lee de la BASE y no del JWT a proposito: quitarle el permiso a alguien
-- surte efecto en la request siguiente, no cuando expire su token 24 horas
-- despues.
--
-- ADITIVA Y SEGURA: NOT NULL con DEFAULT 1, asi el ADD COLUMN backfillea a
-- "puede" sin bloquear el `prisma migrate deploy` que el Dockerfile corre al
-- arrancar.
--
-- EL DEFAULT ES 1 (true) Y ESO NO ES DESCUIDO. Con 0 el primer deploy dejaria
-- a TODOS los admin sin poder borrar nada y la operacion se frenaria hasta que
-- alguien editara la base a mano. Los usuarios existentes conservan lo que ya
-- podian hacer; restringir es una decision explicita que se toma despues,
-- usuario por usuario, desde /catalogo/admin/usuarios.
--
-- AlterTable
ALTER TABLE [dbo].[Usuario] ADD [puedeEliminar] BIT NOT NULL CONSTRAINT [Usuario_puedeEliminar_df] DEFAULT 1;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
