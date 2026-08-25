import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetProjectSnapshotParseCacheForTests,
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
			expect(getWordIndexSerializeCountForTests()).toBe(0);
			await waitForProjectSnapshotPersistsForTests();
			const first = serializeWordIndex(index);
			const loaded = deserializeWordIndex(first);
			expect(loaded).not.toBeNull();
			expect(serializeWordIndex(loaded!)).toEqual(first);
		} finally {
			env.cleanup();
		}
	});
});
