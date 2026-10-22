import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readJson(name: string): any {
	return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
}

test("host-provided imports are optional peers, not bundled runtime dependencies", () => {
	const manifest = readJson("package.json");
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(manifest.dependencies?.[name], undefined, `${name} must come from Pi`);
		assert.equal(manifest.peerDependencies[name], "*");
		assert.equal(manifest.peerDependenciesMeta[name].optional, true);
	}
});

test("lockfile root matches package dependency declarations", () => {
	const manifest = readJson("package.json");
	const lock = readJson("package-lock.json");
	for (const key of ["dependencies", "devDependencies", "peerDependencies", "peerDependenciesMeta"]) {
		assert.deepEqual(lock.packages[""][key], manifest[key], key);
	}
});

test("development toolchain targets the current Pi 1.4.0 baseline", () => {
	const manifest = readJson("package.json");
	const lock = readJson("package-lock.json");
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert.match(manifest.devDependencies[name], /^\^?1\.4\.0$/, `${name} development floor`);
		assert.equal(lock.packages[`node_modules/${name}`].version, "1.4.0", `${name} locked version`);
	}
});

test("development typebox matches the copy Pi 1.4.0 ships", () => {
	const lock = readJson("package-lock.json");
	const pi = lock.packages["node_modules/@earendil-works/pi-coding-agent"];
	const piTypeboxSpec: string = pi.dependencies.typebox;
	const devTypebox = lock.packages["node_modules/typebox"].version;
	assert.ok(
		piTypeboxSpec.replace(/^[\^~]/, "") === devTypebox,
		`development typebox ${devTypebox} must match Pi's ${piTypeboxSpec}`,
	);
});

test("package engine floor follows Pi's supported Node version", () => {
	const manifest = readJson("package.json");
	assert.equal(manifest.engines.node, ">=22.19.0");
});

test("published package ships sources, docs and license only", () => {
	const manifest = readJson("package.json");
	assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
	assert.ok(manifest.files.includes("src/**/*.ts"));
	assert.ok(manifest.files.includes("README.md"));
	assert.ok(manifest.files.includes("LICENSE"));
	assert.equal(manifest.scripts.check, "npm run typecheck && npm test");
});
