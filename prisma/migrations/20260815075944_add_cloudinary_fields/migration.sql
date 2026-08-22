BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Foto] ADD [cloudinaryPublicId] NVARCHAR(1000),
[cloudinaryResourceType] NVARCHAR(1000);

-- AlterTable
ALTER TABLE [dbo].[Video] ADD [cloudinaryPublicId] NVARCHAR(1000),
[cloudinaryResourceType] NVARCHAR(1000);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
