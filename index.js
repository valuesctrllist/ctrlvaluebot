const http = require("http");
const { Client, GatewayIntentBits } = require("discord.js");

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is running");
}).listen(process.env.PORT || 3000);

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const HATCH_CHANNEL_ID = process.env.HATCH_CHANNEL_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // owner/repo

const STARTUP_CATCHUP_ENABLED = true;
const STARTUP_CATCHUP_LIMIT = 1000;

// turn this on only when you want a one-time large rebuild
const FULL_BACKFILL_MODE = true;
const FULL_BACKFILL_LIMIT = 50000;
const BACKFILL_SAVE_EVERY = 250;

const PETS_FILE_PATH = "pets.json";
const PROCESSED_FILE_PATH = "processedMessages.json";

const MUTATIONS = [
  "Rainy",
  "Moonlit",
  "Frozen",
  "Electrified",
  "Lovely",
  "Starstruck",
  "Eclipsed",
  "Taco",
  "Godlike"
];

const VARIANTS = [
  "Golden",
  "Rainbow",
  "Shiny",
  "Super Shiny"
];

const processedMessageIds = new Set();

let petsData = {};
let processedMessagesData = [];
let petsSha = null;
let processedSha = null;

console.log("Starting bot...");
console.log("Has DISCORD_TOKEN:", !!DISCORD_TOKEN);
console.log("Has HATCH_CHANNEL_ID:", !!HATCH_CHANNEL_ID);
console.log("Has GITHUB_TOKEN:", !!GITHUB_TOKEN);
console.log("GITHUB_REPO:", GITHUB_REPO);

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!HATCH_CHANNEL_ID) throw new Error("Missing HATCH_CHANNEL_ID");
if (!GITHUB_TOKEN) throw new Error("Missing GITHUB_TOKEN");
if (!GITHUB_REPO) throw new Error("Missing GITHUB_REPO");

function splitRepo(repo) {
  const [owner, name] = repo.split("/");
  return { owner, name };
}

async function githubRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }

  return res.json();
}

async function loadFileFromGitHub(filePath) {
  const { owner, name } = splitRepo(GITHUB_REPO);

  const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/main/${filePath}`;
  const rawRes = await fetch(rawUrl);

  if (!rawRes.ok) {
    const text = await rawRes.text();
    throw new Error(`Raw GitHub read failed ${rawRes.status}: ${text}`);
  }

  const content = await rawRes.text();

  const apiUrl = `https://api.github.com/repos/${owner}/${name}/contents/${filePath}`;
  const meta = await githubRequest(apiUrl);

  return {
    content,
    sha: meta.sha
  };
}

async function saveFileToGitHub(filePath, content, sha, message) {
  const { owner, name } = splitRepo(GITHUB_REPO);
  const url = `https://api.github.com/repos/${owner}/${name}/contents/${filePath}`;

  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    sha
  };

  const result = await githubRequest(url, {
    method: "PUT",
    body: JSON.stringify(body)
  });

  return result.content.sha;
}

async function loadRemoteData() {
  console.log("Loading data from GitHub...");

  try {
    const petsFile = await loadFileFromGitHub(PETS_FILE_PATH);
    petsData = JSON.parse(petsFile.content || "{}");
    petsSha = petsFile.sha;
    console.log("Loaded pets.json");
  } catch (err) {
    console.error("Failed loading pets.json:");
    console.error(err);
    petsData = {};
  }

  try {
    const processedFile = await loadFileFromGitHub(PROCESSED_FILE_PATH);
    processedMessagesData = JSON.parse(processedFile.content || "[]");
    processedSha = processedFile.sha;
    console.log("Loaded processedMessages.json");
  } catch (err) {
    console.error("Failed loading processedMessages.json:");
    console.error(err);
    processedMessagesData = [];
  }

  processedMessageIds.clear();
  for (const id of processedMessagesData) {
    processedMessageIds.add(id);
  }

  console.log("Finished loading remote data");
}

async function saveRemoteData(reason = "Update hatch tracker data") {
  try {
    petsSha = await saveFileToGitHub(
      PETS_FILE_PATH,
      JSON.stringify(petsData, null, 2),
      petsSha,
      `${reason} - pets`
    );

    processedSha = await saveFileToGitHub(
      PROCESSED_FILE_PATH,
      JSON.stringify(processedMessagesData, null, 2),
      processedSha,
      `${reason} - processed messages`
    );

    console.log("Saved data back to GitHub");
  } catch (err) {
    console.error("FAILED SAVING TO GITHUB:");
    console.error(err);
  }
}

function ensurePet(data, name, type) {
  if (!data[name]) {
    data[name] = {
      type,
      exists: 0,
      normal: 0,
      mutations: {},
      variants: {},
      combos: {},
      doubleMutations: {},
      doubleVariants: {},
      processedCombos: []
    };
  }

  if (typeof data[name].normal !== "number") data[name].normal = 0;
  if (!data[name].mutations) data[name].mutations = {};
  if (!data[name].variants) data[name].variants = {};
  if (!data[name].combos) data[name].combos = {};
  if (!data[name].doubleMutations) data[name].doubleMutations = {};
  if (!data[name].doubleVariants) data[name].doubleVariants = {};
  if (!data[name].processedCombos) data[name].processedCombos = [];
}

function increment(obj, key) {
  if (!obj[key]) obj[key] = 0;
  obj[key]++;
}

function extractSerial(text) {
  const m = text.match(/Serial:\s*#(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function splitPrefixWords(prefix) {
  if (!prefix) return [];

  const words = prefix.trim().split(/\s+/);
  const result = [];

  for (let i = 0; i < words.length; i++) {
    if (words[i] === "Super" && words[i + 1] === "Shiny") {
      result.push("Super Shiny");
      i++;
    } else {
      result.push(words[i]);
    }
  }

  return result;
}

function normalizeCombo(muts, vars, serial) {
  const m = [...muts].sort().join("|") || "None";
  const v = [...vars].sort().join("|") || "None";
  return `${m}_${v}_${serial}`;
}

function buildMessageText(message) {
  let text = message.content || "";

  if (message.embeds?.length) {
    const e = message.embeds[0];
    text += "\n" + (e.title || "");
    text += "\n" + (e.description || "");

    if (e.fields) {
      for (const f of e.fields) {
        text += `\n${f.name}: ${f.value}`;
      }
    }
  }

  return text;
}

function markMessageProcessed(messageId) {
  if (processedMessageIds.has(messageId)) return;

  processedMessageIds.add(messageId);
  processedMessagesData.push(messageId);

  if (processedMessagesData.length > 5000) {
    const removed = processedMessagesData.splice(
      0,
      processedMessagesData.length - 5000
    );

    for (const id of removed) {
      processedMessageIds.delete(id);
    }

    for (const id of processedMessagesData) {
      processedMessageIds.add(id);
    }
  }
}

function processHatchMessage(message, data, source = "LIVE") {
  if (processedMessageIds.has(message.id)) {
    return false;
  }

  const text = buildMessageText(message);
  const lower = text.toLowerCase();

  if (lower.includes("secret")) {
    console.log(`[${source}] IGNORED SECRET`);
    return false;
  }

  if (!lower.includes("huge") && !lower.includes("giant")) {
    return false;
  }

  const match = text.match(/just (got|hatched) a (.+?)!/i);
  if (!match) {
    return false;
  }

  const drop = match[2].trim();

  let petIndex = -1;
  let petType = null;

  if (drop.includes("Huge")) {
    petIndex = drop.indexOf("Huge");
    petType = "Huge";
  } else if (drop.includes("Giant")) {
    petIndex = drop.indexOf("Giant");
    petType = "Giant";
  } else {
    return false;
  }

  const before = drop.slice(0, petIndex).trim();
  const pet = drop.slice(petIndex).trim();
  const serial = extractSerial(text);
  const words = splitPrefixWords(before);

  const foundMutations = [];
  const foundVariants = [];

  for (const w of words) {
    if (MUTATIONS.includes(w)) foundMutations.push(w);
    if (VARIANTS.includes(w)) foundVariants.push(w);
  }

  if (foundMutations.length >= 3) return false;
  if (foundVariants.length >= 3) return false;
  if (foundMutations.length >= 2 && foundVariants.length >= 1) return false;
  if (foundVariants.length >= 2 && foundMutations.length >= 1) return false;

  ensurePet(data, pet, petType);

  if (serial && serial > data[pet].exists) {
    data[pet].exists = serial;
  }

  const comboKey = normalizeCombo(foundMutations, foundVariants, serial);
  if (data[pet].processedCombos.includes(comboKey)) {
    markMessageProcessed(message.id);
    return false;
  }

  data[pet].processedCombos.push(comboKey);

  if (data[pet].processedCombos.length > 3000) {
    data[pet].processedCombos = data[pet].processedCombos.slice(-3000);
  }

  if (foundMutations.length === 0 && foundVariants.length === 0) {
    data[pet].normal++;
  } else if (foundMutations.length === 1 && foundVariants.length === 0) {
    increment(data[pet].mutations, foundMutations[0]);
  } else if (foundMutations.length === 0 && foundVariants.length === 1) {
    increment(data[pet].variants, foundVariants[0]);
  } else if (foundMutations.length === 1 && foundVariants.length === 1) {
    increment(data[pet].combos, `${foundMutations[0]} + ${foundVariants[0]}`);
  } else if (foundMutations.length === 2) {
    increment(data[pet].doubleMutations, foundMutations.sort().join(" + "));
  } else if (foundVariants.length === 2) {
    increment(data[pet].doubleVariants, foundVariants.sort().join(" + "));
  }

  markMessageProcessed(message.id);

  console.log(`[${source}] SAVED -> ${pet} (#${serial ?? "?"})`);
  return true;
}

async function scanMessages(client, limit, sourceLabel, saveEvery = 0) {
  const channel = await client.channels.fetch(HATCH_CHANNEL_ID);
  let before;
  let remaining = limit;
  let changed = false;
  let scanned = 0;
  let savedCount = 0;

  while (remaining > 0) {
    const messages = await channel.messages.fetch({
      limit: Math.min(100, remaining),
      before
    });

    if (!messages.size) break;

    const sorted = [...messages.values()].sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    for (const m of sorted) {
      const didChange = processHatchMessage(m, petsData, sourceLabel);
      if (didChange) {
        changed = true;
        savedCount++;
      }

      scanned++;
      remaining--;

      if (saveEvery > 0 && scanned % saveEvery === 0 && changed) {
        console.log(`[${sourceLabel}] Saving progress at ${scanned} scanned...`);
        await saveRemoteData(`${sourceLabel} progress`);
        changed = false;
      }
    }

    before = messages.last().id;
  }

  return { scanned, savedCount, changed };
}

async function runStartupCatchup(client) {
  if (!STARTUP_CATCHUP_ENABLED) return;

  console.log(`Running startup catch-up for last ${STARTUP_CATCHUP_LIMIT} messages...`);

  const result = await scanMessages(client, STARTUP_CATCHUP_LIMIT, "CATCHUP");

  if (result.changed) {
    console.log("Saving rebuilt data to GitHub...");
    await saveRemoteData("Startup catch-up rebuild");
  }

  console.log(`Startup catch-up finished. Scanned ${result.scanned}, saved ${result.savedCount}`);
}

async function runFullBackfill(client) {
  if (!FULL_BACKFILL_MODE) return;

  console.log(`Running FULL BACKFILL for up to ${FULL_BACKFILL_LIMIT} messages...`);

  const result = await scanMessages(
    client,
    FULL_BACKFILL_LIMIT,
    "FULLBACKFILL",
    BACKFILL_SAVE_EVERY
  );

  if (result.changed) {
    console.log("Saving final full backfill data to GitHub...");
    await saveRemoteData("Full backfill rebuild");
  }

  console.log(`Full backfill finished. Scanned ${result.scanned}, saved ${result.savedCount}`);
  console.log("IMPORTANT: set FULL_BACKFILL_MODE back to false after this one-time rebuild.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", async () => {
  console.log(`Bot online as ${client.user.tag}`);
  await loadRemoteData();
  await runStartupCatchup(client);
  await runFullBackfill(client);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.channel.id !== HATCH_CHANNEL_ID) return;
    if (message.author.id === client.user.id) return;

    const changed = processHatchMessage(message, petsData, "LIVE");
    if (changed) {
      await saveRemoteData("Live hatch update");
    }
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

client.on("error", (err) => {
  console.error("CLIENT ERROR:", err);
});

client.on("warn", (msg) => {
  console.warn("CLIENT WARN:", msg);
});

client.on("shardError", (err) => {
  console.error("SHARD ERROR:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

console.log("Attempting Discord login...");

client.login(DISCORD_TOKEN)
  .then(() => {
    console.log("Discord login promise resolved");
  })
  .catch((err) => {
    console.error("DISCORD LOGIN FAILED:");
    console.error(err);
  });
