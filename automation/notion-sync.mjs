import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const BUFFER_API = "https://api.buffer.com";
const DEFAULT_DATA_SOURCE_ID = "2be25de9-18d7-4f0f-a219-858427536a21";
const DEFAULT_MEDIA_BASE = "https://slash-92.github.io/codesyn-social-media/media";
const DEFAULT_SCHEDULE_HORIZON_DAYS = 10;
const MANAGEABLE_BUFFER_STATUSES = new Set(["sent", "published", "scheduled", "buffer", "sending"]);
const scriptDir = import.meta.dirname;
const repoRoot = path.resolve(scriptDir, "..");
const statePath = process.env.NOTION_SYNC_STATE_PATH
  ? path.resolve(process.env.NOTION_SYNC_STATE_PATH)
  : path.join(scriptDir, "notion-sync-state.json");

export function isManageableBufferStatus(status) {
  return MANAGEABLE_BUFFER_STATUSES.has(status);
}

export function deriveEntryStatus(statuses) {
  return statuses.every((status) => ["sent", "published"].includes(status)) ? "published" : "scheduled";
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function richTextValue(property) {
  return (property?.rich_text ?? []).map((item) => item.plain_text ?? "").join("");
}

function titleValue(property) {
  return (property?.title ?? []).map((item) => item.plain_text ?? "").join("");
}

function splitLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function sanitizeSegment(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function propertyFile(file, index) {
  const url = file.type === "external" ? file.external?.url : file.file?.url;
  if (!url) return null;
  const rawName = file.name || `asset-${index + 1}`;
  const extension = path.extname(new URL(url).pathname) || path.extname(rawName);
  const stem = path.basename(rawName, path.extname(rawName));
  const safeStem = sanitizeSegment(stem) || `asset-${index + 1}`;
  return { name: `${String(index + 1).padStart(2, "0")}-${safeStem}${extension.toLowerCase()}`, url };
}

export function parseNotionPage(page) {
  const properties = page.properties ?? {};
  return {
    id: page.id,
    url: page.url,
    title: titleValue(properties.Contenuto),
    brand: properties.Brand?.select?.name ?? "",
    status: properties.Stato?.select?.name ?? "",
    ready: properties["Pronto per pubblicazione"]?.checkbox === true,
    format: properties.Formato?.select?.name ?? "",
    caption: richTextValue(properties.Caption),
    dueAt: properties["Data pubblicazione"]?.date?.start ?? "",
    key: richTextValue(properties["Chiave automazione"]) || page.id.replaceAll("-", ""),
    bufferIds: splitLines(richTextValue(properties["Buffer IDs"])),
    publicUrls: splitLines(richTextValue(properties["URL media pubblici"])),
    mediaFiles: (properties.Media?.files ?? []).map(propertyFile).filter(Boolean),
  };
}

function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function isVideo(url) {
  return /\.(mp4|mov|m4v)(?:$|\?)/i.test(url);
}

export function buildJobs(page) {
  if (!page.dueAt || Number.isNaN(Date.parse(page.dueAt))) throw new Error(`${page.title}: Data pubblicazione mancante o non valida`);
  if (!page.publicUrls.length) throw new Error(`${page.title}: nessun URL media pubblico`);
  if (page.format === "Stories") {
    return page.publicUrls.map((url, index) => ({ type: "story", dueAt: addMinutes(page.dueAt, index), caption: "", urls: [url] }));
  }
  if (page.format === "Feed singolo") {
    if (page.publicUrls.length !== 1) throw new Error(`${page.title}: il feed singolo richiede un asset`);
    return [{ type: "post", dueAt: new Date(page.dueAt).toISOString(), caption: page.caption, urls: page.publicUrls }];
  }
  if (page.format === "Carosello") {
    if (page.publicUrls.length < 2 || page.publicUrls.length > 10) throw new Error(`${page.title}: il carosello richiede da 2 a 10 asset`);
    return [{ type: "post", dueAt: new Date(page.dueAt).toISOString(), caption: page.caption, urls: page.publicUrls }];
  }
  if (page.format === "Reel") {
    if (page.publicUrls.length !== 1 || !isVideo(page.publicUrls[0])) throw new Error(`${page.title}: il Reel richiede un solo file video`);
    return [{ type: "reel", dueAt: new Date(page.dueAt).toISOString(), caption: page.caption, urls: page.publicUrls }];
  }
  throw new Error(`${page.title}: formato non supportato (${page.format || "vuoto"})`);
}

export function buildBufferInput(job, channelId, saveToDraft = true) {
  return {
    text: job.caption ?? "",
    channelId,
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt: job.dueAt,
    saveToDraft,
    needsApproval: false,
    aiAssisted: false,
    source: "codesyn-notion-sync",
    assets: job.urls.map((url) => (isVideo(url) ? { video: { url } } : { image: { url } })),
    metadata: { instagram: { type: job.type, shouldShareToFeed: job.type !== "story", isAiGenerated: false } },
  };
}

export function decideAction(page, stateEntry = {}) {
  const ids = page.bufferIds.length ? page.bufferIds : stateEntry.bufferIds ?? [];
  if (ids.length) return "reconcile";
  if (!page.publicUrls.length && page.mediaFiles.length) return "prepare-media";
  if (!page.publicUrls.length) return "missing-media";
  if (page.status === "Approvato" && page.ready) return "create";
  return "ignore";
}

export function requiresMediaCheck(action) {
  return action === "create";
}

export function isEligibleSyncPage(page) {
  return page.ready && ["Approvato", "Programmato", "Errore automazione"].includes(page.status);
}

export function shouldDeferCreation(dueAt, now = new Date(), horizonDays = DEFAULT_SCHEDULE_HORIZON_DAYS) {
  const dueTime = Date.parse(dueAt);
  if (Number.isNaN(dueTime)) return false;
  return dueTime - now.getTime() > horizonDays * 86_400_000;
}

async function notionRequest(endpoint, { method = "GET", body } = {}) {
  const token = process.env.NOTION_API_TOKEN;
  if (!token) throw new Error("NOTION_API_TOKEN non configurato");
  const response = await fetch(`${NOTION_API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Notion HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function queryNotionPages() {
  const dataSourceId = process.env.NOTION_DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID;
  const pages = [];
  let cursor;
  do {
    const payload = await notionRequest(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    pages.push(...payload.results);
    cursor = payload.has_more ? payload.next_cursor : null;
  } while (cursor);
  return pages.map(parseNotionPage).filter((page) => page.brand === "Codesyn");
}

function textProperty(value) {
  return { rich_text: value ? [{ type: "text", text: { content: value } }] : [] };
}

async function updateNotion(pageId, changes) {
  const properties = {};
  if ("bufferIds" in changes) properties["Buffer IDs"] = textProperty(changes.bufferIds.join("\n"));
  if ("publicUrls" in changes) properties["URL media pubblici"] = textProperty(changes.publicUrls.join("\n"));
  if ("status" in changes) properties.Stato = { select: { name: changes.status } };
  if ("publishedUrl" in changes) properties["Link pubblicato"] = { url: changes.publishedUrl || null };
  if ("error" in changes) properties["Errore automazione"] = textProperty(changes.error ?? "");
  if ("syncedAt" in changes) properties["Ultima sincronizzazione"] = { date: { start: changes.syncedAt } };
  await notionRequest(`/pages/${pageId}`, { method: "PATCH", body: { properties } });
}

async function bufferRequest(query, variables) {
  const apiKey = process.env.BUFFER_API_KEY;
  if (!apiKey) throw new Error("BUFFER_API_KEY non configurata");
  const response = await fetch(BUFFER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const message = `Buffer HTTP ${response.status}: ${await response.text()}`;
    const error = new Error(message);
    if (response.status === 429) error.code = "BUFFER_RATE_LIMIT";
    throw error;
  }
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(`Buffer GraphQL: ${payload.errors.map((error) => error.message).join("; ")}`);
  return payload.data;
}

const CREATE_POST = `mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id status dueAt } } ... on MutationError { message } } }`;
const EDIT_POST = `mutation EditPost($input: EditPostInput!) { editPost(input: $input) { __typename ... on PostActionSuccess { post { id status dueAt } } ... on MutationError { message } } }`;
const GET_POST = `query GetPost($input: PostInput!) { post(input: $input) { id status dueAt sentAt externalLink } }`;

function actionPost(payload, operation) {
  if (payload.__typename === "PostActionSuccess") return payload.post;
  throw new Error(`${operation}: ${payload.message ?? payload.__typename}`);
}

async function checkMedia(urls) {
  for (const url of urls) {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!response.ok) throw new Error(`Media non raggiungibile (${response.status}): ${url}`);
  }
}

async function prepareMedia(page) {
  const baseUrl = (process.env.PUBLIC_MEDIA_BASE_URL || DEFAULT_MEDIA_BASE).replace(/\/$/, "");
  const safeKey = sanitizeSegment(page.key) || page.id.replaceAll("-", "");
  const targetDir = path.join(repoRoot, "media", "notion", safeKey);
  await mkdir(targetDir, { recursive: true });
  const publicUrls = [];
  for (const file of page.mediaFiles) {
    const response = await fetch(file.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Download asset fallito (${response.status}): ${file.name}`);
    await writeFile(path.join(targetDir, file.name), new Uint8Array(await response.arrayBuffer()));
    publicUrls.push(`${baseUrl}/notion/${encodeURIComponent(safeKey)}/${encodeURIComponent(file.name)}`);
  }
  await updateNotion(page.id, { publicUrls, error: "", syncedAt: new Date().toISOString() });
}

async function createAndSchedule(page, jobs, state) {
  const channelId = process.env.BUFFER_CHANNEL_ID;
  if (!channelId) throw new Error("BUFFER_CHANNEL_ID non configurato");
  const entry = state.pages[page.id] ?? { key: page.key, bufferIds: [], jobs: {} };
  state.pages[page.id] = entry;
  const ids = page.bufferIds.length ? [...page.bufferIds] : [...(entry.bufferIds ?? [])];
  for (let index = ids.length; index < jobs.length; index += 1) {
    const data = await bufferRequest(CREATE_POST, { input: buildBufferInput(jobs[index], channelId, true) });
    const post = actionPost(data.createPost, `Creazione bozza ${page.key}/${index + 1}`);
    ids.push(post.id);
    entry.bufferIds = ids;
    entry.jobs[index] = { postId: post.id, status: "draft", dueAt: jobs[index].dueAt };
    await saveState(state);
    await updateNotion(page.id, { bufferIds: ids, syncedAt: new Date().toISOString() });
  }
  for (let index = 0; index < jobs.length; index += 1) {
    const postId = ids[index];
    const current = await bufferRequest(GET_POST, { input: { id: postId } });
    if (isManageableBufferStatus(current.post.status)) {
      entry.jobs[index] = { postId, status: current.post.status, dueAt: current.post.dueAt ?? jobs[index].dueAt };
      continue;
    }
    const draftInput = buildBufferInput(jobs[index], channelId, false);
    const { channelId: _channelId, needsApproval: _needsApproval, ...editable } = draftInput;
    const data = await bufferRequest(EDIT_POST, { input: { ...editable, id: postId } });
    const post = actionPost(data.editPost, `Programmazione ${page.key}/${index + 1}`);
    entry.jobs[index] = { postId, status: post.status, dueAt: post.dueAt };
    await saveState(state);
  }
  entry.bufferIds = ids;
  entry.status = "scheduled";
  await saveState(state);
  await updateNotion(page.id, { bufferIds: ids, status: "Programmato", error: "", syncedAt: new Date().toISOString() });
}

async function reconcile(page, jobs, state) {
  const entry = state.pages[page.id] ?? { key: page.key, bufferIds: page.bufferIds, jobs: {} };
  state.pages[page.id] = entry;
  const ids = page.bufferIds.length ? page.bufferIds : entry.bufferIds ?? [];
  if (ids.length !== jobs.length) throw new Error(`${page.title}: ${ids.length} ID Buffer per ${jobs.length} operazioni previste`);
  const statuses = [];
  const publishedUrls = [];
  for (let index = 0; index < ids.length; index += 1) {
    const data = await bufferRequest(GET_POST, { input: { id: ids[index] } });
    let post = data.post;
    if (post.status === "draft") {
      const channelId = process.env.BUFFER_CHANNEL_ID;
      if (!channelId) throw new Error("BUFFER_CHANNEL_ID non configurato");
      const draftInput = buildBufferInput(jobs[index], channelId, false);
      const { channelId: _channelId, needsApproval: _needsApproval, ...editable } = draftInput;
      const scheduled = await bufferRequest(EDIT_POST, { input: { ...editable, id: ids[index] } });
      post = actionPost(scheduled.editPost, `Ripresa bozza ${page.key}/${index + 1}`);
    }
    if (!isManageableBufferStatus(post.status)) {
      throw new Error(`${page.title}: stato Buffer non gestibile (${post.status}) per ${post.id}`);
    }
    statuses.push(post.status);
    if (post.externalLink) publishedUrls.push(post.externalLink);
    entry.jobs[index] = { postId: post.id, status: post.status, dueAt: post.dueAt ?? jobs[index].dueAt };
  }
  entry.bufferIds = ids;
  entry.status = deriveEntryStatus(statuses);
  await saveState(state);
  const status = entry.status === "published" ? "Pubblicato" : "Programmato";
  await updateNotion(page.id, {
    ...(page.status !== status ? { status } : {}),
    ...(entry.status === "published" && publishedUrls[0] ? { publishedUrl: publishedUrls[0] } : {}),
    error: "",
    syncedAt: new Date().toISOString(),
  });
}

async function main() {
  if (hasFlag("--validate-config")) {
    console.log(JSON.stringify({ notionDataSourceId: process.env.NOTION_DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID, publicMediaBaseUrl: process.env.PUBLIC_MEDIA_BASE_URL || DEFAULT_MEDIA_BASE }, null, 2));
    return;
  }
  const dryRun = hasFlag("--dry-run");
  const pages = await queryNotionPages();
  const state = await readJson(statePath, { schemaVersion: 1, pages: {} });
  const horizonDays = Number.parseFloat(process.env.BUFFER_SCHEDULE_HORIZON_DAYS || String(DEFAULT_SCHEDULE_HORIZON_DAYS));
  const summary = { total: pages.length, ignored: 0, deferred: 0, preparedMedia: 0, created: 0, reconciled: 0, errors: 0, rateLimited: false };
  for (const page of pages) {
    if (!isEligibleSyncPage(page)) {
      summary.ignored += 1;
      continue;
    }
    const action = decideAction(page, state.pages[page.id]);
    if (action === "create" && shouldDeferCreation(page.dueAt, new Date(), horizonDays)) {
      summary.deferred += 1;
      continue;
    }
    if (dryRun) {
      console.log(JSON.stringify({ page: page.title, key: page.key, action, bufferIds: page.bufferIds }, null, 2));
      continue;
    }
    try {
      if (action === "prepare-media") {
        await prepareMedia(page);
        summary.preparedMedia += 1;
        continue;
      }
      if (action === "missing-media") throw new Error(`${page.title}: allegare i file in Media o compilare URL media pubblici`);
      if (action === "ignore") {
        summary.ignored += 1;
        continue;
      }
      if (requiresMediaCheck(action)) await checkMedia(page.publicUrls);
      const jobs = buildJobs(page);
      if (action === "reconcile") {
        await reconcile(page, jobs, state);
        summary.reconciled += 1;
      } else {
        await createAndSchedule(page, jobs, state);
        summary.created += 1;
      }
    } catch (error) {
      if (error.code === "BUFFER_RATE_LIMIT") {
        summary.rateLimited = true;
        console.warn(`${page.key}: limite Buffer raggiunto; sincronizzazione interrotta e rinviata al prossimo passaggio.`);
        break;
      }
      summary.errors += 1;
      console.error(`${page.key}: ${error.message}`);
      await updateNotion(page.id, { status: "Errore automazione", error: error.message, syncedAt: new Date().toISOString() });
    }
  }
  await saveState(state);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
