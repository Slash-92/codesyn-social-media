import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildBufferInput,
  buildJobs,
  decideAction,
  deriveEntryStatus,
  isManageableBufferStatus,
  parseNotionPage,
  requiresMediaCheck,
  shouldDeferCreation,
} from "./notion-sync.mjs";

function richText(content) {
  return { type: "rich_text", rich_text: content ? [{ plain_text: content }] : [] };
}

function pageFixture(overrides = {}) {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    url: "https://notion.so/test",
    properties: {
      Contenuto: { type: "title", title: [{ plain_text: "Contenuto test" }] },
      Brand: { type: "select", select: { name: "Codesyn" } },
      Stato: { type: "select", select: { name: "Approvato" } },
      "Pronto per pubblicazione": { type: "checkbox", checkbox: true },
      Formato: { type: "select", select: { name: "Carosello" } },
      Caption: richText("Caption"),
      "Data pubblicazione": { type: "date", date: { start: "2026-09-10T11:00:00+02:00" } },
      "Chiave automazione": richText("test-key"),
      "Buffer IDs": richText(""),
      "URL media pubblici": richText("https://example.com/01.png\nhttps://example.com/02.png"),
      Media: { type: "files", files: [] },
      ...overrides,
    },
  };
}

test("parsa la riga Notion e preserva l'ordine degli URL", () => {
  const page = parseNotionPage(pageFixture());
  assert.equal(page.title, "Contenuto test");
  assert.equal(page.key, "test-key");
  assert.deepEqual(page.publicUrls, ["https://example.com/01.png", "https://example.com/02.png"]);
});

test("un ID Buffer esistente forza la sola riconciliazione", () => {
  const parsed = parseNotionPage(pageFixture({ "Buffer IDs": richText("existing-buffer-id") }));
  assert.equal(decideAction(parsed), "reconcile");
});

test("un carosello produce una sola operazione con asset ordinati", () => {
  const jobs = buildJobs(parseNotionPage(pageFixture()));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, "post");
  assert.deepEqual(jobs[0].urls, ["https://example.com/01.png", "https://example.com/02.png"]);
});

test("le Stories diventano operazioni separate a un minuto di distanza", () => {
  const parsed = parseNotionPage(pageFixture({ Formato: { type: "select", select: { name: "Stories" } } }));
  const jobs = buildJobs(parsed);
  assert.equal(jobs.length, 2);
  assert.equal(Date.parse(jobs[1].dueAt) - Date.parse(jobs[0].dueAt), 60_000);
  assert.equal(jobs[0].caption, "");
});

test("un Reel richiede un MP4 e genera un video Buffer", () => {
  const parsed = parseNotionPage(pageFixture({
    Formato: { type: "select", select: { name: "Reel" } },
    "URL media pubblici": richText("https://example.com/reel.mp4"),
  }));
  const [job] = buildJobs(parsed);
  const input = buildBufferInput(job, "channel-id");
  assert.equal(input.metadata.instagram.type, "reel");
  assert.equal(input.assets[0].video.url, "https://example.com/reel.mp4");
});

test("una riga approvata senza ID viene creata una sola volta", () => {
  const parsed = parseNotionPage(pageFixture());
  assert.equal(decideAction(parsed), "create");
  assert.equal(decideAction(parsed, { bufferIds: ["state-id"] }), "reconcile");
});

test("gli URL pubblici mancanti preparano i file senza chiamare Buffer", () => {
  const parsed = parseNotionPage(pageFixture({
    "URL media pubblici": richText(""),
    Media: {
      type: "files",
      files: [{ name: "slide.png", type: "external", external: { url: "https://example.com/slide.png" } }],
    },
  }));
  assert.equal(decideAction(parsed), "prepare-media");
});

test("lo stato transitorio sending resta gestibile senza falso errore", () => {
  assert.equal(isManageableBufferStatus("sending"), true);
  assert.equal(deriveEntryStatus(["sending"]), "scheduled");
  assert.equal(deriveEntryStatus(["sent"]), "published");
});

test("la riconciliazione non dipende dalla disponibilita temporanea dei media", () => {
  assert.equal(requiresMediaCheck("create"), true);
  assert.equal(requiresMediaCheck("reconcile"), false);
});

test("una nuova pubblicazione resta differita oltre l'orizzonte Buffer", () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  assert.equal(shouldDeferCreation("2026-09-09T16:30:00.000Z", now, 10), true);
  assert.equal(shouldDeferCreation("2026-08-30T16:30:00.000Z", now, 10), false);
  assert.equal(shouldDeferCreation("data-non-valida", now, 10), false);
});

test("la baseline dei 14 ID Buffer resta preservata senza duplicati", async () => {
  const notionState = JSON.parse(await readFile(new URL("./notion-sync-state.json", import.meta.url), "utf8"));
  const bufferState = JSON.parse(await readFile(new URL("./buffer-state.json", import.meta.url), "utf8"));
  const notionIds = Object.values(notionState.pages).flatMap((entry) => entry.bufferIds).sort();
  const bufferIds = Object.values(bufferState.posts).map((entry) => entry.postId).sort();
  assert.equal(bufferIds.length, 14);
  assert.equal(new Set(notionIds).size, notionIds.length);
  assert.ok(bufferIds.every((postId) => notionIds.includes(postId)));
});
