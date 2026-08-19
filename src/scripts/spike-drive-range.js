/**
 * Manual verification spike (Phase 3, task 3.3 in tasks.md).
 *
 * Uploads a small real MP4 to the configured Google Drive folder, then makes
 * a real `drive.files.get({ alt: "media" }, { headers: { Range } })` call
 * against it to CONCRETELY determine whether Drive's alt=media endpoint
 * honors the Range header (206 Partial Content / Content-Range) or ignores
 * it and returns the full file (200).
 *
 * This gates PR 4's video streaming proxy design (D1/D3 in design.md):
 * if Range is honored, the proxy can pass through Range headers directly to
 * Drive as designed. If not, PR 4 needs a fallback (e.g. download-once +
 * self-implemented Range serving from a local/temp cache).
 *
 * Cleans up the uploaded test file from Drive afterward regardless of the
 * outcome, so no test debris is left in the client's real folder.
 *
 * Usage (from backend/): node --require dotenv/config src/scripts/spike-drive-range.js
 * (`node --env-file=.env` is confirmed broken in this environment — use the
 * dotenv/config require flag above instead.)
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import {
  subirArchivo,
  eliminarArchivo,
  obtenerStreamVideo,
} from "../services/googleDrive.service.js";

const TEST_VIDEO_PATH = new URL(
  "../../scripts-tmp-test-video.mp4",
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]):/, "$1:"); // normalize Windows path

function ensureTestVideo() {
  if (existsSync(TEST_VIDEO_PATH)) return readFileSync(TEST_VIDEO_PATH);

  // Fallback: generate the same minimal MP4-shaped buffer inline if the
  // throwaway fixture file isn't present (e.g. re-run in a fresh checkout).
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ]);
  const padding = Buffer.alloc(20000, 0xab);
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(padding.length + 8, 0);
  mdatHeader.write("mdat", 4, "ascii");
  const buf = Buffer.concat([ftyp, mdatHeader, padding]);
  writeFileSync(TEST_VIDEO_PATH, buf);
  return buf;
}

async function drainStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  console.log("== Drive Range-support spike ==");

  const buffer = ensureTestVideo();
  console.log(`Test video buffer: ${buffer.length} bytes`);

  console.log("\n[1/3] Uploading test video to configured Drive folder...");
  let driveFileId;
  let rangeResult;
  try {
    ({ driveFileId } = await subirArchivo(
      buffer,
      "video/mp4",
      `spike-range-test-${Date.now()}.mp4`,
      { makePublic: false },
    ));
    console.log(`Uploaded. driveFileId=${driveFileId}`);
    console.log('\n[2/3] Requesting bytes=0-1023 via files.get(alt:"media", headers:{Range})...');
    const { stream, status, headers } = await obtenerStreamVideo(
      driveFileId,
      "bytes=0-1023",
    );
    const body = await drainStream(stream);

    console.log(`Response status: ${status}`);
    // `headers` is a fetch-style `Headers` instance (gaxios), not a plain
    // object — JSON.stringify/bracket access print/return nothing because
    // Headers has no own enumerable properties. Use .get(name) instead.
    // (Resolved in PR 4 — see backend/src/controllers/products.controller.js.)
    console.log(`Response headers:`, [...headers.entries()]);
    console.log(`Body length received: ${body.length} bytes (requested 1024)`);

    const contentRange = headers.get("content-range");
    const contentLength = headers.get("content-length");
    const honoredRange =
      status === 206 || (!!contentRange && body.length <= 1024);

    rangeResult = {
      honoredRange,
      status,
      contentRange: contentRange ?? null,
      contentLength: contentLength ?? null,
      bodyLength: body.length,
    };

    console.log("\n=== CONCRETE FINDING ===");
    if (honoredRange) {
      console.log(
        "Drive's alt=media endpoint DOES honor the Range header via this client library:",
      );
      console.log(`  status=${status} (206 expected), content-range=${contentRange}, body=${body.length} bytes`);
    } else {
      console.log(
        "Drive's alt=media endpoint DID NOT honor the Range header — it returned the full file / status 200:",
      );
      console.log(`  status=${status}, content-range=${contentRange}, body=${body.length} bytes (full file is ${buffer.length} bytes)`);
    }
  } finally {
    if (driveFileId) {
      console.log("\n[3/3] Cleaning up: deleting test video from Drive...");
      await eliminarArchivo(driveFileId);
      console.log("Deleted from Drive.");
    } else {
      console.log(
        "\n[3/3] Upload never succeeded — nothing to delete from Drive.",
      );
    }

    if (existsSync(TEST_VIDEO_PATH)) {
      unlinkSync(TEST_VIDEO_PATH);
      console.log("Deleted local throwaway fixture.");
    }
  }

  console.log("\n== Spike complete ==");
  console.log(JSON.stringify(rangeResult, null, 2));
}

main().catch((err) => {
  console.error("\nSPIKE FAILED:", err);
  process.exitCode = 1;
});
