-- Los montos del catálogo pasan a ser enteros: `Decimal(10, 2)` -> `Decimal(10, 0)`.
--
-- Alcance: `Product.precio` (el precio vigente) y `ItemOrden.precioUnitario`
-- (el snapshot de la venta). Los dos juntos y en la misma migración a
-- propósito: si solo se redondeara el precio vigente, cada orden histórica
-- seguiría facturando centavos y el total de una orden dejaría de coincidir
-- con la suma de sus líneas mostradas.
--
-- CONSECUENCIA ASUMIDA, decidida explícitamente el 25/08/2026: redondear
-- `precioUnitario` REESCRIBE montos históricos. El snapshot existe justamente
-- para que un cambio de precio no toque una venta pasada, y esta migración es
-- la excepción deliberada a esa regla. No hay vuelta atrás: los centavos
-- originales no se conservan en ninguna parte.
--
-- El UPDATE explícito va ANTES del ALTER COLUMN aunque SQL Server ya redondea
-- al reducir la escala de un decimal. Dejar el redondeo implícito en la
-- conversión esconde en un cambio de tipo la operación que de verdad importa,
-- que es la que toca la plata.

UPDATE [dbo].[Product] SET [precio] = ROUND([precio], 0);
UPDATE [dbo].[ItemOrden] SET [precioUnitario] = ROUND([precioUnitario], 0);

-- Ninguna de las dos columnas participa de un índice ni de una constraint, así
-- que el ALTER COLUMN no necesita bajar y rehacer nada (a diferencia de
-- `20260823010000_itemorden_producto_nullable`, donde `productId` sí lo hacía).
ALTER TABLE [dbo].[Product] ALTER COLUMN [precio] DECIMAL(10, 0) NOT NULL;
ALTER TABLE [dbo].[ItemOrden] ALTER COLUMN [precioUnitario] DECIMAL(10, 0) NOT NULL;
