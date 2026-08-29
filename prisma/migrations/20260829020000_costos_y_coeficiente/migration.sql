BEGIN TRY

BEGIN TRAN;

-- Costos y coeficiente: manejar precios desde el admin.
--
-- El precio de venta pasa a poder calcularse como
-- `redondearACentenaArriba(costo × coeficiente)`, pero SIGUE siendo una columna
-- propia que se escribe cuando el admin aplica el cálculo. No es una columna
-- derivada: cambiar el costo no mueve el precio publicado. Ver
-- `docs/superpowers/specs/2026-08-29-costos-y-precios-admin-design.md`.
--
-- ADITIVA Y SIN BACKFILL. Las tres columnas son nullable a propósito:
--
--  * Los productos ya cargados no tienen costo. Un `NOT NULL` sin default
--    rompería el `prisma migrate deploy` que el Dockerfile corre al arrancar.
--  * Un producto sin costo se comporta exactamente como antes de esta feature:
--    precio tipeado a mano. La adopción es producto por producto, sin fecha de
--    corte y sin que el catálogo público se entere de nada.
--
-- AlterTable
ALTER TABLE [dbo].[Product] ADD
    [costo] DECIMAL(10,0),
    -- MULTIPLICADOR, no porcentaje: 2,05 significa "×2,05" (aumento del 105 %).
    -- Escala 2 — es el único número con decimales del sistema, y es deliberado:
    -- bajo la regla de enteros que gobierna la plata no se podría representar.
    [coeficiente] DECIMAL(5,2);

-- AlterTable
--
-- Snapshot del costo al momento de la compra, mismo criterio que
-- `precioUnitario`. Sin esta columna, el margen de una venta pasada se
-- calcularía contra el costo de HOY: cada aumento de un proveedor reescribiría
-- las ganancias de todos los meses anteriores, sin error y sin aviso.
--
-- Es la única parte irreversible de la feature. Las órdenes anteriores a esta
-- migración quedan con `costoUnitario` en NULL para siempre — el costo vigente
-- en el momento de esas ventas no quedó registrado en ninguna parte, así que no
-- hay backfill posible ni lo habrá más adelante.
--
-- NULL significa "no se puede calcular el margen de esta línea", NUNCA
-- "margen 0". Quien lo consuma tiene que distinguir los dos casos.
ALTER TABLE [dbo].[ItemOrden] ADD
    [costoUnitario] DECIMAL(10,0);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
