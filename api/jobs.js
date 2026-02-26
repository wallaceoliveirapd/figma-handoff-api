const crypto = require("crypto");
const { z } = require("zod");

// ⚠️ Em Vercel serverless, memória pode resetar.
// MVP ok; depois a gente migra pra KV/Redis.
const globalStore = globalThis.__HANDOFF_STORE__ || new Map();
globalThis.__HANDOFF_STORE__ = globalStore;

const AnnotationPlanSchema = z.object({
  version: z.string().default("1.0"),
  figma: z.object({
    fileKey: z.string().min(3),
    pageName: z.string().min(1),
    mode: z.object({
      devAnnotations: z.boolean().default(true),
      canvasCards: z.boolean().default(true),
    }).default({ devAnnotations: true, canvasCards: true }),
  }),
  targets: z.array(
    z.object({
      nodeId: z.string().min(3),
      nodeType: z.string().optional(),
      title: z.string().min(1),
      notes: z.array(
        z.object({
          category: z.string().min(1),
          title: z.string().min(1),
          bodyMd: z.string().min(1),
          priority: z.enum(["low", "medium", "high"]).optional(),
          pinProperties: z.array(z.string()).optional(),
        })
      ).min(1),
      placement: z.object({
        side: z.enum(["right", "left", "top", "bottom"]).default("right"),
        offset: z.number().default(80),
        stack: z.enum(["avoid-overlap", "none"]).default("avoid-overlap"),
      }).default({ side: "right", offset: 80, stack: "avoid-overlap" }),
    })
  ).min(1),
  sources: z.record(z.string()).optional(),
  meta: z.record(z.any()).optional(),
});

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(body));
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.end();
  }

  const TOQAN_BEARER = process.env.TOQAN_BEARER || "";

  // Roteamento simples por query param:
  // POST /api/jobs              -> create
  // GET  /api/jobs?jobId=...    -> fetch (needs token)
  // POST /api/jobs?jobId=...&action=ack -> ack (needs token)
  const { jobId, action, token } = req.query || {};

  // CREATE JOB (Toqan)
  if (req.method === "POST" && !jobId) {
    // Protege criação: só Toqan
    const auth = req.headers.authorization || "";
    if (!TOQAN_BEARER || auth !== `Bearer ${TOQAN_BEARER}`) {
      return json(res, 401, { error: "UNAUTHORIZED_TOQAN" });
    }

    let body = req.body;
    // Vercel geralmente já parseia JSON; mas se vier string:
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch {}
    }

    const parsed = AnnotationPlanSchema.safeParse(body);
    if (!parsed.success) {
      return json(res, 400, { error: "INVALID_PLAN", details: parsed.error.flatten() });
    }

    const newJobId = makeId("job");
    const readToken = makeId("rt");

    globalStore.set(newJobId, {
      jobId: newJobId,
      readToken,
      status: "queued",
      createdAt: new Date().toISOString(),
      appliedAt: null,
      plan: parsed.data,
    });

    return json(res, 200, { jobId: newJobId, readToken, status: "queued" });
  }

  // FETCH JOB (Plugin)
  if (req.method === "GET" && jobId) {
    const job = globalStore.get(jobId);
    if (!job) return json(res, 404, { error: "NOT_FOUND" });

    if (!token || token !== job.readToken) {
      return json(res, 401, { error: "UNAUTHORIZED" });
    }

    return json(res, 200, {
      jobId: job.jobId,
      status: job.status,
      createdAt: job.createdAt,
      appliedAt: job.appliedAt,
      plan: job.plan,
    });
  }

  // ACK JOB (Plugin)
  if (req.method === "POST" && jobId && action === "ack") {
    const job = globalStore.get(jobId);
    if (!job) return json(res, 404, { error: "NOT_FOUND" });

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch {}
    }

    const bodyToken = body?.token;
    if (!bodyToken || bodyToken !== job.readToken) {
      return json(res, 401, { error: "UNAUTHORIZED" });
    }

    job.status = "applied";
    job.appliedAt = new Date().toISOString();
    globalStore.set(jobId, job);

    return json(res, 200, { jobId, status: job.status, appliedAt: job.appliedAt });
  }

  return json(res, 404, { error: "ROUTE_NOT_FOUND" });
};