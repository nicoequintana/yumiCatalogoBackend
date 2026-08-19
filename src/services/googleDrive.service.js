import { Readable } from "node:stream";
import { google } from "googleapis";

let driveClient = null;

/**
 * Lazily builds and caches an authenticated Drive client using OAuth 2.0
 * user delegation (design.md D9 / REVISION 2) — NOT a service account.
 *
 * Bare service accounts have no storage quota on a regular "My Drive"
 * folder on a consumer Gmail account (confirmed via a live 403 from the
 * Drive API in PR 2: "Service Accounts do not have storage quota..."), so
 * this authenticates as the client's own Gmail user instead, via a stored
 * refresh_token obtained once through src/scripts/oauth-get-refresh-token.js.
 * Uploaded files are then owned by, and billed against, that user's normal
 * Drive quota. Scope is drive.file (least privilege — only files this app
 * creates, not the whole Drive).
 */
function getDriveClient() {
  if (driveClient) return driveClient;

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET y GOOGLE_OAUTH_REFRESH_TOKEN deben estar configuradas en el entorno. " +
        "Si falta GOOGLE_OAUTH_REFRESH_TOKEN, corré: node --require dotenv/config src/scripts/oauth-get-refresh-token.js",
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

/**
 * Uploads a file to the configured Drive folder.
 *
 * @param {Buffer} buffer - raw file bytes
 * @param {string} mimeType
 * @param {string} nombre - file name to store in Drive
 * @param {{ makePublic?: boolean, parents?: string[] }} [opciones] - when
 *   makePublic is true (photos), grants "anyone with link -> reader" and
 *   returns a direct viewable URL. Videos must NOT be made public (design
 *   D1/D2) — omit or set makePublic:false, obtenerStreamVideo reads them via
 *   the service account instead. `parents` targets a specific folder (e.g. a
 *   per-product subfolder); defaults to GOOGLE_DRIVE_FOLDER_ID when omitted.
 * @returns {Promise<{ driveFileId: string, url: string }>}
 */
export async function subirArchivo(buffer, mimeType, nombre, opciones = {}) {
  const { makePublic = false, parents } = opciones;
  const drive = getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    throw new Error("GOOGLE_DRIVE_FOLDER_ID no está configurada en el entorno.");
  }

  const { data } = await drive.files.create({
    requestBody: {
      name: nombre,
      parents: parents ?? [folderId],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: "id",
  });

  const driveFileId = data.id;

  let url = `https://drive.google.com/uc?export=view&id=${driveFileId}`;

  if (makePublic) {
    await drive.permissions.create({
      fileId: driveFileId,
      requestBody: { role: "reader", type: "anyone" },
    });
  }

  return { driveFileId, url };
}

/**
 * Creates a Drive folder under the given parent. Used to give each product
 * its own subfolder (design item 1) instead of dumping all media into the
 * flat GOOGLE_DRIVE_FOLDER_ID root.
 *
 * @param {string} nombre - folder display name, e.g. "42-collar-de-perlas"
 * @param {string} parentFolderId
 * @returns {Promise<{ driveFolderId: string }>}
 */
export async function crearCarpeta(nombre, parentFolderId) {
  const drive = getDriveClient();

  const { data } = await drive.files.create({
    requestBody: {
      name: nombre,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
  });

  return { driveFolderId: data.id };
}

/**
 * Deletes a file from Drive by id. Swallows 404 (already-gone files are not
 * an error for cleanup purposes).
 *
 * @param {string} driveFileId
 * @returns {Promise<void>}
 */
export async function eliminarArchivo(driveFileId) {
  const drive = getDriveClient();
  try {
    await drive.files.delete({ fileId: driveFileId });
  } catch (err) {
    const status = err?.code ?? err?.response?.status;
    if (status === 404) return;
    throw err;
  }
}

/**
 * Reads a file's media bytes from Drive, forwarding an optional incoming
 * Range header to Drive's alt=media endpoint so the caller (video proxy
 * route, PR 4) can pass through partial-content responses.
 *
 * @param {string} driveFileId
 * @param {string | undefined} rangeHeader - e.g. "bytes=0-1023"
 * @returns {Promise<{ stream: NodeJS.ReadableStream, status: number, headers: Record<string, string> }>}
 */
export async function obtenerStreamVideo(driveFileId, rangeHeader) {
  const drive = getDriveClient();

  const response = await drive.files.get(
    { fileId: driveFileId, alt: "media" },
    {
      responseType: "stream",
      headers: rangeHeader ? { Range: rangeHeader } : {},
    },
  );

  return {
    stream: response.data,
    status: response.status,
    headers: response.headers,
  };
}

/**
 * Reads a file's media bytes from Drive with no Range support — used by the
 * photo proxy route (post-archive bugfix, see apply-progress topic
 * "sdd/backend-drive-sqlserver/photo-proxy-postfix").
 *
 * Photos are not seekable media like video, so there is no need to forward
 * a Range header or handle 206 Partial Content; this is a plain full-body
 * `alt=media` read. Kept as a separate function (rather than reusing
 * `obtenerStreamVideo` with `rangeHeader` omitted) because the two have
 * different contracts going forward — `obtenerStreamVideo`'s JSDoc and
 * call sites are specifically about Range passthrough, and conflating them
 * would make both harder to read. The underlying Drive call is identical.
 *
 * @param {string} driveFileId
 * @returns {Promise<{ stream: NodeJS.ReadableStream, status: number, headers: Record<string, string> }>}
 */
export async function obtenerStreamArchivo(driveFileId) {
  const drive = getDriveClient();

  const response = await drive.files.get(
    { fileId: driveFileId, alt: "media" },
    { responseType: "stream" },
  );

  return {
    stream: response.data,
    status: response.status,
    headers: response.headers,
  };
}
