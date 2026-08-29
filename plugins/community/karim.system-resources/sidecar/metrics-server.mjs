import http from "node:http";
import { collectMetrics, METRICS_PORT } from "./collect.mjs";

const host = "127.0.0.1";
const port = Number(process.env.OPENPETS_METRICS_PORT || METRICS_PORT);
const CACHE_TTL_MS = 4_000;
const cache = new Map();

async function metricsFor(platform) {
  const key = String(platform || "auto");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.metrics;
  const metrics = await collectMetrics({ platform: key });
  cache.set(key, { at: Date.now(), metrics });
  return metrics;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  if (req.method !== "GET") {
    res.writeHead(405);
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname !== "/metrics") {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  try {
    const platform = url.searchParams.get("platform") || process.env.OPENPETS_METRICS_PLATFORM || "auto";
    const metrics = await metricsFor(platform);
    res.writeHead(200);
    res.end(JSON.stringify(metrics));
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "collect failed" }));
  }
});

server.listen(port, host, () => {
  process.stdout.write(`openpets-metrics listening on http://${host}:${port}\n`);
  void metricsFor("auto");
});
