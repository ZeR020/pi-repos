import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("host-provided imports are optional peers, not bundled runtime dependencies", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(manifest.dependencies?.[name], undefined, `${name} must come from Pi`);
		assert.equal(manifest.peerDependencies[name], "*");
		assert.equal(manifest.peerDependenciesMeta[name].optional, true);
	}
});

test("lockfile root matches package dependency declarations", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
	for (const key of ["dependencies", "devDependencies", "peerDependencies", "peerDependenciesMeta"]) {
		assert.deepEqual(lock.packages[""][key], manifest[key], key);
	}
});
