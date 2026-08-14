// Higgsfield Watch — OpenPets community plugin.
//
// Polls the Higgsfield jobs API and has the pet announce generation
// progress: a heads-up when new jobs start, a celebration when they finish,
// and a warning when they fail. State is diffed across polls so restarts
// never re-announce old generations.

const JOBS_URL = "https://fnf.higgsfield.ai/agents/jobs?size=20";
const STATE_KEY = "hf-jobs";
const POLL_ID = "hf-poll";
const DEFAULT_POLL_SECONDS = 30;
const MIN_POLL_SECONDS = 10;
const MAX_TEXT = 140;

const PENDING_STATUSES = new Set(["queued", "pending", "processing", "in_progress", "running", "created", "started"]);
const DONE_STATUSES = new Set(["completed", "succeeded", "success", "done", "finished"]);
const FAILED_STATUSES = new Set(["failed", "error", "canceled", "cancelled", "nsfw", "moderated", "rejected", "timeout"]);

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".ogg"]);

const STRIP_PATTERN = /```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b|https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\|api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY/gi;

let pollRunning = false;

function safeText(value, fallback = "") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const msg = value.trim().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
  const capped = msg.length > MAX_TEXT ? msg.slice(0, MAX_TEXT).trim() : msg;
  if (!capped || STRIP_PATTERN.test(capped)) return fallback;
  return capped;
}

function classify(status) {
  if (DONE_STATUSES.has(status)) return "done";
  if (FAILED_STATUSES.has(status)) return "failed";
  if (PENDING_STATUSES.has(status)) return "pending";
  return "unknown";
}

function mediaKind(resultUrl) {
  if (typeof resultUrl !== "string") return "generation";
  const path = resultUrl.split("?", 1)[0];
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "generation";
  const ext = path.slice(dot).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "image";
}

async function fetchJobs(ctx) {
  const config = await ctx.config.get();
  const token = String(config.apiToken || "").trim();
  if (!token) throw new Error("NO_TOKEN");
  const res = await ctx.net.fetch(JOBS_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) throw new Error("BAD_TOKEN");
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const data = res.json;
  return Array.isArray(data) ? data : [];
}

async function checkNow(ctx, manual) {
  if (pollRunning) return;
  pollRunning = true;
  try {
    let jobs;
    try {
      jobs = await fetchJobs(ctx);
    } catch (e) {
      if (e.message === "NO_TOKEN") {
        await ctx.status.set({ text: "Higgsfield: token needed (see plugin settings)", tone: "warning" });
        if (manual) await ctx.pet.speak("Add your Higgsfield token in my settings first!");
        return;
      }
      if (e.message === "BAD_TOKEN") {
        await ctx.status.set({ text: "Higgsfield: token expired — refresh it in settings", tone: "warning" });
        if (manual) await ctx.pet.speak("My Higgsfield token expired, please refresh it.");
        return;
      }
      await ctx.status.set({ text: "Higgsfield: unreachable, retrying", tone: "warning" });
      ctx.log?.warn?.("Higgsfield poll failed", e?.message);
      return;
    }

    const previous = await ctx.storage.get(STATE_KEY);
    const seeded = previous !== null && previous !== undefined;
    const known = seeded ? { ...previous } : {};
    const seen = new Set();
    let newPending = 0;
    let pendingCount = 0;
    const completions = [];
    const failures = [];

    for (const raw of jobs) {
      const jobId = typeof raw?.id === "string" ? raw.id : null;
      const status = String(raw?.status || "").toLowerCase();
      if (!jobId || !status) continue;
      seen.add(jobId);
      const phase = classify(status);
      if (phase === "pending") pendingCount++;
      const label = safeText(String(raw?.display_name || ""), "Higgsfield");
      const prev = known[jobId];

      if (prev === undefined) {
        known[jobId] = phase;
        if (seeded && phase === "pending") newPending++;
        else if (seeded && phase === "done") completions.push({ label, kind: mediaKind(raw?.result_url) });
        continue;
      }
      if (prev === phase) continue;
      known[jobId] = phase;
      if (prev === "pending" && phase === "done") completions.push({ label, kind: mediaKind(raw?.result_url) });
      else if (prev === "pending" && phase === "failed") failures.push(label);
    }

    for (const jobId of Object.keys(known)) {
      if (!seen.has(jobId) && known[jobId] !== "pending") delete known[jobId];
    }
    await ctx.storage.set(STATE_KEY, known);

    if (seeded) {
      if (completions.length > 0) {
        const last = completions[completions.length - 1];
        const extra = completions.length > 1 ? ` (+${completions.length - 1} more)` : "";
        await ctx.pet.speak(safeText(`Your ${last.label} ${last.kind} is ready!${extra}`, "Your generation is ready!"));
        await ctx.pet.react("celebrating");
      } else if (failures.length > 0) {
        await ctx.pet.speak(safeText(`Oh no, a ${failures[0]} generation failed.`, "Oh no, a generation failed."));
        await ctx.pet.react("error");
      } else if (newPending > 0) {
        const config = await ctx.config.get();
        if (config.announceStarts !== false) {
          const plural = newPending > 1 ? "s" : "";
          await ctx.pet.speak(`Tracking ${newPending} new Higgsfield generation${plural}, stay tuned!`);
          await ctx.pet.react("working");
        }
      }
    }

    const suffix = pendingCount > 0 ? ` · ${pendingCount} in progress` : "";
    await ctx.status.set({ text: `Higgsfield: watching${suffix}`, tone: pendingCount > 0 ? "info" : "success" });
    if (manual && completions.length === 0 && failures.length === 0 && newPending === 0) {
      await ctx.pet.speak(pendingCount > 0 ? `Still working on ${pendingCount} generation${pendingCount > 1 ? "s" : ""}!` : "No new Higgsfield activity right now.");
    }
  } finally {
    pollRunning = false;
  }
}

async function scheduleNext(ctx) {
  const config = await ctx.config.get();
  const interval = Math.max(MIN_POLL_SECONDS, Number(config.pollIntervalSeconds || DEFAULT_POLL_SECONDS));
  await ctx.schedule.cancel(POLL_ID);
  await ctx.schedule.once(POLL_ID, interval * 1000, async () => {
    try {
      await checkNow(ctx, false);
    } finally {
      await scheduleNext(ctx);
    }
  });
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await ctx.commands.register(
        { id: "hf-check-now", title: "Check Higgsfield Now", description: "Poll your Higgsfield generations right now." },
        async () => { await checkNow(ctx, true); }
      );
      await ctx.commands.register(
        { id: "hf-reset-state", title: "Reset Higgsfield Watch", description: "Forget tracked generations and re-seed from the current list." },
        async () => {
          await ctx.storage.set(STATE_KEY, null);
          await ctx.pet.speak("Higgsfield Watch reset - re-seeding.");
          await checkNow(ctx, false);
        }
      );
      // Seed deterministically before the poll loop starts so the two can
      // never overlap (checkNow skips itself while a poll is in flight).
      await checkNow(ctx, false).catch((e) => ctx.log?.warn?.("Initial Higgsfield check failed", e?.message));
      await scheduleNext(ctx);
    },

    async stop() {},
  });
}

if (typeof globalThis.OpenPetsPlugin !== "undefined") register(globalThis.OpenPetsPlugin);
