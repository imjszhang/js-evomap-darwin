import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildBundle } from "../src/bundle-builder.js";

test("buildBundle produces 3 assets", () => {
  const capsule = {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["test", "automation"],
    summary: "Test capsule",
    content: "Test content",
    strategy: ["Step 1", "Step 2"],
    confidence: 0.8,
    blast_radius: { files: 1, lines: 100 },
    outcome: { status: "success", score: 0.8 },
    env_fingerprint: { platform: "any", arch: "any" },
  };

  const [gene, capsuleOut, event] = buildBundle(capsule);

  assert.equal(gene.type, "Gene");
  assert.equal(capsuleOut.type, "Capsule");
  assert.equal(event.type, "EvolutionEvent");
  assert.equal(event.event_type, "capsule_created");
});

test("Gene does NOT include schema_version (Hub rejects it)", () => {
  const capsule = {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["test"],
    summary: "Test",
    content: "Content",
    strategy: ["A", "B"],
    confidence: 0.7,
    blast_radius: { files: 1, lines: 50 },
    outcome: { status: "success", score: 0.7 },
    env_fingerprint: { platform: "any", arch: "any" },
  };

  const [gene] = buildBundle(capsule);
  assert.equal("schema_version" in gene, false, "Gene must NOT have schema_version");
});

test("Gene has required fields", () => {
  const capsule = {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["test-signal"],
    summary: "Test summary for gene",
    content: "Content",
    strategy: ["A", "B"],
    confidence: 0.7,
    blast_radius: { files: 1, lines: 50 },
    outcome: { status: "success", score: 0.7 },
    env_fingerprint: { platform: "any", arch: "any" },
  };

  const [gene] = buildBundle(capsule);

  assert.ok(gene.asset_id?.startsWith("sha256:"), "Gene must have asset_id");
  assert.equal(gene.category, "optimize");
  assert.ok(Array.isArray(gene.signals_match));
  assert.ok(gene.summary.length > 0);
  assert.ok(Array.isArray(gene.strategy) && gene.strategy.length >= 2);
  assert.ok(Array.isArray(gene.validation) && gene.validation.length > 0);
});

test("Capsule includes gene cross-reference", () => {
  const capsule = {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["test"],
    summary: "Test",
    content: "Content",
    strategy: ["A", "B"],
    confidence: 0.7,
    blast_radius: { files: 1, lines: 50 },
    outcome: { status: "success", score: 0.7 },
    env_fingerprint: { platform: "any", arch: "any" },
  };

  const [gene, capsuleOut] = buildBundle(capsule);

  assert.equal(capsuleOut.gene, gene.asset_id, "Capsule must reference Gene asset_id");
  assert.ok(capsuleOut.asset_id?.startsWith("sha256:"), "Capsule must have asset_id");
});

test("Capsule asset_id includes gene field in hash", () => {
  // This was the bug that caused 7 failed publishes.
  // The Hub hashes the Capsule WITH the gene field (only strips asset_id).
  // Our computeAssetId must do the same.

  const capsule = {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["test"],
    summary: "Test",
    content: "Content",
    strategy: ["A", "B"],
    confidence: 0.7,
    blast_radius: { files: 1, lines: 50 },
    outcome: { status: "success", score: 0.7 },
    env_fingerprint: { platform: "any", arch: "any" },
  };

  const [gene, capsuleOut] = buildBundle(capsule);

  // Verify the capsule has the gene field
  assert.ok("gene" in capsuleOut, "Capsule must have gene field");

  // Verify asset_id starts with sha256:
  assert.ok(capsuleOut.asset_id.startsWith("sha256:"), "Capsule asset_id must be sha256");

  // The capsule's gene must match the gene's asset_id
  assert.equal(capsuleOut.gene, gene.asset_id);
});

test("EvolutionEvent has minimal Hub-accepted structure", () => {
  const capsule = {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["test"],
    summary: "Test summary for event",
    content: "Content",
    strategy: ["A", "B"],
    confidence: 0.7,
    blast_radius: { files: 1, lines: 50 },
    outcome: { status: "success", score: 0.7 },
    env_fingerprint: { platform: "any", arch: "any" },
  };

  const [, , event] = buildBundle(capsule);

  assert.ok(event.asset_id?.startsWith("sha256:"), "Event must have asset_id");
  assert.equal(event.event_type, "capsule_created");
  assert.ok(event.description?.includes("Test summary for event"));
});

test("buildBundle does not mutate input capsule", () => {
  const original = {
    type: "Capsule",
    schema_version: "1.5.0",
    trigger: ["test"],
    summary: "Original",
    content: "Original content",
    strategy: ["A", "B"],
    confidence: 0.7,
    blast_radius: { files: 1, lines: 50 },
    outcome: { status: "success", score: 0.7 },
    env_fingerprint: { platform: "any", arch: "any" },
  };

  const originalJson = JSON.stringify(original);

  buildBundle(original);

  assert.equal(JSON.stringify(original), originalJson, "Input must not be mutated");
  assert.equal("gene" in original, false, "Input must not have gene field added");
  assert.equal("asset_id" in original, false, "Input must not have asset_id field added");
});
