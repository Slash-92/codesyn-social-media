import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const API_URL = "https://api.buffer.com";
const scriptDir = import.meta.dirname;
const defaultBatchPath = path.join(scriptDir, "batch.json");
const localBatchPath = path.join(
  scriptDir,
  "batch-2026-08-24--2026-09-06.json",
);
const statePath = process.env.BUFFER_STATE_PATH
  ? path.resolve(process.env.BUFFER_STATE_PATH)
  : path.join(scriptDir, "buffer-state.json");

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

async function resolveBatchPath() {
  if (process.env.BATCH_PATH) return path.resolve(process.env.BATCH_PATH);
  try {
    await readFile(defaultBatchPath);
    return defaultBatchPath;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return localBatchPath;
  }
}

export function buildCreateInput(job, { channelId, baseUrl }) {
  const isStory = job.type === "story";
  const isFeed = job.type === "feed" || job.type === "carousel";
  if (!isStory && !isFeed) throw new Error(`Tipo non supportato: ${job.type}`);

  return {
    text: job.caption ?? "",
    channelId,
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt: job.dueAt,
    saveToDraft: true,
    needsApproval: false,
    aiAssisted: false,
    source: "codesyn-instagram-batch",
    assets: job.media.map((fileName) => ({
      image: { url: `${baseUrl}/${encodeURIComponent(fileName)}` },
    })),
    metadata: {
      instagram: {
        type: isStory ? "story" : "post",
        shouldShareToFeed: isFeed,
        isAiGenerated: false,
      },
    },
  };
}

export function buildScheduleInput(postId, job) {
  return {
    id: postId,
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt: job.dueAt,
    saveToDraft: false,
  };
}

async function bufferRequest(query, variables, apiKey) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Buffer HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(`Buffer GraphQL: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  return payload.data;
}

const CREATE_MUTATION = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      __typename
      ... on PostActionSuccess {
        post { id status dueAt }
      }
      ... on MutationError { message }
    }
  }
`;

const EDIT_MUTATION = `
  mutation EditPost($input: EditPostInput!) {
    editPost(input: $input) {
      __typename
      ... on PostActionSuccess {
        post { id status dueAt }
      }
      ... on MutationError { message }
    }
  }
`;

function mutationPost(result, operation) {
  if (result.__typename === "PostActionSuccess") return result.post;
  throw new Error(`${operation}: ${result.message ?? result.__typename}`);
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function checkPublicMedia(batch, baseUrl) {
  const urls = batch.jobs.flatMap((job) =>
    job.media.map((file) => `${baseUrl}/${encodeURIComponent(file)}`),
  );
  const failures = [];

  for (const url of urls) {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!response.ok) failures.push({ url, status: response.status });
  }

  if (failures.length) {
    throw new Error(`Media pubblici non raggiungibili: ${JSON.stringify(failures)}`);
  }
}

async function main() {
  const batch = await readJson(await resolveBatchPath());
  const baseUrl = (process.env.PUBLIC_MEDIA_BASE_URL || batch.publicMediaBaseUrl || "")
    .replace(/\/$/, "");
  const channelId = process.env.BUFFER_CHANNEL_ID || "BUFFER_CHANNEL_ID";
  const dryRun = hasFlag("--dry-run");

  if (!baseUrl.startsWith("https://") || baseUrl.includes("GITHUB-")) {
    throw new Error("Configurare un PUBLIC_MEDIA_BASE_URL HTTPS reale.");
  }

  const plan = batch.jobs.map((job) => ({
    jobId: job.id,
    type: job.type,
    dueAt: job.dueAt,
    media: job.media.length,
    input: buildCreateInput(job, { channelId, baseUrl }),
  }));

  if (dryRun) {
    console.log(JSON.stringify({ mode: "dry-run", jobs: plan }, null, 2));
    return;
  }

  if (hasFlag("--check-media")) {
    await checkPublicMedia(batch, baseUrl);
    console.log(
      JSON.stringify(
        {
          mode: "check-media",
          urls: batch.jobs.reduce((total, job) => total + job.media.length, 0),
          reachable: true,
        },
        null,
        2,
      ),
    );
    return;
  }

  const apiKey = process.env.BUFFER_API_KEY;
  if (!apiKey) throw new Error("BUFFER_API_KEY non configurata.");
  if (!process.env.BUFFER_CHANNEL_ID) {
    throw new Error("BUFFER_CHANNEL_ID non configurato.");
  }

  await checkPublicMedia(batch, baseUrl);

  const state = await readJson(statePath, {
    schemaVersion: 1,
    batch: batch.jobs.map((job) => job.id),
    posts: {},
  });

  for (const job of batch.jobs) {
    if (state.posts[job.id]?.postId) continue;
    const input = buildCreateInput(job, {
      channelId: process.env.BUFFER_CHANNEL_ID,
      baseUrl,
    });
    const data = await bufferRequest(CREATE_MUTATION, { input }, apiKey);
    const post = mutationPost(data.createPost, `Creazione bozza ${job.id}`);
    state.posts[job.id] = {
      postId: post.id,
      status: "draft",
      dueAt: job.dueAt,
    };
    await saveState(state);
    console.log(`Bozza creata: ${job.id} -> ${post.id}`);
  }

  for (const job of batch.jobs) {
    const entry = state.posts[job.id];
    if (!entry || entry.status === "scheduled") continue;
    if (Date.parse(job.dueAt) <= Date.now()) {
      entry.status = "expired";
      entry.error = "Data di pubblicazione già trascorsa";
      await saveState(state);
      console.warn(`Saltato ${job.id}: data già trascorsa.`);
      continue;
    }

    try {
      const input = buildScheduleInput(entry.postId, job);
      const data = await bufferRequest(EDIT_MUTATION, { input }, apiKey);
      const post = mutationPost(data.editPost, `Programmazione ${job.id}`);
      entry.status = "scheduled";
      entry.bufferStatus = post.status;
      delete entry.error;
      await saveState(state);
      console.log(`Programmato: ${job.id} alle ${job.dueAt}`);
    } catch (error) {
      entry.error = error.message;
      await saveState(state);
      console.warn(`Coda Buffer piena o pubblicazione rifiutata: ${error.message}`);
      break;
    }
  }

  const summary = Object.values(state.posts).reduce((acc, post) => {
    acc[post.status] = (acc[post.status] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ statePath, summary }, null, 2));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
