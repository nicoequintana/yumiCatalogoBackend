-- ItemOrden.productId pasa a nullable con ON DELETE SET NULL.
--
-- Antes era NOT NULL con NO ACTION, y eso volvía imborrable a cualquier
-- producto que apareciera en una orden — incluidas las CANCELADAS, que el
-- propio proyecto no cuenta como ventas (ver ESTADOS_FACTURABLES).
--
-- La orden no pierde nada legible: `nombreProducto` y `precioUnitario` son
-- snapshots y existen exactamente para que la línea sobreviva sin el producto.
-- Lo que sí se pierde es el vínculo, así que el ranking de ventas agrupa por
-- el snapshot cuando no hay id (ver admin.controller.js).

-- El índice sobre la columna bloquea el ALTER COLUMN: se baja y se rehace.
DROP INDEX [ItemOrden_productId_idx] ON [dbo].[ItemOrden];

-- La FK también bloquea el ALTER COLUMN, y además hay que recrearla con la
-- acción de borrado nueva: SQL Server no permite modificarla en el lugar.
ALTER TABLE [dbo].[ItemOrden] DROP CONSTRAINT [ItemOrden_productId_fkey];

ALTER TABLE [dbo].[ItemOrden] ALTER COLUMN [productId] INT NULL;

ALTER TABLE [dbo].[ItemOrden]
  ADD CONSTRAINT [ItemOrden_productId_fkey]
  FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id])
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE NONCLUSTERED INDEX [ItemOrden_productId_idx] ON [dbo].[ItemOrden]([productId]);
