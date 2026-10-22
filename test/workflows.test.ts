import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

type Step = {
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	with?: Record<string, unknown>;
	"continue-on-error"?: unknown;
};

type Job = {
	needs?: string | string[];
	if?: string;
	permissions?: Record<string, string>;
	"timeout-minutes"?: number;
	strategy?: { matrix?: { node?: string[] } };
	steps: Step[];
};

type Workflow = {
	on: Record<string, unknown>;
	permissions?: Record<string, string>;
	jobs: Record<string, Job>;
};

const SHA_PINNED = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

function readWorkflow(name: string): Workflow {
	return parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")) as Workflow;
}

function commands(job: Job): string {
	return job.steps.map((step) => step.run ?? "").join("\n");
}

test("CI runs locked checks on Node 22 and 24 for pull requests and main", () => {
	const ci = readWorkflow("ci.yml");
	assert.deepEqual(ci.on.push, { branches: ["main"] });
	assert.equal(ci.on.pull_request, null);
	const job = ci.jobs.check;
	assert.deepEqual(job.strategy?.matrix?.node, ["22", "24"]);
	assert.ok(job["timeout-minutes"], "CI needs a timeout");
	const run = commands(job);
	for (const command of [
		"npm ci --ignore-scripts",
		"npm run check",
		"npm audit --audit-level=high",
		"scripts/check-pack-contents.mjs",
	]) {
		assert.ok(run.includes(command), command);
	}
});

test("release verification covers every Node leg and the packaged contents", () => {
	const release = readWorkflow("release.yml");
	assert.deepEqual(release.on.push, { tags: ["v*"] });
	const verify = release.jobs.verify;
	assert.deepEqual(verify.strategy?.matrix?.node, ["22", "24"], "release must verify Node 22 and 24");
	const run = commands(verify);
	for (const command of [
		"npm ci --ignore-scripts",
		"npm run check",
		"npm audit --audit-level=high",
		"scripts/check-pack-contents.mjs",
		"scripts/release-guards.mjs tag",
		"scripts/release-guards.mjs ancestry",
	]) {
		assert.ok(run.includes(command), command);
	}
});

test("publishing waits for every verify leg and uploads from one leg", () => {
	const release = readWorkflow("release.yml");
	const verify = release.jobs.verify;
	const publish = release.jobs.release;
	assert.equal(publish.needs, "verify", "release must need the whole verify matrix");
	assert.equal(publish.if, undefined, "release must rely on default success gating");
	assert.equal(publish.permissions?.contents, "write");

	const uploads = verify.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact"));
	assert.equal(uploads.length, 1, "verify must upload exactly one release artifact");
	assert.equal(uploads[0].if, "matrix.node == '24'", "only one matrix leg may upload");
	assert.equal(uploads[0].with?.name, "release-package");

	const downloads = publish.steps.filter((step) => step.uses?.startsWith("actions/download-artifact"));
	assert.equal(downloads.length, 1, "release must download the single artifact");
	assert.equal(downloads[0].with?.name, "release-package");

	for (const [name, job] of Object.entries(release.jobs)) {
		for (const step of job.steps) {
			assert.equal(step["continue-on-error"], undefined, `${name} may not continue on error`);
		}
	}
});

test("workflows keep least privilege, pinned actions and no untrusted interpolation", () => {
	for (const name of ["ci.yml", "release.yml"]) {
		const workflow = readWorkflow(name);
		assert.deepEqual(workflow.permissions, { contents: "read" }, `${name} default permissions`);
		const source = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
		assert.doesNotMatch(source, /pull_request_target/, name);
		for (const [jobName, job] of Object.entries(workflow.jobs)) {
			if (jobName !== "release") {
				assert.equal(job.permissions, undefined, `${name}:${jobName} inherits read`);
			}
			for (const step of job.steps) {
				if (step.uses) assert.match(step.uses, SHA_PINNED, `${name}:${jobName}`);
				if (step.run) {
					assert.doesNotMatch(step.run, /\$\{\{\s*github\.event\./, `${name}:${jobName}`);
				}
			}
		}
	}
});

test("release publishes nothing to npm and uses only the GitHub token", () => {
	const release = readWorkflow("release.yml");
	const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
	assert.doesNotMatch(source, /npm publish|NPM_TOKEN|NODE_AUTH_TOKEN/);
	assert.ok(commands(release.jobs.release).includes("gh release create"));
	assert.ok(source.includes("github.token"));
});

test("workflows guarantee GNU tar and ripgrep for real archive and grep coverage", () => {
	for (const name of ["ci.yml", "release.yml"]) {
		const workflow = readWorkflow(name);
		const run = Object.values(workflow.jobs).map(commands).join("\n");
		assert.ok(run.includes("GNU tar"), `${name} must require GNU tar`);
		assert.ok(run.includes("command -v rg"), `${name} must detect ripgrep`);
		assert.ok(run.includes("apt-get install -y --no-install-recommends ripgrep"), `${name} must provision ripgrep`);
		assert.ok(run.includes("rg --version"), `${name} must fail without ripgrep`);
	}
});
