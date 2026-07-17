import assert from "node:assert/strict";

import { maxVoiceAudioBytes, readBoundedAudioResponse, sanitizeProviderError } from "../src/voice-provider.js";

const audio = await readBoundedAudioResponse(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
assert.equal(audio.mimeType, "audio/mpeg");
assert.deepEqual([...audio.bytes], [1, 2, 3]);

await assert.rejects(
  () => readBoundedAudioResponse(new Response("not audio", { headers: { "content-type": "text/plain" } })),
  /non-audio/,
);
await assert.rejects(
  () => readBoundedAudioResponse(new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg", "content-length": String(maxVoiceAudioBytes + 1) } })),
  /too large/,
);

const sanitized = sanitizeProviderError(new Error("failed https://voice.example.test/path secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
assert.equal(sanitized.includes("voice.example.test"), false);
assert.equal(sanitized.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);

console.log("bounded provider response behavior verified");
