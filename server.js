const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { z } = require("zod");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

/**
 * MVP in-memory storage.
 * Em produção a gente troca por Redis/DB.
 */
const jobs = new Map();

/**
 * Schema mínimo do AnnotationPlan (v1)
 * A gente vai evoluir depois.
 */
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

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function makeToken() {
  return crypto.randomBytes(18).toString("hex");
}

/**
 * POST /jobs
 * Body: AnnotationPlan
 * Response: { jobId, readToken, status }
 */
app.post("/jobs", (req, res) => {
  const parsed = AnnotationPlanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "INVALID_PLAN",
      details: parsed.error.flatten(),
    });
  }

  const jobId = makeId("job");
  const readToken = makeId("rt");

  const job = {
    jobId,
    readToken,
    status: "queued",
    createdAt: new Date().toISOString(),
    plan: parsed.data,
    appliedAt: null,
  };

  jobs.set(jobId, job);

  res.json({ jobId, readToken, status: job.status });
});

/**
 * GET /jobs/:jobId?token=...
 * Response: { jobId, status, plan }
 */
app.get("/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });

  const token = req.query.token;
  if (!token || token !== job.readToken) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  res.json({
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    appliedAt: job.appliedAt,
    plan: job.plan,
  });
});

/**
 * POST /jobs/:jobId/ack
 * Body: { token }
 */
app.post("/jobs/:jobId/ack", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });

  const token = req.body?.token;
  if (!token || token !== job.readToken) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  job.status = "applied";
  job.appliedAt = new Date().toISOString();
  jobs.set(job.jobId, job);

  res.json({ jobId: job.jobId, status: job.status, appliedAt: job.appliedAt });
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
  console.log(`Handoff API running on http://localhost:${PORT}`);
});