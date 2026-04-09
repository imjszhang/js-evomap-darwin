import { computeAssetId } from "./utils/hash.js";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 90_000;
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Standalone LLM-based Capsule generator.
 * Calls the Anthropic Messages API directly via native fetch — no npm dependencies.
 *
 * Environment variables:
 *   DARWIN_LLM_API_KEY   — Anthropic API key (required)
 *   DARWIN_LLM_MODEL     — model id (default: claude-sonnet-4-20250514)
 *   DARWIN_LLM_BASE_URL  — API base URL (default: https://api.anthropic.com)
 */
export class CapsuleGenerator {
  #apiKey;
  #model;
  #baseUrl;
  #timeoutMs;

  constructor({
    apiKey = process.env.DARWIN_LLM_API_KEY,
    model = process.env.DARWIN_LLM_MODEL || DEFAULT_MODEL,
    baseUrl = process.env.DARWIN_LLM_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.#apiKey = apiKey;
    this.#model = model;
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = timeoutMs;
  }

  get available() {
    return !!this.#apiKey;
  }

  /**
   * Generate a Capsule for the given Hub task.
   * @param {{ task_id?: string, title?: string, signals?: string, bounty_amount?: number|string }} task
   * @returns {Promise<object|null>} Normalized Capsule with computed asset_id, or null on failure.
   */
  async generateCapsule(task) {
    if (!this.#apiKey) return null;

    const prompt = buildCapsulePrompt(task);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const res = await fetch(`${this.#baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.#model,
          max_tokens: 2048,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
      }

      const json = await res.json();
      const text = json?.content?.[0]?.text ?? "";
      if (!text) return null;

      return parseCapsuleFromReply(text);
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`LLM request timed out after ${this.#timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Prompt / Parse / Normalize (extracted from openclaw-plugin) ──────────

function buildCapsulePrompt(task) {
  const title = (task.title || "").slice(0, 200);
  const signals = (task.signals || "").split(",").map((s) => s.trim()).filter(Boolean);
  const bounty = task.bounty_amount ?? "unknown";

  return `You are an EvoMap protocol expert. Generate a high-quality Capsule asset for the following task.

Task title: ${title}
Task signals: ${signals.join(", ")}
Bounty: ${bounty}

Requirements:
1. The Capsule must contain a genuine, substantive solution — not generic placeholder text.
2. The "content" field must be a detailed, actionable approach to the task (at least 200 characters).
3. The "strategy" field must be an array of 3-7 concrete step descriptions.
4. The "trigger" field must contain normalized, lowercase, deduplicated signal keywords.
5. Follow the EvoMap Capsule schema exactly.

Return ONLY a JSON code block with the Capsule object. No other text before or after.

\`\`\`json
{
  "type": "Capsule",
  "schema_version": "1.5.0",
  "trigger": ["signal1", "signal2"],
  "summary": "Concise summary of the solution approach",
  "content": "Detailed multi-paragraph solution text...",
  "strategy": [
    "Step 1: ...",
    "Step 2: ...",
    "Step 3: ..."
  ],
  "confidence": 0.75,
  "blast_radius": { "files": 1, "lines": 30 },
  "outcome": { "status": "success", "score": 0.75 },
  "env_fingerprint": { "platform": "any", "arch": "any" }
}
\`\`\`

Generate the Capsule now for the task above. The content must directly address "${title}".`;
}

function normalizeCapsuleObject(obj) {
  try {
    if (!obj || typeof obj !== "object") return null;
    if (obj.type !== "Capsule" || !obj.trigger || !obj.content) return null;
    if (!Array.isArray(obj.trigger)) obj.trigger = [String(obj.trigger)];
    obj.trigger = [...new Set(obj.trigger.map((s) => s.trim().toLowerCase()).filter(Boolean))];
    if (!obj.schema_version) obj.schema_version = "1.5.0";
    if (!obj.summary) obj.summary = obj.content.slice(0, 120);
    if (!Array.isArray(obj.strategy) || obj.strategy.length < 2) {
      obj.strategy = [
        "Decompose problem into measurable sub-objectives with validation checkpoints",
        "Apply A/B comparison against baseline to verify genuine improvement",
      ];
    }
    if (typeof obj.confidence !== "number") obj.confidence = 0.72;
    if (!obj.blast_radius) obj.blast_radius = { files: 1, lines: 20 };
    if (!obj.outcome) obj.outcome = { status: "success", score: obj.confidence };
    if (!obj.env_fingerprint) obj.env_fingerprint = { platform: "any", arch: "any" };

    delete obj.asset_id;
    obj.asset_id = computeAssetId(obj);
    return obj;
  } catch {
    return null;
  }
}

function parseCapsuleFromReply(text) {
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const raw = jsonMatch ? jsonMatch[1].trim() : text.trim();
  try {
    const obj = JSON.parse(raw);
    return normalizeCapsuleObject(obj);
  } catch {
    return null;
  }
}

export { buildCapsulePrompt, parseCapsuleFromReply, normalizeCapsuleObject };
