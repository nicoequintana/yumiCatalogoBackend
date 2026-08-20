/**
 * One-time OAuth 2.0 consent script (design.md, "OAuth Setup" section, D9).
 *
 * Google Drive's storage-quota rules block bare service accounts from
 * uploading to a regular (non-Shared-Drive) "My Drive" folder on a consumer
 * Gmail account (confirmed via a live 403 in PR 2). The fix is to
 * authenticate as the client's own Gmail user via OAuth 2.0 Authorization
 * Code flow instead, so uploaded files are owned by, and billed against,
 * that user's normal Drive quota.
 *
 * This script performs the ONE-TIME interactive consent needed to obtain a
 * long-lived `refresh_token`:
 *
 *   1. Builds an OAuth2Client from GOOGLE_OAUTH_CLIENT_ID / _CLIENT_SECRET
 *      (must already be set in backend/.env — see Part A of the design's
 *      "OAuth Setup" section for how to create the Desktop app OAuth client
 *      in Google Cloud Console).
 *   2. Generates a consent URL with `access_type: "offline"` (required to
 *      receive a refresh_token at all) and `prompt: "consent"` (required so
 *      Google issues a NEW refresh_token even if this app was already
 *      authorized before — Google omits it on repeat grants otherwise).
 *   3. Starts a tiny local HTTP server on the loopback redirect URI
 *      (http://localhost:3456/oauth2callback) and opens the consent URL in
 *      the default browser.
 *   4. Google redirects back to that loopback URI with a `code` query
 *      param once the user approves access.
 *   5. Exchanges the code for tokens via oAuth2Client.getToken(code).
 *   6. Prints the resulting refresh_token to the console for the user to
 *      copy into backend/.env as GOOGLE_OAUTH_REFRESH_TOKEN=... themselves.
 *      This script deliberately does NOT write to .env automatically.
 *
 * The redirect URI below (http://localhost:3456/oauth2callback) MUST match
 * exactly what's registered on the Desktop app OAuth client in Google Cloud
 * Console. Desktop app clients accept any loopback port at runtime without
 * pre-registration, but keep this constant in sync with what you tell
 * reviewers/teammates to expect.
 *
 * Usage (from backend/):
 *   node --require dotenv/config src/scripts/oauth-get-refresh-token.js
 * (`node --env-file=.env` is confirmed broken in this environment — use the
 * dotenv/config require flag above instead, same as the other scripts.)
 */
import http from "node:http";
import { URL } from "node:url";
// Se toma de `googleapis` y no de `google-auth-library` a propósito: es la
// MISMA clase (googleapis reexporta google-auth-library), pero `googleapis`
// sí está declarada en package.json. Importarla directo funcionaba solo por
// hoisting de node_modules — una dependencia fantasma que rompe apenas el
// árbol de instalación cambia. `googleDrive.service.js` ya la usa así.
import { google } from "googleapis";

const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} no está configurada en el entorno. Configurá backend/.env antes de correr este script.`,
    );
  }
  return value;
}

/**
 * Best-effort browser launch using the OS's native "open URL" command.
 * No extra npm dependency (design.md explicitly calls out "no new npm
 * dependency" for this script) — falls back silently to manual copy/paste
 * if the platform command isn't available or fails.
 */
async function openInBrowser(url) {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // cmd.exe's `start` treats `&` as a command separator, which truncates
      // OAuth URLs (they're full of `&`-joined query params) unless the URL
      // is escaped with `^&` for the shell. Using `/c start "" "url"` alone
      // is NOT enough — cmd still parses `&` inside the quoted arg on some
      // Windows builds, so escape explicitly rather than relying on quoting.
      const escapedUrl = url.replace(/&/g, "^&");
      spawn("cmd", ["/c", "start", "", escapedUrl], { stdio: "ignore", detached: true, shell: false }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForAuthorizationCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, REDIRECT_URI);
      if (requestUrl.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<h1>Autorización rechazada</h1><p>Google devolvió el error: ${error}. Podés cerrar esta pestaña.</p>`,
        );
        server.close();
        reject(new Error(`OAuth consent denied or failed: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h1>Falta el parámetro code</h1><p>Podés cerrar esta pestaña y volver a intentarlo.</p>",
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h1>Listo</h1><p>Autorización recibida correctamente. Podés cerrar esta pestaña y volver a la terminal.</p>",
      );
      server.close();
      resolve(code);
    });

    server.on("error", reject);
    server.listen(PORT, () => {
      console.log(`Servidor local escuchando en ${REDIRECT_URI} ...`);
    });
  });
}

async function main() {
  console.log("== Google Drive OAuth: obtención de refresh_token (una sola vez) ==\n");

  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  console.log("Abrí esta URL en el navegador (o se abrirá automáticamente):\n");
  console.log(authUrl);
  console.log(
    "\nVas a ver una advertencia de 'app no verificada' — es esperado (D9 en el diseño). " +
      "Hacé click en 'Avanzado' -> 'Ir a [nombre de la app] (no seguro)' y aprobá el acceso " +
      "con la cuenta de Gmail cuyo Drive va a recibir los archivos subidos.\n",
  );

  const openedAutomatically = await openInBrowser(authUrl);
  if (!openedAutomatically) {
    console.log(
      "(No se pudo abrir el navegador automáticamente — copiá y pegá la URL de arriba manualmente.)\n",
    );
  }

  const code = await waitForAuthorizationCode();

  console.log("\nCódigo de autorización recibido. Intercambiando por tokens...");
  const { tokens } = await oAuth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.error(
      "\nERROR: Google no devolvió un refresh_token. Esto suele pasar si la app ya fue " +
        "autorizada antes SIN 'prompt=consent', o si el usuario revocó y falta re-otorgar " +
        "consentimiento completo. Este script ya pide prompt=consent, así que reintentá; " +
        "si persiste, revocá el acceso en https://myaccount.google.com/permissions y volvé a correr el script.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n=== REFRESH TOKEN OBTENIDO ===");
  console.log(
    "Copiá el siguiente valor en backend/.env como GOOGLE_OAUTH_REFRESH_TOKEN (sin comillas extra):\n",
  );
  console.log(tokens.refresh_token);
  console.log("\n===============================");
  console.log(
    "\nEste script no escribe backend/.env automáticamente — pegalo ahí manualmente y guardá el archivo.",
  );
}

main().catch((err) => {
  console.error("\nFALLÓ EL SCRIPT DE CONSENTIMIENTO OAUTH:", err);
  process.exitCode = 1;
});
