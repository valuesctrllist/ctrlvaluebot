const { Client, GatewayIntentBits } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const HATCH_CHANNEL_ID = process.env.HATCH_CHANNEL_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // format: owner/repo

const STARTUP_CATCHUP_ENABLED = true;
const STARTUP_CATCHUP_LIMIT = 1000;

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

function splitRepo(repo) {
  const [owner, name] = repo.split("/");
  return { owner, name };
}

async function githubRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
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

async function loadFileFromGitHub(path) {
  const { owner, name } = splitRepo(GITHUB_REPO);
  const url = `https://api.github.com/repos/${owner}/${name}/contents/${path}`;
  const data = await githubRequest(url);

  const decoded = Buffer.from(data.content, "base64").toString("utf8");
  return {
    content: decoded,
    sha: data.sha
  };
}

async function saveFileToGitHub(path, content, sha, message) {
  const { owner, name } = splitRepo(GITHUB_REPO);
  const url = `https://api.github.com/repos/${owner}/${name}/contents/${path}`;

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
  const petsFile = await loadFileFromGitHub(PETS_FILE_PATH);
  petsData = JSON.parse(petsFile.content || "{}");
  petsSha = petsFile.sha;

  const processedFile = await loadFileFromGitHub(PROCESSED_FILE_PATH);
  processedMessagesData = JSON.parse(processedFile.content || "[]");
  processedSha = processedFile.sha;

  processedMessageIds.clear();
  for (const id of processedMessagesData) {
    processedMessageIds.add(id);
  }

  console.log("Loaded pets.json and processedMessages.json from GitHub");
}

async function saveRemoteData(reason = "Update hatch tracker data") {
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
    const removed = processedMessagesData.splice(0, processedMessagesData.length - 5000);
    for (const id of removed) {
      processedMessageIds.delete(id);
    }
    for (const id of processedMessagesData) {
      processedMessageIds.add(id);
    }
  }
}

function processHatchMessage(message, data, source = "LIVE") {
  if (processedMessageIds.has(message.id)) return false;

  const text = buildMessageText(message);
  const lower = text.toLowerCase();

  if (lower.includes("secret")) return false;
  if (!lower.includes("huge") && !lower.includes("giant")) return false;

  const match = text.match(/just (got|hatched) a (.+?)!/i);
  if (!match) return false;

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

  console.log(`[${source}] SAVED → ${pet} (#${serial ?? "?"})`);
  return true;
}

async function runStartupCatchup(client) {
  if (!STARTUP_CATCHUP_ENABLED) return;

  const channel = await client.channels.fetch(HATCH_CHANNEL_ID);
  let before;
  let remaining = STARTUP_CATCHUP_LIMIT;
  let changed = false;

  while (remaining > 0) {
    const messages = await channel.messages.fetch({
      limit: Math.min(100, remaining),
      before
    });

    if (!messages.size) break;

    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const m of sorted) {
      if (processHatchMessage(m, petsData, "CATCHUP")) {
        changed = true;
      }
      remaining--;
    }

    before = messages.last().id;
  }

  if (changed) {
    await saveRemoteData("Startup catch-up");
  }

  console.log("Startup catch-up finished");
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

client.login(DISCORD_TOKEN);
