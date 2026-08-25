import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadProjectSnapshot,
	resetProjectSnapshotPersistWorkerForTests,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import {
	buildWordIndex,
	flushWordIndexPersistsForTests,
	getWordIndexSerializeCountForTests,
	resetWordIndexSerializeCountForTests,
	scheduleWordIndexPersist,
	serializeWordIndex,
	updateWordIndexDocument,
} from "../../clients/word-index.js";
import { deserializeWordIndex } from "../../clients/word-index.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("word-index persist serialization", () => {
	afterEach(() => {
		delete process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS;
		delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
		resetWordIndexSerializeCountForTests();
		resetProjectSnapshotPersistWorkerForTests();
	});

	it("does not iterate postings on the persist caller and remains byte-stable", async () => {
		const env = setupTestEnvironment("word-index-persist-");
		const cwd = path.join(env.tmpDir, "project");
		try {
			process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS = "0";
			const index = buildWordIndex([
				{ path: path.join(cwd, "a.ts"), content: "alpha beta\n" },
				{ path: path.join(cwd, "b.ts"), content: "beta gamma\n" },
			]);
			resetWordIndexSerializeCountForTests();
			scheduleWordIndexPersist(cwd, index);
			flushWordIndexPersistsForTests();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(getWordIndexSerializeCountForTests()).toBe(0);
			await waitForProjectSnapshotPersistsForTests();
			const saved = loadProjectSnapshot(cwd);
			const first = saved?.wordIndex;
			const loaded = deserializeWordIndex(first);
			expect(loaded).not.toBeNull();
			expect(serializeWordIndex(loaded!)).toEqual(first);
		} finally {
			env.cleanup();
		}
	});

	it("captures the index before a concurrent edit mutates it", async () => {
		const env = setupTestEnvironment("word-index-persist-race-");
		const cwd = path.join(env.tmpDir, "project");
		try {
			process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS = "0";
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "100";
			const filePath = path.join(cwd, "a.ts");
			const index = buildWordIndex([
				{ path: filePath, content: "alpha beta\n" },
			]);
			scheduleWordIndexPersist(cwd, index);
			flushWordIndexPersistsForTests();
			await new Promise((resolve) => setTimeout(resolve, 50));
			updateWordIndexDocument(index, {
				path: filePath,
				content: "alpha delta\n",
			});
			await waitForProjectSnapshotPersistsForTests();
			const saved = deserializeWordIndex(loadProjectSnapshot(cwd)?.wordIndex);
			expect(saved?.postings.get("beta")).toHaveLength(1);
			expect(saved?.postings.get("delta")).toBeUndefined();
		} finally {
			delete process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
			env.cleanup();
		}
	});
});
