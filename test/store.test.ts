import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonFile } from "../src/store.ts";

async function makeCacheDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "pi-repos-store-"));
}

test("concurrent cache JSON writes all complete and leave valid JSON", async () => {
	const root = await makeCacheDir();
	const target = join(root, "race.json");

	const writes = await Promise.allSettled(Array.from({ length: 80 }, (_, index) => writeJsonFile(target, { index })));

	const failed = writes.filter(result => result.status === "rejected") as PromiseRejectedResult[];
	assert.deepEqual(failed.map(result => String(result.reason)), []);
	const written = JSON.parse(await readFile(target, "utf8")) as { index: number };
	assert.equal(Number.isInteger(written.index) && written.index >= 0 && written.index < 80, true);
	assert.deepEqual((await readdir(root)).sort(), ["race.json"]);
});

test("a failed cache write leaves no temporary file behind", async () => {
	const root = await makeCacheDir();
	const target = join(root, "blocked.json");
	await mkdir(target);

	await assert.rejects(writeJsonFile(target, { index: 1 }));

	assert.deepEqual((await readdir(root)).sort(), ["blocked.json"]);
});
